"""Provider seam for the Editor stage - the final step: assembles the
project's picked scene video clips into one rendered file, synced to the
project's selected Mureka audio track, via a local `ffmpeg` call. Unlike
every other provider in this package, this one calls no external API (pure
local compute) - no `usage.record`, no API key.

`project.video_edit` (`{mureka_track_id, clips[], renders[]}`) is the edit
decision list (EDL). Clip order/trim/speed/track selection are edited only
through the generic `PATCH /api/projects/{id}` (same convention as every
other rating/`is_selected`/`karaoke_sync` edit elsewhere in this app) - this
module never decides the EDL, only renders whatever `video_edit` currently
holds and appends the result to `renders[]`.

v1 supports reorder/trim/speed against a single audio track, image and video
overlays (title card variants / logos / uploaded video-overlay sources) on
their own free-floating lane, a crossfade/black/white transition at any clip
boundary, and a per-clip fade-in/fade-out (black or white). AI-generated
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
import math
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .. import console_log, storage

# Output canvas: a fixed size keeps the ffmpeg filter graph simple regardless
# of what resolution/aspect ratio each source clip was generated at - every
# clip is scaled into the same frame, by default cropping overflow to fill it
# (`clip.fit`, see this module's own docstring), letterboxed only when a clip
# explicitly opts into `contain`. Auto mode (`video_edit.canvas_orientation`
# absent or `'auto'`) picks '9:16' unless some clip's own stored
# `aspect_ratio` is *explicitly* something else - an unset/unprobed
# `aspect_ratio` (a manually uploaded clip - see `build_render_plan`'s own
# comment) doesn't force landscape, only a known non-9:16 clip does.
# `'portrait'`/`'landscape'` force that canvas outright regardless of any
# clip's aspect ratio - the manual override a user picks when auto-detection
# guesses wrong.
_DEFAULT_CANVAS = (1920, 1080)
_PORTRAIT_CANVAS = (1080, 1920)
_FPS = 30

_DEFAULT_FIT = {'mode': 'cover', 'zoom': 1.0, 'offset_x_pct': 50.0, 'offset_y_pct': 50.0}
_MIN_FIT_ZOOM = 1.0
_MAX_FIT_ZOOM = 4.0

_OVERLAY_DEFAULT_WIDTH_PCT = 20.0

# `position` (a 9-point anchor - pins the overlay's own matching corner/edge/
# center to that point, e.g. "bottom-right" pins its own bottom-right corner
# there) -> `[xPct, yPct]` of the canvas. Kept only for `_migrate_overlay_
# position` below, which converts an old-shape overlay to the current
# `x_pct`/`y_pct` (top-left-anchored) fields the first time it's resolved -
# exact Python mirror of `lib/overlays.js`'s private `_LEGACY_POSITION_PCT`.
_LEGACY_POSITION_PCT = {
    'top-left': (0, 0), 'top-center': (50, 0), 'top-right': (100, 0),
    'center-left': (0, 50), 'center': (50, 50), 'center-right': (100, 50),
    'bottom-left': (0, 100), 'bottom-center': (50, 100), 'bottom-right': (100, 100),
}
_LEGACY_DEFAULT_POSITION = 'bottom-right'

# User-facing transition `type` -> ffmpeg `xfade` filter's own transition
# name. A deliberately small, curated set (not xfade's full catalogue of
# wipes/slides/etc.) - "dissolve" is a plain crossfade, "fadeblack"/
# "fadewhite" blend through a solid colour (the "переход через чёрный" /
# "вспышка" the feature was asked for).
_TRANSITION_XFADE_NAME = {'dissolve': 'fade', 'fadeblack': 'fadeblack', 'fadewhite': 'fadewhite'}
_TRANSITION_MIN_S = 0.05
_FADE_COLORS = {'black', 'white'}

_jobs: dict[str, dict] = {}


class RenderPlanError(ValueError):
    """Raised by `build_render_plan` for an EDL that can't be resolved
    against the project's actual scenes/tracks - a 422 at the router."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _resolve_clip_video(project: dict, scene_index: int, video_id: str) -> dict:
    scenes = project.get('scenes') or []
    if scene_index < 0 or scene_index >= len(scenes):
        raise RenderPlanError(f'Сцена {scene_index} не найдена')
    videos = scenes[scene_index].get('videos') or []
    video = next((v for v in videos if v.get('video_id') == video_id), None)
    if video is None:
        raise RenderPlanError(f'Видео {video_id} не найдено в сцене {scene_index}')
    return video


def _resolve_track(project: dict, track_id: str) -> dict:
    tracks = (project.get('mureka') or {}).get('tracks') or []
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise RenderPlanError(f'Аудиотрек {track_id} не найден')
    return track


