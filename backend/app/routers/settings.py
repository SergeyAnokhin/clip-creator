from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException

from .. import storage
from ..providers import image_models, text_models
from ..providers.suno_prompt_defaults import DEFAULT_REFERENCE_EXAMPLES, DEFAULT_SUNO_BASE_PROMPT

router = APIRouter(prefix='/api/settings', tags=['settings'])

_MODEL_PROVIDERS = {'google', 'openrouter', 'replicate', 'fal'}
# Krea (krea.ai) only does image/video generation, no text/LLM models, so it's
# valid for the image-models endpoint but not the text one.
_IMAGE_MODEL_PROVIDERS = _MODEL_PROVIDERS | {'krea'}

DEFAULT_SETTINGS = {
    'lang': 'ru',
    'api_keys': {'replicate': '', 'google': '', 'fal': '', 'openrouter': '', 'krea': ''},
    'text_models': {'favorites': [], 'default': 'google:gemini-2.5-flash'},
    'simple_models': {'favorites': [], 'default': ''},
    'image_models': {'favorites': [], 'default': ''},
    'special_tags': ['[Vocal Interlude]', '[Female vocal interlude]'],
    'suno_base_prompt': DEFAULT_SUNO_BASE_PROMPT,
    'suno_reference_examples': DEFAULT_REFERENCE_EXAMPLES,
    'suno_wish_library': [],
}


def _normalize_wish_library(wishes: list) -> list:
    """Old format was a flat list of strings; wrap those into the current
    {id, title, text, created_at} shape without touching disk until the next
    save (see storage.save_settings callers)."""
    normalized = []
    for w in wishes:
        if isinstance(w, str):
            normalized.append({
                'id': uuid4().hex[:8], 'title': text_models.truncate_title(w), 'text': w, 'created_at': '',
            })
        else:
            normalized.append(w)
    return normalized


@router.get('')
def get_settings():
    merged = {**DEFAULT_SETTINGS, **storage.load_settings()}
    merged['suno_wish_library'] = _normalize_wish_library(merged.get('suno_wish_library', []))
    return merged


@router.put('')
def put_settings(body: dict = Body(...)):
    merged = {**DEFAULT_SETTINGS, **storage.load_settings(), **body}
    storage.save_settings(merged)
    return merged


@router.get('/models/{provider}')
async def get_models(provider: str):
    if provider not in _MODEL_PROVIDERS:
        raise HTTPException(404, f'Unknown provider: {provider}')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    return await text_models.list_models(provider, api_key)


@router.get('/image-models/{provider}')
async def get_image_models(provider: str):
    if provider not in _IMAGE_MODEL_PROVIDERS:
        raise HTTPException(404, f'Unknown provider: {provider}')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    return await image_models.list_models(provider, api_key)


@router.post('/wish-library')
async def add_wish(body: dict = Body(...)):
    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')
    model = (body.get('model') or '').strip()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    wish_library = _normalize_wish_library(settings.get('suno_wish_library', []))
    if any(w['text'] == text for w in wish_library):
        return {'suno_wish_library': wish_library, 'wish': next(w for w in wish_library if w['text'] == text)}

    # `model`, if the caller picked one for this save, only overrides which
    # model titles *this* wish - it must not get persisted as the new
    # settings.simple_models.default, so it's applied to a throwaway copy.
    title_settings = settings if not model else {
        **settings, 'simple_models': {**settings.get('simple_models', {}), 'default': model},
    }
    title = await text_models.generate_wish_title(text, title_settings)
    wish = {
        'id': uuid4().hex[:8], 'title': title, 'text': text,
        'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    }
    wish_library = [*wish_library, wish]
    settings['suno_wish_library'] = wish_library
    storage.save_settings(settings)
    return {'suno_wish_library': wish_library, 'wish': wish}
