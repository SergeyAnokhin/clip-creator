"""Builders for the Editor-stage provider tests, shared by
`test_editor_plan.py`, `test_editor_ffmpeg.py` and
`test_editor_provider.py`."""

import subprocess



def _project(scene_video, track):
    return {
        'id': 'poem-a',
        'scenes': [{'videos': [scene_video]}],
        'mureka': {'tracks': [track]},
    }


def _video(video_id='vid_1', duration_seconds=4, aspect_ratio='16:9'):
    return {
        'video_id': video_id, 'file_path': f'videos/{video_id}.mp4',
        'aspect_ratio': aspect_ratio, 'duration_seconds': duration_seconds,
    }


def _track(track_id='trk_1', duration_ms=8000):
    return {'track_id': track_id, 'file_path': 'music/trk_1.mp3', 'duration_ms': duration_ms}


def _clip(scene_index=0, video_id='vid_1', trim_start_ms=0, trim_end_ms=None, speed=1.0, reverse=False,
          transition_in=None, fade_in=None, fade_out=None, fit=None, adjust=None, freeze=False):
    clip = {
        'scene_index': scene_index, 'video_id': video_id,
        'trim_start_ms': trim_start_ms, 'trim_end_ms': trim_end_ms, 'speed': speed, 'reverse': reverse,
    }
    if adjust is not None:
        clip['adjust'] = adjust
    if freeze:
        clip['freeze'] = True
    if transition_in is not None:
        clip['transition_in'] = transition_in
    if fade_in is not None:
        clip['fade_in'] = fade_in
    if fade_out is not None:
        clip['fade_out'] = fade_out
    if fit is not None:
        clip['fit'] = fit
    return clip


def _overlay(kind='logo', source_id='logo_1', start_ms=0, duration_ms=2000,
             x_pct=80, y_pct=80, width_pct=20, height_pct=20, rotation_deg=0, opacity=1.0,
             fade_in_ms=0, fade_out_ms=0, reverse=False):
    """`height_pct` is already in the current `height_axis: 'width'`
    convention (percentage of canvas width, same axis as `width_pct` - see
    `_migrate_overlay_position`'s docstring) - `test_build_render_plan_
    migrates_pre_height_axis_overlay` below covers the one-time rescale for
    an overlay saved before that convention existed."""
    return {
        'overlay_id': 'ov_1', 'kind': kind, 'source_id': source_id,
        'start_ms': start_ms, 'duration_ms': duration_ms,
        'x_pct': x_pct, 'y_pct': y_pct, 'width_pct': width_pct, 'height_pct': height_pct,
        'rotation_deg': rotation_deg, 'opacity': opacity,
        'fade_in_ms': fade_in_ms, 'fade_out_ms': fade_out_ms, 'height_axis': 'width', 'reverse': reverse,
    }


def _legacy_overlay(kind='logo', source_id='logo_1', start_ms=0, duration_ms=2000,
                     position='bottom-right', width_pct=20, opacity=1.0):
    """An overlay in the pre-free-placement shape (`position` + bare
    `width_pct`, no `x_pct`/`y_pct`/`height_pct`/`rotation_deg`) - for
    `_migrate_overlay_position` tests only."""
    return {
        'overlay_id': 'ov_1', 'kind': kind, 'source_id': source_id,
        'start_ms': start_ms, 'duration_ms': duration_ms,
        'position': position, 'width_pct': width_pct, 'opacity': opacity,
    }


# ---------- build_render_plan transitions & fades ----------

def _two_clip_project(duration_a=4, duration_b=4, track_duration_ms=8000):
    return {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('vid_a', duration_a)]}, {'videos': [_video('vid_b', duration_b)]}],
        'mureka': {'tracks': [_track(duration_ms=track_duration_ms)]},
    }


# ---------- unbounded-clip fallback (`_probe_duration_ms`) ----------
# A manually uploaded/imported clip's `Video.duration_seconds` is never
# probed at import time (see this module's own top docstring) - `trim_end_ms:
# None` + unknown source duration leaves a clip genuinely "unbounded" to
# `build_render_plan`. Without a real-file fallback, `xfade`'s `offset` and
# `fade_out`'s `st` (both absolute-seconds positions) can't be computed, so a
# transition or fade_out touching such a clip silently vanishes - confirmed
# against a real project where every clip was `model: 'upload'` (2026-08-19).

def _frame_rgb(video_path, t: float) -> tuple[int, int, int]:
    """Decodes one frame at time `t` to a single averaged pixel (`scale=1:1`)
    - cheap, exact way to check what a render actually looks like at a given
    moment, without eyeballing it by hand (see docs/architecture.md's
    "Conventions and gotchas")."""
    result = subprocess.run(
        ['ffmpeg', '-y', '-ss', f'{t:.3f}', '-i', str(video_path),
         '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        check=True, capture_output=True,
    )
    data = result.stdout
    assert len(data) >= 3, 'no frame decoded at this timestamp'
    return data[0], data[1], data[2]


# ---------------------------------------------------------------------------
# Audio settings (`video_edit.audio`) - volume / fades / offset
# ---------------------------------------------------------------------------

def _audio_chain(cmd):
    """The `[N:a]...[aout]` fragment out of a built filter_complex."""
    graph = cmd[cmd.index('-filter_complex') + 1]
    return next(part for part in graph.split(';') if part.endswith('[aout]'))


# ---------------------------------------------------------------------------
# Text overlays (`kind: 'text'`)
# ---------------------------------------------------------------------------

def _text_overlay(content='Привет', **style):
    return {
        'overlay_id': 'ov_txt', 'kind': 'text', 'source_id': None,
        'start_ms': 0, 'duration_ms': 2000,
        'x_pct': 10, 'y_pct': 10, 'width_pct': 40, 'height_pct': 10,
        'rotation_deg': 0, 'opacity': 1.0, 'fade_in_ms': 0, 'fade_out_ms': 0, 'height_axis': 'width',
        'text': {'content': content, **style},
    }
