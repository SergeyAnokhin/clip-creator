from fastapi import APIRouter, Body, HTTPException

from .. import storage, usage
from ..providers import translate as translate_provider
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api', tags=['translate'])


@router.post('/translate')
async def translate_prompt(body: dict = Body(...)):
    """Project-independent: translates one prompt string to Russian (or
    whatever `target_lang` is passed) for the Scenes/Images stage's
    "translate" button - a preview only, doesn't touch project state, so it
    doesn't live under /api/projects/{id} like the generation routes."""
    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')
    target_lang = body.get('target_lang') or 'ru'

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('google_translate', '')
    usage_ctx = usage.context('translate', None, settings)

    try:
        translated = await translate_provider.translate_text(text, target_lang, api_key, usage_ctx=usage_ctx)
    except Exception as exc:
        raise HTTPException(502, f'Не удалось перевести: {exc}') from exc
    return {'translated': translated}