def _resolve_overlay_source(project: dict, settings: dict, video_edit: dict, overlay: dict) -> str:
    """The overlay source's `file_path` - project-relative for a title card
    variant or a video-overlay source (both live under this project's own
    directory, joined against `project_dir` in `build_ffmpeg_command`, same
    convention as a clip's own `file_path`), or an *absolute* path for a logo
    (the global cross-project library lives under the data root, not any
    project's own directory). `project_dir / file_path` silently prefers an
    absolute right-hand operand (pathlib), so `build_ffmpeg_command` never has
    to special-case which base a given overlay resolves against - it just
    always joins against `project_dir`."""
    kind = overlay.get('kind')
    source_id = overlay.get('source_id')
    if kind == 'title_card':
        variants = (project.get('title_card') or {}).get('variants') or []
        variant = next((v for v in variants if v.get('variant_id') == source_id), None)
        if variant is None:
            raise RenderPlanError(f'Оверлей: вариант заголовка {source_id} не найден')
        return variant['file_path']
    if kind == 'logo':
        logos = settings.get('logos') or []
        logo = next((item for item in logos if item.get('id') == source_id), None)
        if logo is None:
            raise RenderPlanError(f'Оверлей: логотип {source_id} не найден')
        return str(storage.get_data_root() / logo['file_path'])
    if kind == 'video':
        sources = video_edit.get('overlay_video_sources') or []
        source = next((item for item in sources if item.get('id') == source_id), None)
        if source is None:
            raise RenderPlanError(f'Оверлей: видео {source_id} не найдено')
        return source['file_path']
    raise RenderPlanError(f'Оверлей: неизвестный тип {kind!r}')


def _migrate_overlay_position(overlay: dict, canvas_width: int, canvas_height: int) -> dict:
    """An overlay already carrying `x_pct`/`y_pct` *and* `height_axis: 'width'`
    passes through unchanged; anything older gets normalized - exact mirror of
    `lib/overlays.js`'s `migrateOverlay` (see that function's own docstring).

    `height_axis: 'width'` marks the newer convention where `height_pct`, like
    `width_pct`, is a percentage of the canvas's own *width* (not its height) -
    deliberately the same reference axis for both, so their ratio always
    encodes the overlay's true pixel aspect ratio regardless of which shape
    the canvas itself is (`canvas_orientation` can switch between a 9:16
    portrait and 16:9 landscape canvas after an overlay was already placed;
    two percentages measured against two *different* axes don't survive that
    switch undistorted, which is exactly the "logo comes out squished/
    stretched" bug this fixes). An overlay saved before this convention
    existed has `height_pct` as a percentage of canvas *height* instead -
    converted here by rescaling with `canvas_height/canvas_width` so its real
    pixel size (and therefore its real aspect ratio) doesn't jump the first
    time it's re-resolved.

    An old-shape overlay (`position` + bare `width_pct`, no `height_pct`/
    `rotation_deg` at all) gets `x_pct`/`y_pct` derived from the legacy anchor
    and `height_pct == width_pct` - already a square in *pixel* terms once
    both are read as "percentage of canvas width", so it needs no rescaling,
    only the `height_axis` stamp."""
    if overlay.get('x_pct') is not None and overlay.get('y_pct') is not None:
        if overlay.get('height_axis') == 'width':
            return overlay
        height_pct = overlay.get('height_pct') or overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT
        return {
            **overlay,
            'height_pct': height_pct * (canvas_height / canvas_width) if canvas_width > 0 else height_pct,
            'height_axis': 'width',
        }
    anchor_x, anchor_y = _LEGACY_POSITION_PCT.get(overlay.get('position'), _LEGACY_POSITION_PCT[_LEGACY_DEFAULT_POSITION])
    width_pct = overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT
    height_pct = width_pct
    tx_frac = 0.0 if anchor_x == 0 else 1.0 if anchor_x == 100 else 0.5
    ty_frac = 0.0 if anchor_y == 0 else 1.0 if anchor_y == 100 else 0.5
    return {
        **overlay,
        'x_pct': anchor_x - width_pct * tx_frac,
        'y_pct': anchor_y - height_pct * ty_frac,
        'width_pct': width_pct,
        'height_pct': height_pct,
        'rotation_deg': overlay.get('rotation_deg') or 0,
        'height_axis': 'width',
    }


