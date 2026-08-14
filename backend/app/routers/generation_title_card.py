"""Title-card routes: AI variant generation, background removal, and the
poster constructor's save/delete (`PosterConstructor.jsx` flattens the
poster client-side - nothing is composited here).

Provider: `providers/title_card.py`.
"""

import json
from uuid import uuid4

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from .. import storage, usage
from ..providers import title_card, wish_library
from .generation_common import _now, _resolve_reference_path
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/projects', tags=['generation'])


@router.post('/{project_id}/title-card/generate')
async def generate_title_card(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    text_block = (body.get('text_block') or '').strip()
    base_prompt = body.get('base_prompt', '')
    reference_image_paths = body.get('reference_image_paths') or []
    if not reference_image_paths:
        raise HTTPException(422, 'reference_image_paths is required')
    if len(reference_image_paths) > 4:
        raise HTTPException(422, 'reference_image_paths accepts at most 4 images')
    for path in reference_image_paths:
        _resolve_reference_path(project_id, path)

    count = body.get('count', 1)
    model = body.get('model', '')
    aspect_ratio = body.get('aspect_ratio')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    active_title_card_wish_ids = body.get('active_title_card_wish_ids', project.get('active_title_card_wish_ids', []))
    title_card_wish_lookup = {
        w['id']: w['text'] for w in wish_library.normalize_wish_library(settings.get('title_card_wish_library', []))
    }
    active_wishes = [title_card_wish_lookup[wid] for wid in active_title_card_wish_ids if wid in title_card_wish_lookup]
    usage_ctx = usage.context('title_card', project_id, settings, count=count)
    job_ids = title_card.start_jobs(
        project_id, reference_image_paths, text_block, base_prompt, count, model, settings,
        usage_ctx=usage_ctx, aspect_ratio=aspect_ratio, active_wishes=active_wishes,
    )
    return {'job_ids': job_ids}


@router.post('/{project_id}/title-card/wishes')
async def add_title_card_wish(project_id: str, body: dict = Body(...)):
    """Title Card equivalent of /scenes/wishes - see wish_library.add_or_get_wish's
    docstring for why this is a separate library from scene_wish_library."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', project_id, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx, library_key='title_card_wish_library')
    wish = result['wish']

    active_title_card_wish_ids = project.get('active_title_card_wish_ids', [])
    if wish['id'] not in active_title_card_wish_ids:
        active_title_card_wish_ids = [*active_title_card_wish_ids, wish['id']]
    project['active_title_card_wish_ids'] = active_title_card_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {
        'wish': wish, 'title_card_wish_library': result['wish_library'],
        'active_title_card_wish_ids': active_title_card_wish_ids,
    }


@router.get('/{project_id}/title-card/jobs/{job_id}')
async def get_title_card_job(project_id: str, job_id: str):
    job = title_card.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/title-card/variants/{variant_id}')
async def delete_title_card_variant(project_id: str, variant_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        variants = (project.get('title_card') or {}).get('variants', [])
        target = next((v for v in variants if v.get('variant_id') == variant_id), None)
        if target is None:
            raise HTTPException(404, 'Variant not found')

        remaining = [v for v in variants if v.get('variant_id') != variant_id]
        title_card_field = project.get('title_card') or {}
        title_card_field['variants'] = remaining
        project['title_card'] = title_card_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'variants': remaining}


@router.post('/{project_id}/title-card/variants/{variant_id}/remove-background')
async def remove_title_card_variant_background(project_id: str, variant_id: str, body: dict = Body(default={})):
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('title_card_bg_remove', project_id, settings)
    try:
        result = await title_card.remove_background(
            project_id, variant_id, settings, usage_ctx=usage_ctx, method=body.get('method'),
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return result


@router.post('/{project_id}/title-card/poster')
async def save_title_card_poster(
    project_id: str,
    file: UploadFile = File(...),
    background_path: str = Form(...),
    title_card_variant_id: str = Form(...),
    logo_id: str = Form(''),
    layers: str = Form(...),
    canvas_size: str = Form(...),
    poster_id: str = Form(''),
):
    """Saves the flattened PNG a `PosterConstructor.jsx` Konva stage rendered
    (background scene image + the title-card overlay + an optional logo,
    dragged/scaled by the user) as a new poster, or re-renders an existing
    one in place when `poster_id` is given - the constructor is re-openable
    because `layers`/`background_path`/`title_card_variant_id`/`logo_id` are
    stored alongside the flattened image, not just the flattened PNG itself."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    _resolve_reference_path(project_id, background_path)
    variants = (project.get('title_card') or {}).get('variants', [])
    if not any(v.get('variant_id') == title_card_variant_id for v in variants):
        raise HTTPException(422, f'Unknown title_card_variant_id: {title_card_variant_id}')

    try:
        layers_data = json.loads(layers)
        canvas_size_data = json.loads(canvas_size)
    except json.JSONDecodeError as exc:
        raise HTTPException(422, f'layers/canvas_size must be valid JSON: {exc}') from exc

    contents = await file.read()

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        title_card_field = project.get('title_card') or {}
        posters = title_card_field.get('posters', [])
        existing = next((p for p in posters if p.get('poster_id') == poster_id), None) if poster_id else None

        new_poster_id = existing['poster_id'] if existing else f'poster_{uuid4().hex[:8]}'
        posters_dir = storage.project_dir(project_id) / 'titlecard' / 'posters'
        posters_dir.mkdir(parents=True, exist_ok=True)
        filename = f'{new_poster_id.removeprefix("poster_")}.png'
        (posters_dir / filename).write_bytes(contents)

        poster = {
            'poster_id': new_poster_id, 'file_path': f'titlecard/posters/{filename}',
            'background_path': background_path, 'title_card_variant_id': title_card_variant_id,
            'logo_id': logo_id or None, 'canvas_size': canvas_size_data, 'layers': layers_data,
            'rating': existing.get('rating', 0) if existing else 0,
            'is_selected': existing.get('is_selected', False) if existing else False,
            'generated_at': _now(),
        }
        posters = (
            [poster if p.get('poster_id') == new_poster_id else p for p in posters]
            if existing else [*posters, poster]
        )
        title_card_field['posters'] = posters
        project['title_card'] = title_card_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    return {'poster': poster, 'posters': posters}


@router.delete('/{project_id}/title-card/poster/{poster_id}')
async def delete_title_card_poster(project_id: str, poster_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        title_card_field = project.get('title_card') or {}
        posters = title_card_field.get('posters', [])
        target = next((p for p in posters if p.get('poster_id') == poster_id), None)
        if target is None:
            raise HTTPException(404, 'Poster not found')

        remaining = [p for p in posters if p.get('poster_id') != poster_id]
        title_card_field['posters'] = remaining
        project['title_card'] = title_card_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'posters': remaining}


# ---------- Mureka stage (real audio generation, see providers/mureka.py) ----------
# Rating/tag/primary-flag edits on a track go through the generic
# `PATCH /api/projects/{id}` route (client sends the whole recomputed
# `mureka.tracks` array) - same convention as scene-image rating/selection in
# useImagesStage.js, no dedicated endpoint needed for those. Only actions that
# also touch disk (starting a job, deleting a track/reference file) get their
# own route here.
