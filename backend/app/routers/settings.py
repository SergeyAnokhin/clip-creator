from uuid import uuid4

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from .. import storage, usage
from ..providers import image_models, text_models, wish_library
from ..providers.mureka_prompt_defaults import MUREKA_BASE_PROMPT_PRESETS
from ..providers.scenes_prompt_defaults import (
    DEFAULT_SCENE_BASE_PROMPT_ABSTRACT, DEFAULT_SCENE_BASE_PROMPT_NARRATIVE,
)
from ..providers.suno_prompt_defaults import (
    DEFAULT_REFERENCE_EXAMPLES, DEFAULT_SUNO_BASE_PROMPT, SUNO_BASE_PROMPT_PRESETS,
)
from ..providers.title_card_prompt_defaults import (
    DEFAULT_TITLE_CARD_BASE_PROMPT, TITLE_CARD_BASE_PROMPT_PRESETS,
)

router = APIRouter(prefix='/api/settings', tags=['settings'])

_MODEL_PROVIDERS = {'google', 'google_free', 'openrouter', 'deepseek', 'replicate', 'fal'}
# Krea (krea.ai) only does image/video generation, no text/LLM models, so it's
# valid for the image-models endpoint but not the text one.
_IMAGE_MODEL_PROVIDERS = _MODEL_PROVIDERS | {'krea'}
_ALLOWED_LOGO_EXTENSIONS = {'.png', '.webp'}

DEFAULT_SETTINGS = {
    'lang': 'ru',
    'api_keys': {
        'replicate': '', 'google': '', 'google_free': '', 'fal': '', 'openrouter': '', 'deepseek': '',
        'krea': '', 'google_translate': '',
    },
    'text_models': {'favorites': [], 'default': 'google:gemini-2.5-flash'},
    'simple_models': {'favorites': [], 'default': ''},
    'image_models': {'favorites': [], 'default': ''},
    'image_models_simple': {'favorites': [], 'default': ''},
    'special_tags': ['[Vocal Interlude]', '[Female vocal interlude]'],
    'suno_base_prompt': DEFAULT_SUNO_BASE_PROMPT,
    'suno_reference_examples': DEFAULT_REFERENCE_EXAMPLES,
    'suno_wish_library': [],
    'scene_base_prompt_narrative': DEFAULT_SCENE_BASE_PROMPT_NARRATIVE,
    'scene_base_prompt_abstract': DEFAULT_SCENE_BASE_PROMPT_ABSTRACT,
    'scene_wish_library': [],
    'title_card_wish_library': [],
    # Title Card stage (poster-text generation) - see providers/title_card.py.
    # `title_card_base_prompt` is directly edited (same pattern as the scene
    # base prompts above); `_presets` is a user-managed list of named
    # variants {id, name, prompt} the stage can save/load, CRUD'd entirely
    # via this partial-merge PUT (no dedicated endpoints needed).
    'title_card_base_prompt': DEFAULT_TITLE_CARD_BASE_PROMPT,
    'title_card_base_prompt_presets': TITLE_CARD_BASE_PROMPT_PRESETS,
    'pricing_overrides': {},
    'request_timeout_seconds': 60,
    # Which of the 3 background-removal methods (see the guide this was
    # implemented from) the "Remove background" button defaults to when no
    # per-call `method` is given - 'local' (free, flat bg only) / 'fal' /
    # 'replicate'. Each method's own params live in the 3 keys below (see
    # providers/title_card.py's remove_background).
    'background_remover_method': 'replicate',
    # Method 1 (free, no API key) - flat-background pixel-threshold cutout.
    'background_remover_local_params': {'bg': 'black', 'threshold': 40},
    # Method 2 - FAL's background-removal models (providers/title_card.py's
    # _generate_background_remover_fal); 'model' picks between
    # fal-ai/bria/background/remove (cleaner cut) and fal-ai/imageutils/rembg
    # (softer).
    'background_remover_fal_params': {'model': 'fal-ai/bria/background/remove'},
    # Method 3 - Replicate 851-labs/background-remover input params (see
    # providers/title_card.py's _generate_background_remover) - defaults
    # match the model's own schema defaults (confirmed live against
    # api.replicate.com/v1/models/851-labs/background-remover, 2026-08).
    'background_remover_params': {
        'background_type': 'rgba', 'format': 'png', 'threshold': 0, 'reverse': False,
    },
    'logos': [],
    # UI-only preference (Scenes/Images stage): hides every motion_prompt
    # field/label when the scene mainly needs a static image right now -
    # doesn't touch the underlying scene data, just what's rendered.
    'hide_motion_prompt': False,
}


@router.get('')
def get_settings():
    merged = {**DEFAULT_SETTINGS, **storage.load_settings()}
    merged['suno_wish_library'] = wish_library.normalize_wish_library(merged.get('suno_wish_library', []))
    merged['scene_wish_library'] = wish_library.normalize_wish_library(merged.get('scene_wish_library', []))
    merged['title_card_wish_library'] = wish_library.normalize_wish_library(merged.get('title_card_wish_library', []))
    return merged


@router.put('')
def put_settings(body: dict = Body(...)):
    merged = {**DEFAULT_SETTINGS, **storage.load_settings(), **body}
    storage.save_settings(merged)
    return merged


def _remember_catalog_entry(kind: str, provider: str, entry: dict) -> None:
    """Upserts one provider's fetched model list into the persisted catalog,
    so the Models/Prices tabs have it on the next app start without anyone
    pressing "Refresh models" again. A failed fetch (source == 'error') is
    never written - it would otherwise blank out a previously good list with
    a transient network/API-key error."""
    if entry.get('source') == 'error':
        return
    catalog = storage.load_model_catalog()
    catalog[kind][provider] = entry
    storage.save_model_catalog(catalog)