def _resolve_overlays(project: dict, settings: dict, video_edit: dict, canvas_width: int, canvas_height: int) -> list[dict]:
    resolved = []
    for raw_overlay in video_edit.get('overlays') or []:
        overlay = _migrate_overlay_position(raw_overlay, canvas_width, canvas_height)
        file_path = _resolve_overlay_source(project, settings, video_edit, overlay)
        duration_ms = overlay.get('duration_ms') or 0
        if duration_ms <= 0:
            raise RenderPlanError('Оверлей: некорректная длительность')
        start_ms = max(0, overlay.get('start_ms') or 0)
        x_pct = float(overlay.get('x_pct') or 0.0)
        y_pct = float(overlay.get('y_pct') or 0.0)
        width_pct = min(100.0, max(1.0, overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT))
        height_pct = min(100.0, max(1.0, overlay.get('height_pct') or width_pct))
        rotation_deg = (overlay.get('rotation_deg') or 0.0) % 360
        opacity = overlay.get('opacity')
        opacity = 1.0 if opacity is None else min(1.0, max(0.0, opacity))
        # Compressed proportionally if they'd together outlast the overlay's
        # own `duration_ms` (so they never overlap past the midpoint) - same
        # clamp `lib/overlays.js`'s `overlayOpacityAt` applies for the live
        # preview, so what the render produces matches what the user saw.
        fade_in_ms = max(0.0, overlay.get('fade_in_ms') or 0.0)
        fade_out_ms = max(0.0, overlay.get('fade_out_ms') or 0.0)
        if fade_in_ms + fade_out_ms > duration_ms:
            scale = duration_ms / (fade_in_ms + fade_out_ms)
            fade_in_ms *= scale
            fade_out_ms *= scale
        resolved.append({
            'kind': overlay.get('kind'),
            'file_path': file_path,
            'start_s': start_ms / 1000,
            'duration_s': duration_ms / 1000,
            'x_pct': x_pct,
            'y_pct': y_pct,
            'width_pct': width_pct,
            'height_pct': height_pct,
            'rotation_deg': rotation_deg,
            'opacity': opacity,
            'fade_in_s': fade_in_ms / 1000,
            'fade_out_s': fade_out_ms / 1000,
        })
    return resolved


def _overlay_alpha_filters(overlay: dict) -> str:
    """The alpha-shaping filter chain fragment for one overlay (comma-joined,
    dropped in right after `format=rgba` in both of `build_ffmpeg_command`'s
    overlay branches): a flat `colorchannelmixer=aa=<opacity>` (today's
    form, unchanged), plus one `fade=...:alpha=1` per fade actually set.
    `colorchannelmixer`'s own `aa` option takes a plain number, not a
    time-varying expression (confirmed against a real ffmpeg build - a
    `t`-based eval expression there fails to parse, `aa` isn't one of the
    filter's expression-capable options) - `fade`'s dedicated `alpha=1` mode
    is the actual supported way to ramp alpha over time. `fade` *multiplies*
    the existing alpha by its own 0->1 (or 1->0) curve during `[st, st+d)`
    and holds flat at the post-ramp value everywhere outside that window
    (1 before a fade-in starts or after a fade-out ends, matching "no
    fade"), so chaining `colorchannelmixer` (sets the flat base) then one
    `fade` per side composes exactly like `lib/overlays.js`'s
    `overlayOpacityAt` computes the same ramp for the live preview. `st`/`d`
    are the overlay's own stream's timestamp in seconds since the whole
    render started - same axis `enable='between(t,...)'` below already uses
    (an image's `-loop 1` stream and a video overlay's `setpts`-shifted
    stream both start counting from that same zero - see this module's own
    docstring and the `pre_filter` comment in `build_ffmpeg_command`)."""
    parts = [f"colorchannelmixer=aa={overlay['opacity']:.3f}"]
    fade_in_s = overlay['fade_in_s']
    fade_out_s = overlay['fade_out_s']
    if fade_in_s > 0:
        parts.append(f"fade=t=in:st={overlay['start_s']:.3f}:d={fade_in_s:.3f}:alpha=1")
    if fade_out_s > 0:
        end_s = overlay['start_s'] + overlay['duration_s']
        fade_out_start = end_s - fade_out_s
        parts.append(f"fade=t=out:st={fade_out_start:.3f}:d={fade_out_s:.3f}:alpha=1")
    return ','.join(parts)


def _resolve_fit(raw: dict | None) -> dict:
    """`{mode, zoom, offset_x_pct, offset_y_pct}` for a `clip.fit` spec -
    `_DEFAULT_FIT` (cover, centered, no extra zoom) when absent. `contain`
    ignores/drops `zoom`/offset (meaningless there - see this module's own
    docstring) rather than carrying stale values through."""
    if not raw or raw.get('mode') != 'contain':
        if not raw:
            return dict(_DEFAULT_FIT)
        return {
            'mode': 'cover',
            'zoom': min(_MAX_FIT_ZOOM, max(_MIN_FIT_ZOOM, raw.get('zoom') or _DEFAULT_FIT['zoom'])),
            'offset_x_pct': min(100.0, max(0.0, raw.get('offset_x_pct') if raw.get('offset_x_pct') is not None else _DEFAULT_FIT['offset_x_pct'])),
            'offset_y_pct': min(100.0, max(0.0, raw.get('offset_y_pct') if raw.get('offset_y_pct') is not None else _DEFAULT_FIT['offset_y_pct'])),
        }
    return {'mode': 'contain'}


def _resolve_fade(raw: dict | None, max_ms: float) -> dict | None:
    """`{color, duration_s}` for a `fade_in`/`fade_out` spec, or `None` if
    it's absent/zero-duration. `duration_ms` is clamped to `max_ms` (the
    clip's own resolved content length) - fading longer than the clip itself
    doesn't mean anything."""
    if not raw:
        return None
    duration_ms = min(raw.get('duration_ms') or 0, max_ms)
    if duration_ms <= 0:
        return None
    color = raw.get('color')
    if color not in _FADE_COLORS:
        color = 'black'
    return {'color': color, 'duration_s': duration_ms / 1000}


