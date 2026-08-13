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

v1 deliberately supports only reorder/trim/speed against a single audio
track - no filters, transitions, or overlays (kept out on purpose, not an
oversight - `EditorClip`/`build_ffmpeg_command` can grow those fields later
without a schema rewrite). AI-generated clips are silent by convention in
this app, so the render is always muted-video + Mureka-audio, never a mix of
both.

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


def build_render_plan(project: dict, video_edit: dict) -> dict:
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
        total_ms += effective_ms
        resolved_clips.append({
            'file_path': video['file_path'],
            'trim_start_s': trim_start_ms / 1000,
            'trim_end_s': trim_end_ms / 1000 if trim_end_ms is not None else None,
            'speed': speed,
            'tpad_s': 0.0,
        })

    pad_s = max(0.0, audio_duration_s - total_ms / 1000)
    if pad_s > 0:
        resolved_clips[-1]['tpad_s'] = pad_s

    width, height = _PORTRAIT_CANVAS if all_portrait else _DEFAULT_CANVAS
    return {
        'clips': resolved_clips,
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
    w, h = plan['target_width'], plan['target_height']

    cmd = ['ffmpeg', '-y']
    for clip in clips:
        cmd += ['-i', str(project_dir / clip['file_path'])]
    audio_index = len(clips)
    cmd += ['-i', str(project_dir / plan['audio_file_path'])]

    filter_parts = []
    labels = []
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
        if clip['tpad_s'] > 0:
            chain += f",tpad=stop_mode=clone:stop_duration={clip['tpad_s']:.3f}"
        chain += f"[{label}]"
        filter_parts.append(chain)
        labels.append(f'[{label}]')

    filter_parts.append(f"{''.join(labels)}concat=n={len(clips)}:v=1:a=0[vout]")
    filter_parts.append(f"[{audio_index}:a]apad[aout]")

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


async def render_to_file(project: dict, video_edit: dict, project_dir: Path, dest_path: Path) -> dict:
    if shutil.which('ffmpeg') is None:
        raise RuntimeError(
            'ffmpeg не найден в PATH - он нужен, чтобы собрать финальное видео. '
            'Установите ffmpeg (ffmpeg.org) и перезапустите backend.',
        )
    plan = build_render_plan(project, video_edit)
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
        render_id = f'rnd_{uuid4().hex[:8]}'
        project_dir = storage.project_dir(slug)
        dest_path = project_dir / 'editor' / f'{render_id}.mp4'
        result = await render_to_file(project, video_edit, project_dir, dest_path)

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
