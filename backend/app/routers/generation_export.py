"""Export/import routes plus the Editor stage's final render.

`/video-export` and `/video-import-batch` are the round trip for
generating clips in an external tool; `/final-export` zips the whole
project. The render itself lives in `providers/editor.py`.
"""

import io
import re
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, Body, File, HTTPException, Response, UploadFile

from .. import storage
from ..providers import editor, video
from .generation_common import _ALLOWED_VIDEO_EXTENSIONS, _now

router = APIRouter(prefix='/api/projects', tags=['generation'])


# Leading `NNN_` / `NNN-` prefix a video-import filename must carry to be
# matched back to a scene - the same convention `export_video_stage` writes
# (1-based scene number, zero-padded to 3 digits), see both docstrings below.
_SCENE_NUMBER_PREFIX_RE = re.compile(r'^0*(\d+)[_-]')


def _resolve_export_image(scene: dict) -> dict | None:
    """Mirrors `lib/scenes.js`'s `resolveAnimateImage` server-side: the
    per-scene animate override wins, then the Images stage's `is_selected`
    pick, then just the first image - same resolution order the Video stage
    itself uses to decide which picture it's animating."""
    images_list = scene.get('images') or []
    if not images_list:
        return None
    override_id = scene.get('animate_image_id')
    if override_id:
        match = next((img for img in images_list if img.get('image_id') == override_id), None)
        if match:
            return match
    return next((img for img in images_list if img.get('is_selected')), None) or images_list[0]


def _slugify_prompt(text: str, max_len: int = 50) -> str:
    """`motion_prompt` -> a filesystem-safe filename fragment: whitespace runs
    become a single dash (so a multi-word prompt still reads like one), any
    other filename-unsafe character is dropped, and the result is capped to
    `max_len` chars - matches the `NNN_slug` convention the user's own
    externally-generated clips already use, so a round-tripped export/import
    lines back up without renaming anything by hand."""
    text = (text or '').strip()
    if not text:
        return 'scene'
    slug = re.sub(r'\s+', '-', text)
    slug = re.sub(r'[^\w\-]', '', slug)
    slug = slug.strip('-')[:max_len].rstrip('-')
    return slug or 'scene'


@router.get('/{project_id}/video-export')
async def export_video_stage(project_id: str, scenes: str | None = None):
    """Bundles the Video stage's per-scene animate source picture (see
    `_resolve_export_image`) plus a `prompts.txt` of every included scene's
    `motion_prompt` into one zip, for handing off to an outside animation
    tool - the user's own workflow generates clips elsewhere from exactly
    this pair (picture + prompt) and later brings the finished videos back in
    through `import_video_batch` below. `scenes` is a comma-separated list of
    0-based scene indices, or omitted/`'all'` for every scene. Each entry is
    named `{scene_number:03d}_{prompt_slug}.{ext}` (1-based scene number, so
    a partial export still round-trips through the same scene numbers) -
    scenes with no resolvable image (or whose image file is missing on disk)
    are silently skipped from both the zip and `prompts.txt`, since there's
    nothing useful to export for them."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    scene_list = project.get('scenes', [])

    if scenes and scenes.strip().lower() != 'all':
        try:
            indices = sorted({int(x) for x in scenes.split(',') if x.strip() != ''})
        except ValueError:
            raise HTTPException(422, 'Invalid scenes parameter')
    else:
        indices = list(range(len(scene_list)))

    project_dir = storage.project_dir(project_id)
    buffer = io.BytesIO()
    prompt_lines = []
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for i in indices:
            if i < 0 or i >= len(scene_list):
                continue
            scene = scene_list[i]
            image = _resolve_export_image(scene)
            if image is None:
                continue
            src_path = project_dir / image['file_path']
            if not src_path.is_file():
                continue
            ext = src_path.suffix.lstrip('.') or 'png'
            filename = f'{i + 1:03d}_{_slugify_prompt(scene.get("motion_prompt", ""))}.{ext}'
            zf.write(src_path, filename)
            prompt_lines.append(scene.get('motion_prompt') or '')
        zf.writestr('prompts.txt', '\n\n'.join(prompt_lines))

    buffer.seek(0)
    title = project.get('title') or project_id
    # `filename=` must be latin-1-encodable (a raw HTTP header value) - an
    # ASCII-only fallback for browsers that ignore `filename*=`, which
    # carries the real (possibly Cyrillic) name percent-encoded instead.
    ascii_title = re.sub(r'[^A-Za-z0-9\-_]+', '_', title).strip('_') or 'export'
    zip_filename_ascii = f'{ascii_title}-video-export.zip'
    zip_filename_utf8 = f'{title}-video-export.zip'
    headers = {
        'Content-Disposition': f"attachment; filename=\"{zip_filename_ascii}\"; filename*=UTF-8''{quote(zip_filename_utf8)}",
    }
    return Response(content=buffer.getvalue(), media_type='application/zip', headers=headers)


@router.post('/{project_id}/video-import-batch')
async def import_video_batch(project_id: str, files: list[UploadFile] = File(...)):
    """Reverse of `export_video_stage` above: the user hands back a folder of
    finished clips named by the same `{scene_number:03d}_...` convention the
    export wrote, and each file is matched back to its scene purely from that
    leading number - no relation to upload order or original filenames
    otherwise. Anything that doesn't parse a scene number, resolves out of
    range, or isn't a recognized video extension is skipped (not a hard
    failure) and reported back in `skipped`, so one bad file in a folder of
    fifty doesn't abort the rest."""
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        scene_list = project.get('scenes', [])

        assigned = []
        skipped = []
        for file in files:
            name = file.filename or ''
            # A folder-picker upload (`webkitdirectory`) can hand back a
            # relative path (`subfolder/008_clip.mp4`) rather than a bare
            # filename depending on the browser - match on the last path
            # segment either way, but keep reporting the original `name` so
            # `assigned`/`skipped` reflect exactly what the browser sent.
            basename = name.replace('\\', '/').rsplit('/', 1)[-1]
            suffix = ('.' + basename.rsplit('.', 1)[-1].lower()) if '.' in basename else ''
            if suffix not in _ALLOWED_VIDEO_EXTENSIONS:
                skipped.append({'filename': name, 'reason': 'unsupported_type'})
                continue
            match = _SCENE_NUMBER_PREFIX_RE.match(basename)
            if not match:
                skipped.append({'filename': name, 'reason': 'no_scene_number'})
                continue
            scene_index = int(match.group(1)) - 1
            if scene_index < 0 or scene_index >= len(scene_list):
                skipped.append({'filename': name, 'reason': 'scene_out_of_range'})
                continue

            content = await file.read()
            new_video = video.save_uploaded_video(project_id, scene_index, content, suffix.removeprefix('.'))
            scene_list[scene_index]['videos'] = [*scene_list[scene_index].get('videos', []), new_video]
            assigned.append({'filename': name, 'scene_index': scene_index, 'video': new_video})

        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    return {'assigned': assigned, 'skipped': skipped}