def build_render_plan(project: dict, video_edit: dict, settings: dict | None = None) -> dict:
    """Pure resolution of an EDL against the project's actual scenes/tracks
    into everything `build_ffmpeg_command` needs - no ffmpeg, no disk I/O
    beyond what the caller already loaded into `project`/`video_edit`."""
    clips = video_edit.get('clips') or []
    if not clips:
        raise RenderPlanError('Таймлайн пуст — добавьте хотя бы один клип')
    track_id = video_edit.get('mureka_track_id')
    if not track_id:
        raise RenderPlanError('Не выбран аудиотрек для монтажа')
    track = _resolve_track(project, track_id)
    audio_duration_s = (track.get('duration_ms') or 0) / 1000
    if audio_duration_s <= 0:
        raise RenderPlanError('У выбранного аудиотрека неизвестна длительность')

    resolved_clips = []
    effective_ms_list = []
    total_ms = 0.0
    all_portrait = True
    for clip in clips:
        video = _resolve_clip_video(project, clip['scene_index'], clip['video_id'])
        # `None` (a manually uploaded/imported clip - see the
        # `duration_seconds` comment just below, same convention) doesn't
        # veto portrait: an unknown aspect ratio isn't evidence the clip is
        # landscape, and treating it as one silently forced every timeline
        # with even a single uploaded clip to landscape regardless of what
        # the footage actually was. Only an *explicit* non-9:16 clip does.
        if video.get('aspect_ratio') not in (None, '9:16'):
            all_portrait = False
        # `duration_seconds` is `None` for a manually uploaded/imported clip
        # (`video.save_uploaded_video`/`import_video_batch` never probe the
        # file - see their docstrings) - a real, common case (video import
        # is an existing feature), not just a hypothetical. Trust it as an
        # upper bound only when known; otherwise (unknown AND no explicit
        # `trim_end_ms`) leave the end unbounded rather than collapsing the
        # clip to zero length - `build_ffmpeg_command` then omits the
        # filter's `end=` and ffmpeg simply runs the clip to its own EOF.
        source_duration_ms = (video.get('duration_seconds') or 0) * 1000
        trim_start_ms = max(0, clip.get('trim_start_ms') or 0)
        trim_end_ms = clip.get('trim_end_ms')
        if trim_end_ms is None and source_duration_ms > 0:
            trim_end_ms = source_duration_ms
        if trim_end_ms is not None and trim_end_ms <= trim_start_ms:
            raise RenderPlanError(
                f'Некорректная обрезка клипа сцены {clip["scene_index"]}: '
                f'{trim_start_ms}–{trim_end_ms} мс',
            )
        speed = clip.get('speed') or 1.0
        if speed <= 0:
            raise RenderPlanError(f'Некорректная скорость клипа сцены {clip["scene_index"]}')
        # An unbounded clip's real contribution to the timeline is unknown
        # ahead of time - counted as 0 for the padding estimate below, same
        # "approximate, non-blocking" tradeoff as every other duration-
        # mismatch case (the global `-t` cap on the final command still
        # keeps the overall output correct regardless).
        effective_ms = (trim_end_ms - trim_start_ms) / speed if trim_end_ms is not None else 0.0
        effective_ms_list.append(effective_ms)
        total_ms += effective_ms
        resolved_clips.append({
            'file_path': video['file_path'],
            'trim_start_s': trim_start_ms / 1000,
            'trim_end_s': trim_end_ms / 1000 if trim_end_ms is not None else None,
            'speed': speed,
            'tpad_s': 0.0,
            'transition_in': None,
            'fade_in': _resolve_fade(clip.get('fade_in'), effective_ms),
            'fade_out': _resolve_fade(clip.get('fade_out'), effective_ms),
            'fit': _resolve_fit(clip.get('fit')),
        })

    # A transition eats into (overlaps) both the clip before it and this one
    # - not extra time - so it has to come back out of `total_ms` before the
    # tail freeze-pad is sized, or the estimate runs long by the sum of every
    # transition's own duration.
    total_transition_ms = 0.0
    for i in range(1, len(clips)):
        raw = clips[i].get('transition_in')
        xfade_name = _TRANSITION_XFADE_NAME.get((raw or {}).get('type'))
        if not xfade_name:
            continue
        # Clamped to whichever neighbour has less content to spare - a
        # transition can never outlast the clip it's blending into or out of.
        max_ms = min(effective_ms_list[i - 1], effective_ms_list[i])
        duration_ms = min(raw.get('duration_ms') or 0, max_ms)
        if duration_ms / 1000 < _TRANSITION_MIN_S:
            continue
        resolved_clips[i]['transition_in'] = {'type': xfade_name, 'duration_s': duration_ms / 1000}
        total_transition_ms += duration_ms
    total_ms -= total_transition_ms

    pad_s = max(0.0, audio_duration_s - total_ms / 1000)
    if pad_s > 0:
        resolved_clips[-1]['tpad_s'] = pad_s

    orientation = video_edit.get('canvas_orientation') or 'auto'
    if orientation == 'portrait':
        width, height = _PORTRAIT_CANVAS
    elif orientation == 'landscape':
        width, height = _DEFAULT_CANVAS
    else:
        width, height = _PORTRAIT_CANVAS if all_portrait else _DEFAULT_CANVAS
    return {
        'clips': resolved_clips,
        'overlays': _resolve_overlays(project, settings or {}, video_edit, width, height),
        'audio_file_path': track['file_path'],
        'audio_duration_s': audio_duration_s,
        'target_width': width,
        'target_height': height,
        'output_duration_s': audio_duration_s,
    }


