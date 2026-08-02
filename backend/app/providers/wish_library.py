"""Shared logic for adding a wish to the global settings.suno_wish_library -
used both by the library-only Settings endpoint and by the Suno-stage
"Применить" flow, which also activates the wish for the current project
(see routers/generation.py)."""

from datetime import datetime, timezone
from uuid import uuid4

from .. import storage
from . import text_models


def normalize_wish_library(wishes: list) -> list:
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


async def add_or_get_wish(
    text: str, settings: dict, usage_ctx: dict | None = None, *, model: str = '',
) -> dict:
    """Cleans+titles `text` via clean_wish_and_title and appends it to
    settings.suno_wish_library (persisting settings), or reuses an existing
    wish with the exact same text. Returns {'wish': {...}, 'wish_library': [...]}.

    `model`, if given, only overrides which model titles *this* wish - it
    must not get persisted as the new settings.simple_models.default, so
    it's applied to a throwaway settings copy."""
    text = text.strip()
    wish_library = normalize_wish_library(settings.get('suno_wish_library', []))
    existing = next((w for w in wish_library if w['text'] == text), None)
    if existing:
        return {'wish': existing, 'wish_library': wish_library}

    title_settings = settings if not model else {
        **settings, 'simple_models': {**settings.get('simple_models', {}), 'default': model},
    }
    result = await text_models.clean_wish_and_title(text, title_settings, usage_ctx=usage_ctx)
    wish = {
        'id': uuid4().hex[:8], 'title': result['title'], 'text': result['clean_text'],
        'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    }
    wish_library = [*wish_library, wish]
    settings['suno_wish_library'] = wish_library
    storage.save_settings(settings)
    return {'wish': wish, 'wish_library': wish_library}