@router.get('/models/{provider}')
async def get_models(provider: str):
    if provider not in _MODEL_PROVIDERS:
        raise HTTPException(404, f'Unknown provider: {provider}')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    entry = await text_models.list_models(provider, api_key)
    _remember_catalog_entry('text', provider, entry)
    return entry


@router.get('/image-models/{provider}')
async def get_image_models(provider: str):
    if provider not in _IMAGE_MODEL_PROVIDERS:
        raise HTTPException(404, f'Unknown provider: {provider}')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    entry = await image_models.list_models(provider, api_key)
    _remember_catalog_entry('image', provider, entry)
    return entry


@router.get('/models-catalog')
def get_models_catalog():
    """The persisted last-known-good model catalog (see `_remember_catalog_entry`),
    for the Models/Prices tabs to show immediately on mount instead of an
    empty list until "Refresh models" is pressed."""
    return storage.load_model_catalog()


@router.get('/suno-prompt-presets')
def get_suno_prompt_presets():
    """Built-in alternate base-prompt variants, grouped by music service (see
    suno_prompt_defaults.py and mureka_prompt_defaults.py - each entry carries
    a `service` label like 'Suno' or 'Mureka') the Settings -> music-prompts
    tab offers to load into the editable settings.suno_base_prompt, so users
    can A/B test them - read-only, not stored per-user."""
    return SUNO_BASE_PROMPT_PRESETS + MUREKA_BASE_PROMPT_PRESETS


@router.post('/wish-library')
async def add_wish(body: dict = Body(...)):
    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')
    model = (body.get('model') or '').strip()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', None, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx, model=model)
    return {'suno_wish_library': result['wish_library'], 'wish': result['wish']}


@router.patch('/wish-library/{wish_id}')
def update_wish(wish_id: str, body: dict = Body(...)):
    """Manual edit of a saved wish's title and/or text (e.g. after the
    auto-generated title from `add_wish` needs a correction) - no LLM call,
    so no usage tracking here unlike `add_wish`."""
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    wish_lib = wish_library.normalize_wish_library(settings.get('suno_wish_library', []))
    wish = next((w for w in wish_lib if w['id'] == wish_id), None)
    if wish is None:
        raise HTTPException(404, 'Wish not found')

    if 'title' in body:
        title = (body.get('title') or '').strip()
        if not title:
            raise HTTPException(422, 'title is required')
        wish['title'] = title
    if 'text' in body:
        text = (body.get('text') or '').strip()
        if not text:
            raise HTTPException(422, 'text is required')
        wish['text'] = text

    settings['suno_wish_library'] = wish_lib
    storage.save_settings(settings)
    return {'suno_wish_library': wish_lib, 'wish': wish}


@router.post('/scene-wish-library')
async def add_scene_wish(body: dict = Body(...)):
    """Scene/imagery pожелания - a library separate from suno_wish_library
    (see wish_library.add_or_get_wish's docstring): same shape and flow, just
    a different domain and a different per-project toggle
    (`active_scene_wish_ids`, see routers/generation.py)."""
    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')
    model = (body.get('model') or '').strip()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', None, settings)
    result = await wish_library.add_or_get_wish(
        text, settings, usage_ctx=usage_ctx, model=model, library_key='scene_wish_library',
    )
    return {'scene_wish_library': result['wish_library'], 'wish': result['wish']}


@router.patch('/scene-wish-library/{wish_id}')
def update_scene_wish(wish_id: str, body: dict = Body(...)):
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    wish_lib = wish_library.normalize_wish_library(settings.get('scene_wish_library', []))
    wish = next((w for w in wish_lib if w['id'] == wish_id), None)
    if wish is None:
        raise HTTPException(404, 'Wish not found')

    if 'title' in body:
        title = (body.get('title') or '').strip()
        if not title:
            raise HTTPException(422, 'title is required')
        wish['title'] = title
    if 'text' in body:
        text = (body.get('text') or '').strip()
        if not text:
            raise HTTPException(422, 'text is required')
        wish['text'] = text

    settings['scene_wish_library'] = wish_lib
    storage.save_settings(settings)
    return {'scene_wish_library': wish_lib, 'wish': wish}


@router.post('/logos')
async def upload_logo(file: UploadFile = File(...), name: str = Form('')):
    """Global (cross-project) logo library for the Poster constructor (see
    routers/generation.py's poster routes) - PNG/WebP with a transparent
    background, stored under app_data/logos/ (served at /media/logos/... -
    the /media mount is storage.get_data_root(), see main.py) and listed in
    settings.logos, same partial-merge-PUT-visible pattern as
    suno_wish_library etc."""
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(415, 'Unsupported image type (use png or webp)')
    contents = await file.read()

    logos_dir = storage.get_data_root() / 'logos'
    logos_dir.mkdir(parents=True, exist_ok=True)
    logo_id = uuid4().hex[:8]
    filename = f'logo_{logo_id}{suffix}'
    (logos_dir / filename).write_bytes(contents)

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    logos = [*settings.get('logos', []), {'id': logo_id, 'name': (name or file.filename or '').strip(), 'file_path': f'logos/{filename}'}]
    settings['logos'] = logos
    storage.save_settings(settings)
    return {'logos': logos}


@router.delete('/logos/{logo_id}')
def delete_logo(logo_id: str):
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    logos = settings.get('logos', [])
    target = next((l for l in logos if l.get('id') == logo_id), None)
    if target is None:
        raise HTTPException(404, 'Logo not found')

    remaining = [l for l in logos if l.get('id') != logo_id]
    settings['logos'] = remaining
    storage.save_settings(settings)

    file_path = storage.get_data_root() / target['file_path']
    if file_path.is_file():
        file_path.unlink()
    return {'logos': remaining}