def _trim_plan_to_range(plan: dict, range_start_ms: float, range_end_ms: float) -> dict:
    """Post-processes an already-resolved render plan (`build_render_plan`'s
    own output) down to only the `[range_start_ms, range_end_ms)` window of
    its output timeline - the backend half of "Собрать тестовое видео"
    (`start_editor_render` -> `start_render_job` -> here).

    Clips entirely outside the range are dropped; the new first/last clip's
    own `trim_start_s`/`trim_end_s` are tightened to whatever part of their
    own content falls inside the range (the shift is converted from output-
    timeline ms to source-time via `* speed`, same direction
    `build_render_plan` already trims by); a transition into the new first
    clip is cleared (a transition from a clip that's no longer there is
    meaningless); the tail freeze-pad (`tpad_s`) is cleared from every kept
    clip except recomputed on the new last one, only if the range's own end
    reaches past that clip's real content into what would have been padding.
    Overlays are kept only if they intersect the range, with `start_s`
    shifted so the range's own start becomes the new timeline's zero and
    `duration_s` clamped to the trimmed window's own end.
    `audio_offset_s`/`output_duration_s` replace `audio_duration_s` as what
    drives the final `-t` and the audio track's own trim
    (`build_ffmpeg_command`)."""
    clips = plan['clips']

    def content_ms(clip: dict) -> float | None:
        if clip['trim_end_s'] is None:
            return None
        return (clip['trim_end_s'] - clip['trim_start_s']) * 1000 / clip['speed']

    # Cumulative output-timeline start per clip - mirrors the offset math
    # `build_ffmpeg_command`'s own `xfade` chain already computes (a
    # transition into clip `i` starts blending `duration_s` before the
    # combined stream would otherwise reach it, so *this* clip's own start
    # moves back by its own transition's duration, not the next one's).
    # Ignores transition *overlap*'s effect on later boundaries beyond that
    # - the render's own established tolerance for that approximation, see
    # this module's `transition_in` docstring, applies here too.
    starts_ms = []
    ends_ms = []  # own real content end, tpad excluded
    cursor_ms = 0.0
    for clip in clips:
        if clip['transition_in']:
            cursor_ms -= clip['transition_in']['duration_s'] * 1000
        starts_ms.append(cursor_ms)
        c_ms = content_ms(clip)
        # An unbounded clip's own contribution is unknown - same "counts as
        # 0" tolerance `build_render_plan` already applies elsewhere; a range
        # spanning past it can't be trimmed precisely, an existing, already-
        # accepted edge case rather than a new one.
        ends_ms.append(cursor_ms + c_ms if c_ms is not None else cursor_ms)
        if c_ms is not None:
            cursor_ms += c_ms + clip['tpad_s'] * 1000

    trimmed_clips = []
    kept_end_ms = []
    for i, clip in enumerate(clips):
        clip_start_ms, clip_end_ms = starts_ms[i], ends_ms[i]
        if clip_end_ms <= range_start_ms or clip_start_ms >= range_end_ms:
            continue
        new_clip = dict(clip)
        if clip_start_ms < range_start_ms:
            new_clip['trim_start_s'] += (range_start_ms - clip_start_ms) / 1000 * clip['speed']
        if new_clip['trim_end_s'] is not None and clip_end_ms > range_end_ms:
            new_clip['trim_end_s'] -= (clip_end_ms - range_end_ms) / 1000 * clip['speed']
        new_clip['tpad_s'] = 0.0
        trimmed_clips.append(new_clip)
        kept_end_ms.append(clip_end_ms)

    if not trimmed_clips:
        raise RenderPlanError('Выбранный диапазон не пересекается ни с одним клипом')

    trimmed_clips[0]['transition_in'] = None
    if kept_end_ms[-1] is not None and range_end_ms > kept_end_ms[-1]:
        trimmed_clips[-1]['tpad_s'] = (range_end_ms - kept_end_ms[-1]) / 1000

    trimmed_overlays = []
    for overlay in plan.get('overlays') or []:
        ov_start_ms = overlay['start_s'] * 1000
        ov_end_ms = ov_start_ms + overlay['duration_s'] * 1000
        if ov_end_ms <= range_start_ms or ov_start_ms >= range_end_ms:
            continue
        new_overlay = dict(overlay)
        new_start_ms = max(ov_start_ms, range_start_ms) - range_start_ms
        new_end_ms = min(ov_end_ms, range_end_ms) - range_start_ms
        new_overlay['start_s'] = new_start_ms / 1000
        new_overlay['duration_s'] = (new_end_ms - new_start_ms) / 1000
        trimmed_overlays.append(new_overlay)

    return {
        **plan,
        'clips': trimmed_clips,
        'overlays': trimmed_overlays,
        'audio_offset_s': range_start_ms / 1000,
        'output_duration_s': (range_end_ms - range_start_ms) / 1000,
    }