@router.get('/{project_id}/final-export')
async def export_final_package(project_id: str):
    """Bundles the finished deliverables for handing the whole project off:
    every generated video candidate across every scene (not just each
    scene's `is_selected` pick - the user reviews and picks the winner
    outside this app, so the filename carries the rating instead of the app
    pre-choosing for them), the selected Mureka track's audio, and every
    Title Card variant explicitly marked `marked_for_export` (a variant-level
    flag independent of `is_selected`, since that one stays single-pick for
    the "main" title card elsewhere - falls back to the single `is_selected`
    variant when nothing is marked, so an older project isn't left with an
    empty title folder). Each video is named
    `{5-rating}★_scene{n:03d}_{motion_prompt_slug}_{shortid}.mp4` - the
    inverted-rating prefix (0 for 5★, 5 for unrated) sorts the best clips
    first alphabetically, a plain `{rating}★` prefix would sort worst-first;
    `{shortid}` (from the video's own file_path) disambiguates several
    candidates for the same scene sharing the same prompt slug. `404` if the
    project doesn't exist."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    project_dir = storage.project_dir(project_id)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for i, scene in enumerate(project.get('scenes', [])):
            for vid in scene.get('videos', []) or []:
                src_path = project_dir / vid['file_path']
                if not src_path.is_file():
                    continue
                rating = min(max(int(vid.get('rating') or 0), 0), 5)
                slug = _slugify_prompt(vid.get('motion_prompt') or scene.get('motion_prompt', ''))
                short_id = src_path.stem.rsplit('_', 1)[-1]
                filename = f'videos/{5 - rating}★_scene{i + 1:03d}_{slug}_{short_id}.mp4'
                zf.write(src_path, filename)

        tracks = (project.get('mureka') or {}).get('tracks', []) or []
        selected_track = next((t for t in tracks if t.get('is_selected')), None)
        if selected_track:
            src_path = project_dir / selected_track['file_path']
            if src_path.is_file():
                zf.write(src_path, f'audio/{src_path.name}')

        variants = (project.get('title_card') or {}).get('variants', []) or []
        marked = [v for v in variants if v.get('marked_for_export')] or [v for v in variants if v.get('is_selected')]
        for i, variant in enumerate(marked):
            src_path = project_dir / variant['file_path']
            if src_path.is_file():
                zf.write(src_path, f'title/{i + 1:02d}_{src_path.name}')

    buffer.seek(0)
    title = project.get('title') or project_id
    # `filename=` must be latin-1-encodable (a raw HTTP header value) - an
    # ASCII-only fallback for browsers that ignore `filename*=`, which
    # carries the real (possibly Cyrillic) name percent-encoded instead.
    ascii_title = re.sub(r'[^A-Za-z0-9\-_]+', '_', title).strip('_') or 'export'
    zip_filename_ascii = f'{ascii_title}-final-export.zip'
    zip_filename_utf8 = f'{title}-final-export.zip'
    headers = {
        'Content-Disposition': f"attachment; filename=\"{zip_filename_ascii}\"; filename*=UTF-8''{quote(zip_filename_utf8)}",
    }
    return Response(content=buffer.getvalue(), media_type='application/zip', headers=headers)


# ---------- Editor stage (final render, providers/editor.py) ----------
# `project.video_edit` (`{mureka_track_id, clips[], renders[]}`) - the clip
# order/trim/speed/track selection itself is edited only through the generic
# `PATCH /{project_id}` (same convention as every other rating/`is_selected`
# edit elsewhere in this app), so this section only starts/polls/cleans up
# the actual ffmpeg render, same job/poll shape as image/video generation.

@router.post('/{project_id}/editor/render')
async def start_editor_render(project_id: str, body: dict = Body(default={})):
    """`range_start_ms`/`range_end_ms` (both optional, both-or-neither) make
    this a *test* render - only that window of the timeline is rendered
    (`editor.py`'s `_trim_plan_to_range`), and the resulting `renders[]`
    entry is tagged `kind: 'test'` (vs `'final'`) so the side panel can label
    it differently - "Собрать тестовое видео" in `EditorStage.jsx`."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    video_edit = project.get('video_edit') or {}
    if not video_edit.get('clips'):
        raise HTTPException(422, 'Таймлайн пуст — добавьте хотя бы один клип')
    if not video_edit.get('mureka_track_id'):
        raise HTTPException(422, 'Не выбран аудиотрек для монтажа')
    job_id = editor.start_render_job(project_id, body.get('range_start_ms'), body.get('range_end_ms'))
    return {'job_id': job_id}


@router.get('/{project_id}/editor/jobs/{job_id}')
async def get_editor_render_job(project_id: str, job_id: str):
    job = editor.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.post('/{project_id}/editor/overlay-videos')
async def upload_editor_overlay_video(project_id: str, file: UploadFile = File(...)):
    """Uploads an arbitrary video file to overlay on the main timeline
    (`kind: 'video'` in `video_edit.overlays[]`) - project-scoped storage
    (`video_edit.overlay_video_sources[]`), same file-validation convention
    `import_video_batch` uses, but this route owns persistence itself
    (single file, no per-scene matching needed) rather than the frontend
    appending via a separate `PATCH`."""
    name = file.filename or ''
    suffix = ('.' + name.rsplit('.', 1)[-1].lower()) if '.' in name else ''
    if suffix not in _ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(422, 'Неподдерживаемый формат видео')
    content = await file.read()

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        source = editor.save_overlay_video_source(project_id, content, suffix.removeprefix('.'))
        video_edit = project.get('video_edit') or {}
        video_edit['overlay_video_sources'] = [*(video_edit.get('overlay_video_sources') or []), source]
        project['video_edit'] = video_edit
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    return source


@router.delete('/{project_id}/editor/overlay-videos/{source_id}')
async def delete_editor_overlay_video(project_id: str, source_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        video_edit = project.get('video_edit') or {}
        sources = video_edit.get('overlay_video_sources') or []
        target = next((s for s in sources if s.get('id') == source_id), None)
        if target is None:
            raise HTTPException(404, 'Overlay video not found')
        remaining = [s for s in sources if s.get('id') != source_id]
        video_edit['overlay_video_sources'] = remaining
        project['video_edit'] = video_edit
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'overlay_video_sources': remaining}


@router.delete('/{project_id}/editor/renders/{render_id}')
async def delete_editor_render(project_id: str, render_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        video_edit = project.get('video_edit') or {}
        renders = video_edit.get('renders', [])
        target = next((r for r in renders if r.get('render_id') == render_id), None)
        if target is None:
            raise HTTPException(404, 'Render not found')
        remaining = [r for r in renders if r.get('render_id') != render_id]
        video_edit['renders'] = remaining
        project['video_edit'] = video_edit
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'renders': remaining}
