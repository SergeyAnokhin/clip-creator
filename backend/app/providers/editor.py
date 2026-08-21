"""Provider seam for the Editor stage - the final step: assembles the
project's picked scene video clips into one rendered file, synced to the
project's selected Mureka audio track, via a local `ffmpeg` call. Unlike
every other provider in this package, this one calls no external API (pure
local compute) - no `usage.record`, no API key.

The seam is three modules; this one is the public face and everything below
still imports `providers.editor` alone:

    editor_plan.py    EDL -> render plan (resolve/validate/clamp, pure)
    editor_ffmpeg.py  plan -> ffmpeg command, and running it
    editor.py         this file: the job store, `render_to_file`,
                      `save_overlay_video_source`, and re-exports

`project.video_edit` (`{mureka_track_id, clips[], renders[]}`) is the edit
decision list (EDL). Clip order/trim/speed/track selection are edited only
through the generic `PATCH /api/projects/{id}` (same convention as every
other rating/`is_selected`/`karaoke_sync` edit elsewhere in this app) - this
module never decides the EDL, only renders whatever `video_edit` currently
holds and appends the result to `renders[]`.

v1 supports reorder/trim/speed/reverse against a single audio track, image
and video overlays (title card variants / logos / uploaded video-overlay
sources, a video overlay also reversible the same way) on their own
free-floating lane, a crossfade/black/white transition at any clip boundary,
and a per-clip fade-in/fade-out (black or white). AI-generated
clips are silent by convention in this app, so the render is always
muted-video + Mureka-audio, never a mix of both - an overlay video is muted
the same way (see `build_ffmpeg_command`'s overlay-input setup).

`EditorClip.transition_in` (`{type: 'dissolve'|'fadeblack'|'fadewhite',
duration_ms}`, absent/`None` = a hard cut) describes the transition *into*
this clip *from* the previous one - meaningless on the first clip. It renders
as a real ffmpeg `xfade` (the two clips' actual frames overlap and blend for
`duration_ms`), which means the combined output is that much *shorter* than
the naive sum of both clips' own durations - `build_render_plan` accounts for
that when sizing the tail freeze-pad, but the frontend timeline's own layout
does **not** model the overlap (clip blocks stay back-to-back, a transition
is a marker at the boundary, not a resizable block) - the render already has
an established, documented "the real render may differ slightly from the
approximate timeline" tolerance (duration-mismatch warnings, `tpad`), and a
transition's overlap is just another source of that same, already-accepted
approximation. `EditorClip.fade_in`/`fade_out` (`{color: 'black'|'white',
duration_ms}`, absent/`None` = no fade) are a plain ffmpeg `fade` filter
applied to that one clip only, entirely within its own duration - no
interaction with neighbours or the timeline layout at all.

`EditorClip.fit` (`{mode: 'cover'|'contain', zoom, offset_x_pct,
offset_y_pct}`, absent/`None` = `{mode: 'cover', zoom: 1, offset_x_pct: 50,
offset_y_pct: 50}`) is how a clip whose own aspect ratio doesn't match the
render canvas fills it - `cover` (the default) scales up and crops the
overflow so the clip always fills the frame with no letterbox bars, `zoom`
(>=1) scales in further beyond that minimum, and `offset_x_pct`/
`offset_y_pct` (0-100%, 50 = centered) pan within the resulting overscanned
image; `contain` is the old always-letterboxed behavior (scale down to fit,
pad the rest), kept as an explicit opt-in for a clip the user deliberately
wants letterboxed - `zoom`/offset are meaningless there and ignored.

An overlay entry in `video_edit['overlays']` is `{overlay_id, kind:
'title_card'|'logo'|'video', source_id, start_ms, duration_ms, x_pct, y_pct,
width_pct, height_pct, rotation_deg, opacity}` - `start_ms`/`duration_ms` are
output-timeline coordinates (same space as a clip's `startMs`/`durationMs` on
the frontend); for `kind: 'video'`, `source_id` resolves against
`video_edit['overlay_video_sources']` (`[{id, file_path, duration_seconds}]`,
`duration_seconds` always `None` - see `save_overlay_video_source`'s own
docstring) rather than `project`/`settings` like the other two kinds -
project-scoped storage, since an arbitrary overlay video is a one-off project
asset, not cross-project branding like a logo; `x_pct`/`y_pct` place the
overlay's own top-left corner (the
top-left of its *unrotated* bounding box - see `build_ffmpeg_command`'s
rotation handling below) as a percentage of the canvas (`x_pct` of width,
`y_pct` of height); `width_pct`/`height_pct` scale it independently (no
forced source-aspect lock) - both as a percentage of the canvas's own
**width** (`height_pct` deliberately shares `width_pct`'s axis rather than
being a percentage of canvas height, so their ratio always reproduces the
overlay's real pixel aspect ratio no matter which shape the canvas itself is
- see `_migrate_overlay_position`'s docstring for the bug this avoids);
`rotation_deg`
(0-360) rotates it about that same top-left corner - mirrors exactly how
`components/shared/CanvasLayer.jsx`'s Konva `Group` places/rotates a node
(translate to `(x,y)` then rotate then scale, offset always `(0,0)`), so the
program monitor's live drag/resize/rotate canvas matches this render
pixel-for-pixel; `opacity` is 0-1 on top of whatever alpha the source image
already carries. An overlay saved before free placement existed only has the
old `position` (a 9-point anchor) + a bare `width_pct` - `_migrate_overlay_
position` (a Python mirror of `lib/overlays.js`'s `migrateOverlay`) derives
the new fields from those the first time such an overlay is resolved, so a
render against a never-reopened-in-the-new-frontend document still works.
Array order is z-order, later entries painted on top - mirrors
`Poster.layers`' array convention.

ffmpeg is invoked the same way `mureka.py`'s reference-audio trimmer does:
`subprocess.run` inside `asyncio.to_thread`, not
`asyncio.create_subprocess_exec` - the latter needs a Proactor event loop
that isn't guaranteed under `uvicorn --reload` on Windows (this repo's dev
environment) and has failed there before."""

