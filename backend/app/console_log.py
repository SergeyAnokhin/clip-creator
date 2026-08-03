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
    emoji, which raises UnicodeEncodeError from plain `print()` - re-encode
    against the stream's *actual* encoding first, replacing anything it can't
    show, rather than reconfiguring global stdio (which risks fighting
    uvicorn's own `--reload` subprocess over the same streams)."""
    try:
        print(text)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, 'encoding', None) or 'ascii'
        try:
            print(text.encode(encoding, errors='replace').decode(encoding, errors='replace'))
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
