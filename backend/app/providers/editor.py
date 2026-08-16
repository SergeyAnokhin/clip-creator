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

v1 supports reorder/trim/speed against a single audio track, static-image
overlays (title card variants / logos) on their own free-floating lane, a
crossfade/black/white transition at any clip boundary, and a per-clip
fade-in/fade-out (black or white) - no video-in-video yet. AI-generated clips
are silent by convention in this app, so the render is always muted-video +
Mureka-audio, never a mix of both.

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

An overlay entry in `video_edit['overlays']` is `{overlay_id, kind:
'title_card'|'logo', source_id, start_ms, duration_ms, position, width_pct,
opacity}` - `start_ms`/`duration_ms` are output-timeline coordinates (same
space as a clip's `startMs`/`durationMs` on the frontend), `position` is one
of the 9 `_OVERLAY_XY_EXPR` grid keys, `width_pct` scales the overlay to that
fraction of the canvas width (aspect preserved), `opacity` is 0-1 on top of
whatever alpha the source image already carries. Array order is z-order,
later entries painted on top - mirrors `Poster.layers`' array convention.

ffmpeg is invoked the same way `mureka.py`'s reference-audio trimmer does:
`subprocess.run` inside `asyncio.to_thread`, not
`asyncio.create_subprocess_exec` - the latter needs a Proactor event loop
that isn't guaranteed under `uvicorn --reload` on Windows (this repo's dev
environment) and has failed there before."""

import asyncio
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .. import console_log, storage

# Output canvas: a fixed size keeps the ffmpeg filter graph simple (every
# clip is scale+pad'd - letterboxed, never cropped - into the same frame)
# regardless of what resolution/aspect ratio each source clip was generated
# at. '9:16' only when *every* clip's own stored `aspect_ratio` says so -
# otherwise landscape, since a mixed timeline needs one canvas either way and
# most generated footage in this app defaults to landscape.
_DEFAULT_CANVAS = (1920, 1080)
_PORTRAIT_CANVAS = (1080, 1920)
_FPS = 30

# The 9-point placement grid an overlay can sit at, each resolved (given the
# canvas's own edge margins in px) to an ffmpeg `overlay=x=…:y=…` expression
# in terms of that filter's own `main_w`/`main_h`/`overlay_w`/`overlay_h`
# variables - doubles as the validation set for `position`.
_OVERLAY_XY_EXPR = {
    'top-left': lambda mx, my: (f'{mx}', f'{my}'),
    'top-center': lambda mx, my: ('(main_w-overlay_w)/2', f'{my}'),
    'top-right': lambda mx, my: (f'main_w-overlay_w-{mx}', f'{my}'),
    'center-left': lambda mx, my: (f'{mx}', '(main_h-overlay_h)/2'),
    'center': lambda mx, my: ('(main_w-overlay_w)/2', '(main_h-overlay_h)/2'),
    'center-right': lambda mx, my: (f'main_w-overlay_w-{mx}', '(main_h-overlay_h)/2'),
    'bottom-left': lambda mx, my: (f'{mx}', f'main_h-overlay_h-{my}'),
    'bottom-center': lambda mx, my: ('(main_w-overlay_w)/2', f'main_h-overlay_h-{my}'),
    'bottom-right': lambda mx, my: (f'main_w-overlay_w-{mx}', f'main_h-overlay_h-{my}'),
}
_OVERLAY_MARGIN_PCT = 0.03
_OVERLAY_DEFAULT_WIDTH_PCT = 20.0

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


def _resolve_overlay_source(project: dict, settings: dict, overlay: dict) -> str:
    """The overlay image's `file_path` - project-relative for a title card
    variant (joined against `project_dir` in `build_ffmpeg_command`, same
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
    raise RenderPlanError(f'Оверлей: неизвестный тип {kind!r}')


def _resolve_overlays(project: dict, settings: dict, video_edit: dict) -> list[dict]:
    resolved = []
    for overlay in video_edit.get('overlays') or []:
        file_path = _resolve_overlay_source(project, settings, overlay)
        duration_ms = overlay.get('duration_ms') or 0
        if duration_ms <= 0:
            raise RenderPlanError('Оверлей: некорректная длительность')
        start_ms = max(0, overlay.get('start_ms') or 0)
        position = overlay.get('position')
        if position not in _OVERLAY_XY_EXPR:
            position = 'bottom-right'
        width_pct = min(100.0, max(1.0, overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT))
        opacity = overlay.get('opacity')
        opacity = 1.0 if opacity is None else min(1.0, max(0.0, opacity))
        resolved.append({
            'file_path': file_path,
            'start_s': start_ms / 1000,
            'duration_s': duration_ms / 1000,
            'position': position,
            'width_pct': width_pct,
            'opacity': opacity,
        })
    return resolved


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
        if video.get('aspect_ratio') != '9:16':
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

    width, height = _PORTRAIT_CANVAS if all_portrait else _DEFAULT_CANVAS
    return {
        'clips': resolved_clips,
        'overlays': _resolve_overlays(project, settings or {}, video_edit),
        'audio_file_path': track['file_path'],
        'audio_duration_s': audio_duration_s,
        'target_width': width,
        'target_height': height,
        'output_duration_s': audio_duration_s,
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
        # `-loop 1` turns the still image into an infinite stream, so the
        # `overlay` filter below has frames for as long as its own
        # `enable='between(...)'` window stays true - bounded by the whole
        # command's final `-t`, not by the image input itself.
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
        chain = (
            f"[{i}:v]trim=start={clip['trim_start_s']:.3f}{trim_end_part},"
            f"setpts=(PTS-STARTPTS)/{clip['speed']:.4f},"
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
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
    filter_parts.append(f"[{audio_index}:a]apad[aout]")

    if overlays:
        margin_x = round(w * _OVERLAY_MARGIN_PCT)
        margin_y = round(h * _OVERLAY_MARGIN_PCT)
        cur = f'[{concat_label}]'
        for i, overlay in enumerate(overlays):
            idx = overlay_base_index + i
            ow_px = max(1, round(w * overlay['width_pct'] / 100))
            # `-2` (not `-1`) forces an even auto-height regardless of the
            # source image's own aspect - odd dimensions here have been
            # observed to trip up some ffmpeg builds' rgba scalers.
            filter_parts.append(
                f"[{idx}:v]scale={ow_px}:-2,format=rgba,colorchannelmixer=aa={overlay['opacity']:.3f}[ovl{i}]",
            )
            x_expr, y_expr = _OVERLAY_XY_EXPR[overlay['position']](margin_x, margin_y)
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


def _run_ffmpeg_render(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors='replace').strip()
        stdout = result.stdout.decode(errors='replace').strip()
        detail = stderr or stdout or (
            'ffmpeg ничего не вывел, хотя завершился с ошибкой - вероятно, процесс '
            'был прерван до запуска (например, антивирусом). Проверьте лог backend '
            'в терминале и попробуйте ещё раз.'
        )
        console_log.log_error(
            'ffmpeg render',
            f'exit={result.returncode} cmd={" ".join(cmd)}\nstderr={stderr!r}\nstdout={stdout!r}',
        )
        raise RuntimeError(f'ffmpeg не смог собрать видео (код {result.returncode}): {detail[-400:]}')


async def render_to_file(
    project: dict, video_edit: dict, project_dir: Path, dest_path: Path, settings: dict | None = None,
) -> dict:
    if shutil.which('ffmpeg') is None:
        raise RuntimeError(
            'ffmpeg не найден в PATH - он нужен, чтобы собрать финальное видео. '
            'Установите ffmpeg (ffmpeg.org) и перезапустите backend.',
        )
    plan = build_render_plan(project, video_edit, settings)
    cmd = build_ffmpeg_command(plan, project_dir, dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(_run_ffmpeg_render, cmd)
    return {'duration_ms': int(plan['output_duration_s'] * 1000), 'clip_count': len(plan['clips'])}


async def _run_render_job(job_id: str, slug: str) -> None:
    try:
        project = storage.load_project(slug)
        if project is None:
            raise RuntimeError('Проект не найден')
        video_edit = project.get('video_edit') or {}
        settings = storage.load_settings()
        render_id = f'rnd_{uuid4().hex[:8]}'
        project_dir = storage.project_dir(slug)
        dest_path = project_dir / 'editor' / f'{render_id}.mp4'
        result = await render_to_file(project, video_edit, project_dir, dest_path, settings)

        render_entry = {
            'render_id': render_id,
            'file_path': f'editor/{render_id}.mp4',
            'created_at': _now(),
            'duration_ms': result['duration_ms'],
            'clip_count': result['clip_count'],
            'mureka_track_id': video_edit.get('mureka_track_id'),
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


def start_render_job(slug: str) -> str:
    job_id = uuid4().hex
    _jobs[job_id] = {'status': 'pending', 'render': None, 'error': None}
    asyncio.create_task(_run_render_job(job_id, slug))
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