import asyncio
import shutil
from pathlib import Path
from uuid import uuid4

from .. import storage
from .editor_ffmpeg import _run_ffmpeg_render, build_ffmpeg_command
from .editor_plan import (  # noqa: F401 - _probe_duration_ms is re-exported, not used here
    RenderPlanError,
    _now,
    _probe_duration_ms,
    _trim_plan_to_range,
    build_render_plan,
)

# Re-exported so callers (routers, tests) keep importing one module for the
# whole Editor seam, the way they did before this file was split in three.
__all__ = [
    'RenderPlanError',
    'build_ffmpeg_command',
    'build_render_plan',
    'get_job',
    'render_to_file',
    'save_overlay_video_source',
    'start_render_job',
]

_jobs: dict[str, dict] = {}


def save_overlay_video_source(slug: str, content: bytes, ext: str) -> dict:
    """Writes an uploaded video-overlay source into the project's own
    `editor/overlay_sources/` dir (project-scoped, unlike a logo - see this
    module's own docstring on `kind: 'video'`) and returns the
    `video_edit.overlay_video_sources[]` entry for it. `duration_seconds` is
    always `None` - never ffprobed, same convention `video.save_uploaded_
    video` already established for uploaded/imported clips elsewhere in this
    app (an overlay's own `start_ms`/`duration_ms` governs its on-timeline
    window regardless of the source's own length, same as an image
    overlay)."""
    source_id = f'ovv_{uuid4().hex[:8]}'
    sources_dir = storage.project_dir(slug) / 'editor' / 'overlay_sources'
    sources_dir.mkdir(parents=True, exist_ok=True)
    filename = f'{source_id}.{ext}'
    (sources_dir / filename).write_bytes(content)
    return {'id': source_id, 'file_path': f'editor/overlay_sources/{filename}', 'duration_seconds': None}


async def render_to_file(
    project: dict, video_edit: dict, project_dir: Path, dest_path: Path, settings: dict | None = None,
    range_start_ms: float | None = None, range_end_ms: float | None = None,
) -> dict:
    if shutil.which('ffmpeg') is None:
        raise RuntimeError(
            'ffmpeg не найден в PATH - он нужен, чтобы собрать финальное видео. '
            'Установите ffmpeg (ffmpeg.org) и перезапустите backend.',
        )
    # `build_render_plan` may probe an unbounded clip's real file via
    # `ffprobe` (a blocking subprocess call) when given `project_dir` - runs
    # in a thread for the same reason `_run_ffmpeg_render` below does.
    plan = await asyncio.to_thread(build_render_plan, project, video_edit, settings, project_dir)
    if range_start_ms is not None and range_end_ms is not None:
        if range_end_ms <= range_start_ms:
            raise RenderPlanError('Некорректный диапазон теста')
        plan = _trim_plan_to_range(plan, max(0.0, range_start_ms), range_end_ms)
    cmd = build_ffmpeg_command(plan, project_dir, dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(_run_ffmpeg_render, cmd)
    return {'duration_ms': int(plan['output_duration_s'] * 1000), 'clip_count': len(plan['clips'])}


async def _run_render_job(job_id: str, slug: str, range_start_ms: float | None = None, range_end_ms: float | None = None) -> None:
    try:
        project = storage.load_project(slug)
        if project is None:
            raise RuntimeError('Проект не найден')
        video_edit = project.get('video_edit') or {}
        settings = storage.load_settings()
        render_id = f'rnd_{uuid4().hex[:8]}'
        project_dir = storage.project_dir(slug)
        dest_path = project_dir / 'editor' / f'{render_id}.mp4'
        is_test = range_start_ms is not None and range_end_ms is not None
        result = await render_to_file(project, video_edit, project_dir, dest_path, settings, range_start_ms, range_end_ms)

        render_entry = {
            'render_id': render_id,
            'file_path': f'editor/{render_id}.mp4',
            'created_at': _now(),
            'duration_ms': result['duration_ms'],
            'clip_count': result['clip_count'],
            'mureka_track_id': video_edit.get('mureka_track_id'),
            'kind': 'test' if is_test else 'final',
            'range': {'start_ms': range_start_ms, 'end_ms': range_end_ms} if is_test else None,
        }
        async with storage.project_lock(slug):
            project = storage.load_project(slug)
            if project is not None:
                current_edit = project.get('video_edit') or {}
                current_edit['renders'] = [*current_edit.get('renders', []), render_entry]
                project['video_edit'] = current_edit
                project['updated_at'] = _now()
                storage.save_project(slug, project)
        _jobs[job_id] = {'status': 'completed', 'render': render_entry, 'error': None}
    except Exception as exc:
        _jobs[job_id] = {'status': 'failed', 'render': None, 'error': str(exc)}


def start_render_job(slug: str, range_start_ms: float | None = None, range_end_ms: float | None = None) -> str:
    job_id = uuid4().hex
    _jobs[job_id] = {'status': 'pending', 'render': None, 'error': None}
    asyncio.create_task(_run_render_job(job_id, slug, range_start_ms, range_end_ms))
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
