"""Colorful, emoji-tagged console logging for outbound AI provider calls -
purely a local-dev visibility aid (which provider/model a request is going
to, what it cost once it lands). Never touches the usage ledger or affects
request behaviour; `usage.record` failing/being skipped never depends on
anything here.

Uses raw ANSI escape codes rather than a coloring library - Windows Terminal,
VS Code's integrated terminal and any POSIX terminal render these natively.
The `os.system('')` call below is the standard trick that makes classic
`conhost.exe` (old cmd.exe) process ANSI too, on Windows 10+.
"""

import json
import os
import sys

if sys.platform == 'win32':
    os.system('')

_RESET = '\033[0m'
_BOLD = '\033[1m'
_CYAN = '\033[36m'
_GREEN = '\033[32m'
_RED = '\033[31m'
_YELLOW = '\033[33m'


def _paint(color: str, text: str) -> str:
    return f'{color}{text}{_RESET}'


def _safe_print(text: str) -> None:
    """This module is a pure dev-visibility aid - a console/encoding quirk
    here must never break the actual provider call it's logging about.
    Windows' legacy console codepages (cp1252/cp866/...) can't encode most
    emoji, which raises UnicodeEncodeError from plain `print()`.

    The fallback writes UTF-8 bytes straight to the stream's underlying
    buffer instead of reconfiguring global stdio (which risks fighting
    uvicorn's own `--reload` subprocess over the same streams) *and* instead
    of re-encoding against `sys.stdout.encoding`: under `npm run dev`
    (`concurrently` piping this process's stdout, prefixing it `[BACKEND]`)
    that encoding is a legacy codepage even though the terminal actually
    displaying the merged output is UTF-8 - re-encoding through it turned
    emoji/Cyrillic into literal '?' and stray '<27>' bytes instead of
    rendering correctly. Writing real UTF-8 bytes matches what the terminal
    (and `concurrently`) actually expects."""
    try:
        print(text)
    except UnicodeEncodeError:
        buffer = getattr(sys.stdout, 'buffer', None)
        try:
            if buffer is not None:
                buffer.write((text + '\n').encode('utf-8', errors='replace'))
                buffer.flush()
            else:
                print(text.encode('ascii', errors='replace').decode('ascii'))
        except Exception:
            pass
    except Exception:
        pass


def log_request_start(model: str, kind: str, task: str | None = None) -> None:
    """Printed right before an outbound HTTP call to a paid provider - never
    for the deterministic stub fallbacks, which make no network call."""
    label = f'[{task}] ' if task else ''
    _safe_print(_paint(_CYAN, f'🚀 {label}→ {model} ({kind})'))


def log_result(rec: dict) -> None:
    """Printed once a provider call's `usage.record()` row has been built -
    mirrors that row exactly, so this can never disagree with the ledger."""
    task = rec.get('task') or ''
    model = rec.get('model') or ''
    duration_s = (rec.get('duration_ms') or 0) / 1000
    label = f'[{task}] ' if task else ''

    if rec.get('status') != 'ok':
        error = (rec.get('error') or '').splitlines()[0][:160]
        _safe_print(_paint(_RED, f'❌ {label}{model} · {error} · ⏱ {duration_s:.1f}s'))
        return

    units = rec.get('units') or {}
    cost = rec.get('cost') or {}
    amount = cost.get('amount')
    is_estimate = amount is not None and cost.get('source') != 'provider'
    cost_text = f"{'≈' if is_estimate else ''}${amount:.4f}" if amount is not None else '$?'

    bits = []
    if units.get('input_tokens') is not None or units.get('output_tokens') is not None:
        bits.append(f"🔤 {units.get('input_tokens') or 0}→{units.get('output_tokens') or 0}")
    if units.get('images'):
        bits.append(f"🖼 {units['images']}")
    bits.append(f'⏱ {duration_s:.1f}s')

    line = f"✅ {label}{model} · {' · '.join(bits)} · "
    _safe_print(_paint(_GREEN, line) + _paint(_BOLD + _YELLOW, f'💰 {cost_text}'))


_DEBUG_STR_LIMIT = 100
_DEBUG_LIST_LIMIT = 20


def _truncate(obj):
    """Recursively shortens a request/response payload for console printing:
    any string over 100 chars is cut with a "+N chars" marker, any list over
    20 items is cut with a "+N items" marker. Large binary payloads (base64
    image data etc.) are expected to already be replaced by short placeholder
    strings (e.g. `<image data, N bytes>`) by the caller before this runs -
    this only guards against merely-long text (prompts, JSON blobs)."""
    if isinstance(obj, str):
        if len(obj) <= _DEBUG_STR_LIMIT:
            return obj
        return f'{obj[:_DEBUG_STR_LIMIT]}…(+{len(obj) - _DEBUG_STR_LIMIT} chars)'
    if isinstance(obj, dict):
        return {k: _truncate(v) for k, v in obj.items()}
    if isinstance(obj, list):
        out = [_truncate(v) for v in obj[:_DEBUG_LIST_LIMIT]]
        if len(obj) > _DEBUG_LIST_LIMIT:
            out.append(f'…(+{len(obj) - _DEBUG_LIST_LIMIT} more items)')
        return out
    return obj


def _print_json(data) -> None:
    try:
        text = json.dumps(_truncate(data), ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        text = str(data)
    for line in text.splitlines():
        _safe_print(f'    {line}')


def log_debug(model: str, kind: str, task: str | None = None, *,
              request: dict | None = None, response: object = None, error: str | None = None) -> None:
    """Prints the full (truncated) request/response JSON for one outbound
    provider call - always, not just on failure, so the console is a
    complete record of what was actually sent/received without re-running
    anything. Every provider function already builds a redacted
    `debug_request`/response (raw image bytes replaced by short placeholders)
    for the in-app debug panels - this just prints that same data instead of
    silently dropping it once a request completes."""
    label = f'[{task}] ' if task else ''
    _safe_print(_paint(_BOLD, f'🧾 {label}{model} ({kind})'))
    if request is not None:
        _safe_print(_paint(_CYAN, '  → request:'))
        _print_json(request)
    if response is not None:
        _safe_print(_paint(_GREEN, '  ← response:'))
        _print_json(response)
    if error is not None:
        _safe_print(_paint(_RED, '  ← error:'))
        _print_json(error)
