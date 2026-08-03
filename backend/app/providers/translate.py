"""Provider seam for prompt translation (Scenes/Images stage's "translate to
Russian" button - a user-facing preview only, never fed back into any prompt
sent to a generation model).

Google Cloud Translation API v2 (Basic) was picked over reusing the
already-configured Gemini/OpenRouter/DeepSeek chat models: it's a dedicated,
key-authenticated REST endpoint (same auth shape as the Gemini calls
elsewhere in this app - a `key` query param, no OAuth/service account), with
a permanently free 500k-characters/month tier and a well-known $20/1M
thereafter (cloud.google.com/translate/pricing, checked 2026-08). It needs
its own `settings.api_keys.google_translate` - a plain Gemini key usually
isn't enabled for Cloud Translation, a separate GCP product/API.
"""

import time

import httpx

from .. import console_log, usage

_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2'
_DEFAULT_TIMEOUT_SECONDS = 30

_MODEL = 'google_translate:v2'


async def translate_text(text: str, target_lang: str, api_key: str, usage_ctx: dict | None = None) -> str:
    text = (text or '').strip()
    if not text:
        return text
    if not api_key:
        raise RuntimeError('Нет API-ключа Google Translate')

    started = time.monotonic()
    console_log.log_request_start(_MODEL, 'translate', usage_ctx.get('task') if usage_ctx else None)
    async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_SECONDS) as http_client:
        resp = await http_client.post(
            _TRANSLATE_URL,
            params={'key': api_key},
            json={'q': text, 'target': target_lang, 'format': 'text'},
        )
    duration_ms = int((time.monotonic() - started) * 1000)
    if resp.status_code != 200:
        usage.record(usage_ctx, model=_MODEL, kind='translate', status='error', duration_ms=duration_ms,
                     prompt=text, error=f'{resp.status_code}: {resp.text[:200]}')
        raise RuntimeError(f'Google Translate API вернул {resp.status_code}: {resp.text[:200]}')

    data = resp.json()
    translations = (data.get('data') or {}).get('translations') or []
    if not translations:
        usage.record(usage_ctx, model=_MODEL, kind='translate', status='error', duration_ms=duration_ms,
                     prompt=text, error=f'unexpected response: {data}')
        raise RuntimeError('Google Translate: неожиданный формат ответа')

    result = translations[0].get('translatedText', '')
    usage.record(usage_ctx, model=_MODEL, kind='translate', status='ok', duration_ms=duration_ms,
                 units={'characters': len(text)}, prompt=text, response=result)
    return result