def build_ffmpeg_command(plan: dict, project_dir: Path, dest_path: Path, fps: int = _FPS) -> list[str]:
    """Pure command construction - every input path is resolved but nothing
    is executed here, so this is fully unit-testable without real ffmpeg or
    real files. Only ever maps the built `[vout]`/`[aout]` labels - never
    `-map {i}:a` on a video input, since an AI-generated clip can carry a
    silent embedded audio track that must never leak into the final mux."""
    clips = plan['clips']
    overlays = plan.get('overlays') or []
    w, h = plan['target_width'], plan['target_height']

    cmd = ['ffmpeg', '-y']
    for clip in clips:
        cmd += ['-i', str(project_dir / clip['file_path'])]
    audio_index = len(clips)
    cmd += ['-i', str(project_dir / plan['audio_file_path'])]
    overlay_base_index = audio_index + 1
    for overlay in overlays:
        if overlay['kind'] == 'video':
            # A real video stream, not a looped still - plays from its own
            # start for as long as the `overlay` filter's `enable=` window
            # below stays true (or until it hits its own EOF, whichever
            # comes first - v1 doesn't loop a video overlay shorter than its
            # window, same "approximate, non-blocking" tradeoff as an
            # unbounded clip elsewhere in this module). Never `-map`'d for
            # audio (below, with every other overlay/clip input) - an
            # overlay video is always silent, same "AI clips are silent"
            # convention this module already applies to every main clip.
            cmd += ['-i', str(project_dir / overlay['file_path'])]
        else:
            # `-loop 1` turns the still image into an infinite stream, so the
            # `overlay` filter below has frames for as long as its own
            # `enable='between(...)'` window stays true - bounded by the
            # whole command's final `-t`, not by the image input itself.
            cmd += ['-loop', '1', '-i', str(project_dir / overlay['file_path'])]

    filter_parts = []
    labels = []
    # A clip's own resolved output duration (content + tail freeze-pad, if
    # any) - `None` when unbounded (unknown source length, no explicit trim
    # end). Only needed for transition `offset` math below, but cheap enough
    # to always compute.
    clip_durations_s = []
    for i, clip in enumerate(clips):
        label = f'v{i}'
        # `trim_end_s: None` (unknown source duration, no explicit trim end
        # - see `build_render_plan`) omits `end=` entirely, so ffmpeg just
        # runs this clip to its own EOF instead of collapsing it to zero
        # length.
        trim_end_part = f":end={clip['trim_end_s']:.3f}" if clip['trim_end_s'] is not None else ''
        fit = clip['fit']
        if fit['mode'] == 'contain':
            fit_chain = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        else:
            # `cover`: scale up to *at least* wxh (ffmpeg's own "increase"
            # formula, `max(w/iw, h/ih)`, written out as an expression since
            # the source's actual resolution is only known at ffmpeg's own
            # runtime, not here) times `zoom`, `ceil`'d so the scaled image
            # is never a fraction of a pixel short of wxh (a `trunc` here
            # could round down right at the boundary and make the crop
            # below go negative); then `crop` to exactly wxh, panned within
            # the overscanned image by `offset_x_pct`/`offset_y_pct` (0-100%,
            # 50 = centered) - fills the frame with no letterbox bars.
            scale_expr = (
                f"ceil(iw*max({w}/iw\\,{h}/ih)*{fit['zoom']:.4f}):"
                f"ceil(ih*max({w}/iw\\,{h}/ih)*{fit['zoom']:.4f})"
            )
            crop_expr = (
                f"crop={w}:{h}:(in_w-{w})*{fit['offset_x_pct']:.3f}/100:(in_h-{h})*{fit['offset_y_pct']:.3f}/100"
            )
            fit_chain = f"scale={scale_expr},{crop_expr}"
        chain = (
            f"[{i}:v]trim=start={clip['trim_start_s']:.3f}{trim_end_part},"
            f"setpts=(PTS-STARTPTS)/{clip['speed']:.4f},"
            f"{fit_chain},setsar=1,fps={fps}"
        )
        content_duration_s = None
        if clip['trim_end_s'] is not None:
            content_duration_s = (clip['trim_end_s'] - clip['trim_start_s']) / clip['speed']
        if clip['fade_in']:
            chain += f",fade=t=in:st=0:d={clip['fade_in']['duration_s']:.3f}:color={clip['fade_in']['color']}"
        if clip['fade_out'] and content_duration_s is not None:
            fade_out_st = max(0.0, content_duration_s - clip['fade_out']['duration_s'])
            chain += f",fade=t=out:st={fade_out_st:.3f}:d={clip['fade_out']['duration_s']:.3f}:color={clip['fade_out']['color']}"
        if clip['tpad_s'] > 0:
            chain += f",tpad=stop_mode=clone:stop_duration={clip['tpad_s']:.3f}"
        chain += f"[{label}]"
        filter_parts.append(chain)
        labels.append(f'[{label}]')
        clip_durations_s.append(None if content_duration_s is None else content_duration_s + clip['tpad_s'])

    # With no overlays, the clip chain feeds `[vout]` directly (unchanged
    # from before overlays existed); with overlays, it feeds an intermediate
    # `[vbase]` that the overlay chain below composites onto, ending in
    # `[vout]` itself.
    concat_label = 'vbase' if overlays else 'vout'
    has_transitions = any(clip['transition_in'] for clip in clips)
    if not has_transitions:
        # The common case, unchanged byte-for-byte from before transitions
        # existed: one `concat` over every clip at once.
        filter_parts.append(f"{''.join(labels)}concat=n={len(clips)}:v=1:a=0[{concat_label}]")
    else:
        # At least one boundary is a real crossfade - `xfade` only ever
        # blends exactly two streams, so clips are chained pairwise instead,
        # a hard `concat=n=2` at a boundary with no transition and an
        # `xfade` at one with a resolved `transition_in`. `xfade`'s `offset`
        # is "where in the *combined* stream so far to start blending", so
        # `cumulative_s` tracks that running total - once any clip's own
        # duration is unbounded, it (and every boundary after it) falls back
        # to a hard cut rather than guessing at an offset.
        current_label = '[v0]'
        cumulative_s = clip_durations_s[0]
        for i in range(1, len(clips)):
            this_label = f'[v{i}]'
            transition = clips[i]['transition_in']
            out_label = f'[{concat_label}]' if i == len(clips) - 1 else f'[vjoin{i}]'
            if transition and cumulative_s is not None and clip_durations_s[i] is not None:
                offset_s = max(0.0, cumulative_s - transition['duration_s'])
                filter_parts.append(
                    f"{current_label}{this_label}xfade=transition={transition['type']}:"
                    f"duration={transition['duration_s']:.3f}:offset={offset_s:.3f}{out_label}",
                )
                cumulative_s = cumulative_s + clip_durations_s[i] - transition['duration_s']
            else:
                filter_parts.append(f"{current_label}{this_label}concat=n=2:v=1:a=0{out_label}")
                cumulative_s = (
                    None if cumulative_s is None or clip_durations_s[i] is None
                    else cumulative_s + clip_durations_s[i]
                )
            current_label = out_label
    audio_offset_s = plan.get('audio_offset_s')
    if audio_offset_s:
        # A test render's audio track is a slice of the full one, starting
        # `audio_offset_s` seconds in - `atrim` cuts it, `asetpts` resets the
        # cut's own timestamps back to zero (same reason the video `trim`
        # filter above is always followed by `setpts=(PTS-STARTPTS)/...`;
        # without it the muxed output would start with `audio_offset_s` of
        # silence instead of the trimmed content).
        filter_parts.append(f"[{audio_index}:a]atrim=start={audio_offset_s:.3f},asetpts=PTS-STARTPTS,apad[aout]")
    else:
        filter_parts.append(f"[{audio_index}:a]apad[aout]")

    if overlays:
        cur = f'[{concat_label}]'
        for i, overlay in enumerate(overlays):
            idx = overlay_base_index + i
            # Both scaled against the canvas's own *width* (`w`, not `h` for
            # `oh_px`) - `height_pct` is a percentage of canvas width, same
            # axis as `width_pct` (see `_migrate_overlay_position`'s
            # docstring), so their ratio always reproduces the overlay's real
            # pixel aspect ratio regardless of the canvas's own w:h shape. Not
            # aspect-locked to the *source image's* own aspect ratio though -
            # matches `CanvasLayer`'s free corner-resize, a deliberate
            # non-uniform stretch is still possible by design.
            ow_px = max(1, round(w * overlay['width_pct'] / 100))
            oh_px = max(1, round(w * overlay['height_pct'] / 100))
            rotation_deg = overlay['rotation_deg']
            x_px = w * overlay['x_pct'] / 100
            y_px = h * overlay['y_pct'] / 100
            # A video overlay's own stream starts decoding from its own
            # frame 0 the instant the whole ffmpeg process starts, in
            # lockstep with every other input - without this, by the time
            # the main timeline reaches `start_s` (when `enable=` below
            # first turns it on), the overlay video would already be
            # `start_s` seconds into its own playback instead of showing its
            # own first frame. Shifting its presentation timestamps forward
            # by `start_s` re-aligns "its own frame 0" with "the moment it
            # becomes visible". Meaningless for an image overlay (`-loop 1`
            # makes every frame identical), so only applied for `kind:
            # 'video'`.
            pre_filter = f"setpts=PTS+{overlay['start_s']:.3f}/TB," if overlay['kind'] == 'video' else ''
            if rotation_deg:
                # Rotates the overlay about its own *top-left* corner (not
                # its center) - exactly what Konva's `Group.rotation` does
                # for `CanvasLayer` (translate to `(x,y)` then rotate, offset
                # always `(0,0)` - see this module's own docstring). ffmpeg's
                # `rotate` filter only ever pivots around its input frame's
                # own center, so the trick is to first pad the scaled image
                # into a frame exactly twice its size with the image placed
                # in the bottom-right quadrant - that puts the image's own
                # top-left corner exactly at the padded frame's center, i.e.
                # the pivot `rotate` will actually use.
                rad = math.radians(rotation_deg)
                padded_w, padded_h = ow_px * 2, oh_px * 2
                rotw_px = max(1, round(abs(padded_w * math.cos(rad)) + abs(padded_h * math.sin(rad))))
                roth_px = max(1, round(abs(padded_w * math.sin(rad)) + abs(padded_h * math.cos(rad))))
                filter_parts.append(
                    f"[{idx}:v]{pre_filter}scale={ow_px}:{oh_px},format=rgba,"
                    f"pad={padded_w}:{padded_h}:{ow_px}:{oh_px}:color=0x00000000,"
                    f"rotate={rad:.6f}:ow={rotw_px}:oh={roth_px}:c=none,"
                    f"{_overlay_alpha_filters(overlay)}[ovl{i}]",
                )
                # The padded frame's center - our pivot, still exactly the
                # overlay's own top-left corner - stays fixed by `rotate`,
                # so it sits at the rotated output's own center too: placing
                # *that* at `(x_px, y_px)` is what keeps this pixel-for-pixel
                # aligned with what the live preview's `CanvasLayer` shows.
                x_expr = f'{round(x_px - rotw_px / 2)}'
                y_expr = f'{round(y_px - roth_px / 2)}'
            else:
                filter_parts.append(
                    f"[{idx}:v]{pre_filter}scale={ow_px}:{oh_px},format=rgba,{_overlay_alpha_filters(overlay)}[ovl{i}]",
                )
                x_expr = f'{round(x_px)}'
                y_expr = f'{round(y_px)}'
            end_s = overlay['start_s'] + overlay['duration_s']
            out_label = '[vout]' if i == len(overlays) - 1 else f'[vov{i}]'
            filter_parts.append(
                f"{cur}[ovl{i}]overlay=x={x_expr}:y={y_expr}:"
                f"enable='between(t,{overlay['start_s']:.3f},{end_s:.3f})'{out_label}",
            )
            cur = out_label

    cmd += [
        '-filter_complex', ';'.join(filter_parts),
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-c:a', 'aac',
        '-t', f"{plan['output_duration_s']:.3f}",
        str(dest_path),
    ]
    return cmd


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


