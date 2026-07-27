from fastapi import APIRouter, Body

from .. import storage

router = APIRouter(prefix='/api/settings', tags=['settings'])

DEFAULT_SETTINGS = {
    'lang': 'ru',
    'api_keys': {'openai': '', 'anthropic': '', 'deepseek': '', 'replicate': ''},
    'text_model_default': 'claude',
    'image_model_default': 'flux',
    'special_tags': ['[Vocal Interlude]', '[Female vocal interlude]'],
}


@router.get('')
def get_settings():
    return {**DEFAULT_SETTINGS, **storage.load_settings()}


@router.put('')
def put_settings(body: dict = Body(...)):
    merged = {**DEFAULT_SETTINGS, **storage.load_settings(), **body}
    storage.save_settings(merged)
    return merged