def _run_ffmpeg_render(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0 and not result.stdout and not result.stderr:
        # ffmpeg.exe killed before it could write anything at all (observed
        # returncode 3221225794 / 0xC0000142 = STATUS_DLL_INIT_FAILED on
        # Windows) is a known antivirus real-time-scan pattern against a
        # freshly spawned process, not a real ffmpeg/filtergraph failure -
        # gone on a second try almost every time, so retry once before
        # treating it as a real error.
        time.sleep(1.0)
        result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors='replace').strip()
        stdout = result.stdout.decode(errors='replace').strip()
        detail = stderr or stdout or (
            'ffmpeg ничего не вывел, хотя завершился с ошибкой, и повторная попытка '
            'тоже не помогла - вероятно, процесс был прерван до запуска (например, '
            'антивирусом). Проверьте лог backend в терминале и добавьте ffmpeg.exe '
            'в исключения антивируса.'
        )
        console_log.log_error(
            'ffmpeg render',
            f'exit={result.returncode} cmd={" ".join(cmd)}\nstderr={stderr!r}\nstdout={stdout!r}',
        )
        raise RuntimeError(f'ffmpeg не смог собрать видео (код {result.returncode}): {detail[-400:]}')


async def render_to_file(
    project: dict, video_edit: dict, project_dir: Path, dest_path: Path, settings: dict | None = None,
    range_start_ms: float | None = None, range_end_ms: float | None = None,
) -> dict:
    if shutil.which('ffmpeg') is None:
        raise RuntimeError(
            'ffmpeg не найден в PATH - он нужен, чтобы собрать финальное видео. '
            'Установите ffmpeg (ffmpeg.org) и перезапустите backend.',
        )
    plan = build_render_plan(project, video_edit, settings)
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
