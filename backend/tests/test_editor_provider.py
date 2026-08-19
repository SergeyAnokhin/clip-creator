import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from app.providers import editor


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
          transition_in=None, fade_in=None, fade_out=None, fit=None):
    clip = {
        'scene_index': scene_index, 'video_id': video_id,
        'trim_start_ms': trim_start_ms, 'trim_end_ms': trim_end_ms, 'speed': speed, 'reverse': reverse,
    }
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


# ---------- build_render_plan ----------

def test_build_render_plan_happy_path():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['audio_file_path'] == 'music/trk_1.mp3'
    assert plan['output_duration_s'] == 8.0
    assert len(plan['clips']) == 1
    clip = plan['clips'][0]
    assert clip['trim_start_s'] == 0
    assert clip['trim_end_s'] == 4.0
    # 4s clip vs. an 8s track - the only clip absorbs the whole shortfall.
    assert clip['tpad_s'] == pytest.approx(4.0)


# ---------- build_render_plan clip.fit ----------

def test_build_render_plan_defaults_fit_to_centered_cover():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['fit'] == {'mode': 'cover', 'zoom': 1.0, 'offset_x_pct': 50.0, 'offset_y_pct': 50.0}


def test_build_render_plan_resolves_explicit_contain():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(fit={'mode': 'contain'})]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['fit'] == {'mode': 'contain'}


def test_build_render_plan_clamps_fit_zoom_and_offset():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(fit={'mode': 'cover', 'zoom': 50, 'offset_x_pct': -20, 'offset_y_pct': 200})],
    }

    plan = editor.build_render_plan(project, video_edit)

    fit = plan['clips'][0]['fit']
    assert fit['zoom'] == 4.0
    assert fit['offset_x_pct'] == 0.0
    assert fit['offset_y_pct'] == 100.0


def test_build_render_plan_speed_scales_effective_duration():
    project = _project(_video(duration_seconds=4), _track(duration_ms=4000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(speed=2.0)]}

    plan = editor.build_render_plan(project, video_edit)

    # 4s of source at 2x plays back in 2s, so a 4s track needs 2s of padding.
    assert plan['clips'][0]['tpad_s'] == pytest.approx(2.0)


def test_build_render_plan_resolves_reverse_flag():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(reverse=True)]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['reverse'] is True


def test_build_render_plan_defaults_reverse_to_false():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['reverse'] is False


def test_build_render_plan_no_padding_when_clips_cover_the_track():
    project = _project(_video(duration_seconds=8), _track(duration_ms=4000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['tpad_s'] == 0.0


def test_build_render_plan_portrait_canvas_when_every_clip_is_9_16():
    project = _project(_video(aspect_ratio='9:16'), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit)

    assert (plan['target_width'], plan['target_height']) == (1080, 1920)


def test_build_render_plan_landscape_canvas_by_default():
    project = _project(_video(aspect_ratio='16:9'), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit)

    assert (plan['target_width'], plan['target_height']) == (1920, 1080)


def test_build_render_plan_null_aspect_ratio_does_not_force_landscape():
    # A manually uploaded clip's aspect_ratio is always None (never probed -
    # see video.save_uploaded_video) - it shouldn't be treated as evidence
    # the clip is landscape.
    project = _project(_video(aspect_ratio=None), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit)

    assert (plan['target_width'], plan['target_height']) == (1080, 1920)


def test_build_render_plan_explicit_non_9_16_still_forces_landscape():
    project = {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('a', aspect_ratio=None)]}, {'videos': [_video('b', aspect_ratio='16:9')]}],
        'mureka': {'tracks': [_track()]},
    }
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(video_id='a'), _clip(scene_index=1, video_id='b')]}

    plan = editor.build_render_plan(project, video_edit)

    assert (plan['target_width'], plan['target_height']) == (1920, 1080)


def test_build_render_plan_canvas_orientation_override_forces_portrait():
    project = _project(_video(aspect_ratio='16:9'), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'canvas_orientation': 'portrait'}

    plan = editor.build_render_plan(project, video_edit)

    assert (plan['target_width'], plan['target_height']) == (1080, 1920)


def test_build_render_plan_canvas_orientation_override_forces_landscape():
    project = _project(_video(aspect_ratio='9:16'), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'canvas_orientation': 'landscape'}

    plan = editor.build_render_plan(project, video_edit)

    assert (plan['target_width'], plan['target_height']) == (1920, 1080)


def test_build_render_plan_rejects_empty_clips():
    project = _project(_video(), _track())
    with pytest.raises(editor.RenderPlanError, match='пуст'):
        editor.build_render_plan(project, {'mureka_track_id': 'trk_1', 'clips': []})


def test_build_render_plan_rejects_missing_track_id():
    project = _project(_video(), _track())
    with pytest.raises(editor.RenderPlanError, match='аудиотрек'):
        editor.build_render_plan(project, {'clips': [_clip()]})


def test_build_render_plan_rejects_unknown_track():
    project = _project(_video(), _track())
    with pytest.raises(editor.RenderPlanError, match='не найден'):
        editor.build_render_plan(project, {'mureka_track_id': 'nope', 'clips': [_clip()]})


def test_build_render_plan_rejects_unresolvable_scene():
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=5)]}
    with pytest.raises(editor.RenderPlanError, match='Сцена'):
        editor.build_render_plan(project, video_edit)


def test_build_render_plan_rejects_unresolvable_video_id():
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(video_id='nope')]}
    with pytest.raises(editor.RenderPlanError, match='не найдено'):
        editor.build_render_plan(project, video_edit)


def test_build_render_plan_unknown_duration_and_no_explicit_end_is_unbounded():
    # An imported/uploaded clip (video.save_uploaded_video) always has
    # duration_seconds: None - must not collapse to a zero-length clip.
    project = _project(_video(duration_seconds=None), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=None)]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['trim_end_s'] is None
    # can't know this clip's real length ahead of time - counted as 0 for
    # the padding estimate, same non-blocking approximation as everywhere
    # else this app already accepts duration mismatches.
    assert plan['clips'][0]['tpad_s'] == pytest.approx(8.0)


def test_build_render_plan_unknown_duration_with_explicit_end_still_works():
    project = _project(_video(duration_seconds=None), _track(duration_ms=4000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)]}

    plan = editor.build_render_plan(project, video_edit)

    assert plan['clips'][0]['trim_end_s'] == 4.0
    assert plan['clips'][0]['tpad_s'] == 0.0


def test_build_render_plan_rejects_bad_trim_range():
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_start_ms=2000, trim_end_ms=1000)]}
    with pytest.raises(editor.RenderPlanError, match='обрезка'):
        editor.build_render_plan(project, video_edit)


# ---------- build_render_plan overlays ----------

def test_build_render_plan_resolves_logo_overlay():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'name': 'L', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_overlay()]}

    plan = editor.build_render_plan(project, video_edit, settings)

    assert len(plan['overlays']) == 1
    ov = plan['overlays'][0]
    # A logo lives in the global cross-project library (under the data
    # root), not under any one project's own directory - the plan must carry
    # an *absolute* path so `build_ffmpeg_command` (which only ever joins
    # against `project_dir`) still resolves it correctly.
    assert Path(ov['file_path']).is_absolute()
    assert ov['file_path'].endswith('logo_1.png')
    assert ov['start_s'] == 0.0
    assert ov['duration_s'] == 2.0
    assert ov['x_pct'] == 80
    assert ov['y_pct'] == 80
    assert ov['width_pct'] == 20
    assert ov['height_pct'] == 20
    assert ov['rotation_deg'] == 0


def test_build_render_plan_resolves_title_card_overlay():
    project = _project(_video(), _track())
    project['title_card'] = {'variants': [{'variant_id': 'tcv_1', 'file_path': 'titlecard/tcv_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='title_card', source_id='tcv_1')],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    # Project-relative, same convention as a clip's own file_path.
    assert plan['overlays'][0]['file_path'] == 'titlecard/tcv_1.png'


def test_build_render_plan_resolves_video_overlay():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='video', source_id='ovv_1')],
        'overlay_video_sources': [{'id': 'ovv_1', 'file_path': 'editor/overlay_sources/ovv_1.mp4', 'duration_seconds': None}],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    ov = plan['overlays'][0]
    assert ov['kind'] == 'video'
    # Project-relative, same convention as a clip's own file_path - resolved
    # against `video_edit['overlay_video_sources']`, not `project`/`settings`
    # like the other two kinds.
    assert ov['file_path'] == 'editor/overlay_sources/ovv_1.mp4'


def test_build_render_plan_rejects_unknown_video_overlay_source():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='video', source_id='nope')],
        'overlay_video_sources': [],
    }
    with pytest.raises(editor.RenderPlanError, match='видео'):
        editor.build_render_plan(project, video_edit, {})


def test_build_render_plan_rejects_unknown_logo():
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_overlay(source_id='nope')]}
    with pytest.raises(editor.RenderPlanError, match='логотип'):
        editor.build_render_plan(project, video_edit, {'logos': []})


def test_build_render_plan_rejects_unknown_title_card_variant():
    project = _project(_video(), _track())
    project['title_card'] = {'variants': []}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='title_card', source_id='nope')],
    }
    with pytest.raises(editor.RenderPlanError, match='заголовка'):
        editor.build_render_plan(project, video_edit, {})


def test_build_render_plan_rejects_zero_duration_overlay():
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_overlay(duration_ms=0)]}
    with pytest.raises(editor.RenderPlanError, match='длительность'):
        editor.build_render_plan(project, video_edit, {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]})


def test_build_render_plan_clamps_out_of_range_size_and_opacity():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(width_pct=500, height_pct=500, opacity=5)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    assert ov['width_pct'] == 100.0
    assert ov['height_pct'] == 100.0
    assert ov['opacity'] == 1.0


def test_build_render_plan_resolves_overlay_fades():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(duration_ms=2000, fade_in_ms=300, fade_out_ms=500)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    assert ov['fade_in_s'] == pytest.approx(0.3)
    assert ov['fade_out_s'] == pytest.approx(0.5)


def test_build_render_plan_compresses_overlay_fades_that_would_outlast_it():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        # duration 1000ms, fade_in + fade_out = 1600ms > duration -> scaled by 1000/1600
        'overlays': [_overlay(duration_ms=1000, fade_in_ms=1000, fade_out_ms=600)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    assert ov['fade_in_s'] == pytest.approx(0.625)
    assert ov['fade_out_s'] == pytest.approx(0.375)


def test_build_render_plan_migrates_legacy_position_overlay():
    """An overlay saved before free x/y/w/h/rotation placement existed (only
    `position` + a bare `width_pct`) still resolves correctly - the render
    side needs its own fallback since such a document may never get reopened
    in the new frontend (which would otherwise migrate it on load)."""
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_legacy_overlay(position='top-left', width_pct=20)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    assert ov['x_pct'] == 0
    assert ov['y_pct'] == 0
    assert ov['width_pct'] == 20
    assert ov['height_pct'] == 20
    assert ov['rotation_deg'] == 0


def test_build_render_plan_migrates_pre_height_axis_overlay():
    """An overlay saved before `height_pct` was pinned to the canvas's own
    *width* (same axis as `width_pct` - see `_migrate_overlay_position`'s
    docstring) had it as a percentage of canvas *height* instead - resolving
    one now rescales it by `canvas_height/canvas_width` so its real pixel
    size doesn't jump the first time it's rendered after the convention
    changed."""
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    overlay = _overlay(height_pct=36)
    del overlay['height_axis']
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [overlay]}

    plan = editor.build_render_plan(project, video_edit, settings)

    # Default canvas here is landscape 1920x1080 (a 16:9 clip) - 36% of
    # height (1080) rescaled onto 20% of width (1920) is the same 388.8px.
    ov = plan['overlays'][0]
    assert ov['width_pct'] == 20
    assert ov['height_pct'] == pytest.approx(36 * 1080 / 1920)


def test_build_render_plan_migrates_legacy_bottom_right_overlay():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_legacy_overlay(position='bottom-right', width_pct=20)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    # "bottom-right" pins the overlay's own bottom-right corner to the point
    # - its top-left sits a full width/height back from it.
    assert ov['x_pct'] == 80
    assert ov['y_pct'] == 80


def test_build_render_plan_defaults_unknown_legacy_position():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_legacy_overlay(position='nowhere', width_pct=20)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    assert ov['x_pct'] == 80
    assert ov['y_pct'] == 80


# ---------- build_render_plan transitions & fades ----------

def _two_clip_project(duration_a=4, duration_b=4, track_duration_ms=8000):
    return {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('vid_a', duration_a)]}, {'videos': [_video('vid_b', duration_b)]}],
        'mureka': {'tracks': [_track(duration_ms=track_duration_ms)]},
    }


def test_build_render_plan_resolves_transition_and_shortens_padding_estimate():
    project = _two_clip_project(duration_a=4, duration_b=4, track_duration_ms=8000)
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a'),
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': 'dissolve', 'duration_ms': 1000}),
        ],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert plan['clips'][0]['transition_in'] is None
    assert plan['clips'][1]['transition_in'] == {'type': 'fade', 'duration_s': 1.0}
    # 4s + 4s of content, 1s of it overlapped by the transition -> 7s of real
    # output against an 8s track, so 1s of tail padding is needed (0 would be
    # wrong - that's what you'd get if the overlap weren't subtracted).
    assert plan['clips'][1]['tpad_s'] == pytest.approx(1.0)


def test_build_render_plan_clamps_transition_duration_to_the_shorter_neighbour():
    project = _two_clip_project(duration_a=2, duration_b=10, track_duration_ms=12000)
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a'),
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': 'fadeblack', 'duration_ms': 5000}),
        ],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert plan['clips'][1]['transition_in']['duration_s'] == pytest.approx(2.0)  # clamped to the 2s clip


def test_build_render_plan_ignores_unknown_transition_type():
    project = _two_clip_project()
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a'),
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': 'wipeleft', 'duration_ms': 500}),
        ],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert plan['clips'][1]['transition_in'] is None


def test_build_render_plan_resolves_fade_in_and_out():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(fade_in={'color': 'black', 'duration_ms': 500}, fade_out={'color': 'white', 'duration_ms': 750})],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    clip = plan['clips'][0]
    assert clip['fade_in'] == {'color': 'black', 'duration_s': 0.5}
    assert clip['fade_out'] == {'color': 'white', 'duration_s': 0.75}


def test_build_render_plan_clamps_fade_duration_and_defaults_a_bad_color():
    project = _project(_video(duration_seconds=2), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(fade_in={'color': 'purple', 'duration_ms': 9000})]}

    plan = editor.build_render_plan(project, video_edit, {})

    fade_in = plan['clips'][0]['fade_in']
    assert fade_in['duration_s'] == pytest.approx(2.0)  # can't fade longer than the clip itself
    assert fade_in['color'] == 'black'


# ---------- build_ffmpeg_command transitions & fades ----------

def test_build_ffmpeg_command_no_xfade_when_no_transitions():
    project = _two_clip_project()
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(scene_index=0, video_id='vid_a'), _clip(scene_index=1, video_id='vid_b')],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert 'xfade=' not in joined
    assert 'concat=n=2:v=1:a=0[vout]' in joined


def test_build_ffmpeg_command_transition_chain_shape():
    project = _two_clip_project(duration_a=4, duration_b=4, track_duration_ms=8000)
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a'),
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': 'fadeblack', 'duration_ms': 1000}),
        ],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    assert 'concat=' not in filter_complex
    # offset = clip A's own 4s duration minus the 1s transition.
    assert '[v0][v1]xfade=transition=fadeblack:duration=1.000:offset=3.000[vout]' in filter_complex


def test_build_ffmpeg_command_mixes_transitions_and_hard_cuts():
    project = {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('a', 4)]}, {'videos': [_video('b', 4)]}, {'videos': [_video('c', 4)]}],
        'mureka': {'tracks': [_track(duration_ms=12000)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='a'),
            _clip(scene_index=1, video_id='b', transition_in={'type': 'dissolve', 'duration_ms': 1000}),
            _clip(scene_index=2, video_id='c'),  # a plain hard cut into this one
        ],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    assert '[v0][v1]xfade=transition=fade:duration=1.000:offset=3.000[vjoin1]' in filter_complex
    assert '[vjoin1][v2]concat=n=2:v=1:a=0[vout]' in filter_complex


def test_build_ffmpeg_command_falls_back_to_a_cut_when_a_neighbour_is_unbounded():
    project = _two_clip_project()
    project['scenes'][0]['videos'][0]['duration_seconds'] = None  # unbounded first clip
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a', trim_end_ms=None),
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': 'dissolve', 'duration_ms': 1000}),
        ],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    assert 'xfade=' not in filter_complex
    assert 'concat=n=2:v=1:a=0[vout]' in filter_complex


def test_build_ffmpeg_command_fade_in_and_out_shape():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(fade_in={'color': 'black', 'duration_ms': 500}, fade_out={'color': 'white', 'duration_ms': 750})],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    assert 'fade=t=in:st=0:d=0.500:color=black' in filter_complex
    # content is 4s, fade-out is 0.75s in from the end - not from the tpad
    # freeze-tail this clip also gets (4s clip against an 8s track).
    assert 'fade=t=out:st=3.250:d=0.750:color=white' in filter_complex
    assert 'tpad=stop_mode=clone:stop_duration=4.000' in filter_complex


def test_build_ffmpeg_command_reverse_inserts_reverse_filter_after_setpts():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(reverse=True)]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert 'setpts=(PTS-STARTPTS)/1.0000,reverse,' in joined


def test_build_ffmpeg_command_no_reverse_filter_by_default():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert 'reverse' not in joined


# ---------- build_ffmpeg_command ----------

def test_build_ffmpeg_command_shape():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert cmd[0] == 'ffmpeg'
    assert str(Path('/proj/videos/vid_1.mp4')) in cmd
    assert str(Path('/proj/music/trk_1.mp3')) in cmd
    assert 'concat=n=1:v=1:a=0[vout]' in joined
    assert 'tpad=stop_mode=clone:stop_duration=4.000' in joined
    assert '-map' in cmd and '[vout]' in cmd and '[aout]' in cmd
    # never map a video input's own audio stream
    assert '0:a' not in joined
    assert '-t' in cmd
    assert cmd[cmd.index('-t') + 1] == '8.000'
    assert cmd[-1] == str(Path('/proj/editor/out.mp4'))


def test_build_ffmpeg_command_default_cover_fit_crops_with_no_pad():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert 'ceil(iw*max(1920/iw\\,1080/ih)*1.0000):ceil(ih*max(1920/iw\\,1080/ih)*1.0000)' in joined
    assert 'crop=1920:1080:(in_w-1920)*50.000/100:(in_h-1080)*50.000/100' in joined
    assert 'pad=' not in joined.split(',setsar=1')[0]


def test_build_ffmpeg_command_explicit_contain_fit_keeps_old_letterbox_chain():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(fit={'mode': 'contain'})]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    # Byte-for-byte the same chain this codebase used before `fit` existed -
    # a regression guard for clips that deliberately opt into letterboxing.
    assert 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2' in joined


def test_build_ffmpeg_command_cover_fit_with_zoom_and_offset():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(fit={'mode': 'cover', 'zoom': 2, 'offset_x_pct': 0, 'offset_y_pct': 100})],
    }
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert 'ceil(iw*max(1920/iw\\,1080/ih)*2.0000):ceil(ih*max(1920/iw\\,1080/ih)*2.0000)' in joined
    assert 'crop=1920:1080:(in_w-1920)*0.000/100:(in_h-1080)*100.000/100' in joined


def test_build_ffmpeg_command_omits_end_bound_for_unbounded_clip():
    project = _project(_video(duration_seconds=None), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=None)]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert 'trim=start=0.000,setpts=' in joined
    assert ':end=' not in joined


def test_build_ffmpeg_command_no_tpad_when_clips_cover_track():
    project = _project(_video(duration_seconds=8), _track(duration_ms=4000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)]}
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))

    assert 'tpad=' not in ' '.join(cmd)


def test_build_ffmpeg_command_multi_clip_concat_and_input_order():
    project = {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('vid_1', 4)]}, {'videos': [_video('vid_2', 4)]}],
        'mureka': {'tracks': [_track(duration_ms=8000)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(scene_index=0, video_id='vid_1'), _clip(scene_index=1, video_id='vid_2')],
    }
    plan = editor.build_render_plan(project, video_edit)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    assert cmd.index(str(Path('/proj/videos/vid_1.mp4'))) < cmd.index(str(Path('/proj/videos/vid_2.mp4')))
    assert cmd.index(str(Path('/proj/videos/vid_2.mp4'))) < cmd.index(str(Path('/proj/music/trk_1.mp3')))
    assert 'concat=n=2:v=1:a=0[vout]' in joined
    assert '[2:a]apad[aout]' in joined


# ---------- build_ffmpeg_command overlays ----------

def test_build_ffmpeg_command_no_overlay_chain_when_none_present():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    # Unchanged from before overlays existed - concat feeds [vout] directly.
    assert 'concat=n=1:v=1:a=0[vout]' in joined
    assert 'vbase' not in joined
    assert '-loop' not in cmd


def test_build_ffmpeg_command_overlay_chain_shape():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(
            start_ms=500, duration_ms=1500, x_pct=10, y_pct=5, width_pct=25, height_pct=25, opacity=0.5,
        )],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)

    # The overlay image is its own looped still-image input, added after
    # every clip and the audio track: [..., '-loop', '1', '-i', overlay_path].
    overlay_input_idx = cmd.index(str(Path(plan['overlays'][0]['file_path'])))
    assert cmd[overlay_input_idx - 3] == '-loop'
    assert cmd[overlay_input_idx - 2] == '1'
    assert cmd[overlay_input_idx - 1] == '-i'
    # concat now feeds an intermediate label, not [vout] directly.
    assert 'concat=n=1:v=1:a=0[vbase]' in joined
    # 25% of 1920 (canvas width) for *both* dimensions - width_pct/height_pct
    # share the canvas-width axis (see _migrate_overlay_position's docstring),
    # independently scaled (no forced source-aspect lock).
    assert 'scale=480:480,format=rgba,colorchannelmixer=aa=0.500' in joined
    # 10%/5% of 1920x1080, no rotation - plain top-left placement.
    assert 'overlay=x=192:y=54:' in joined
    assert "enable='between(t,0.500,2.000)'" in joined
    assert '[vout]' in joined  # the (only) overlay stage is the one that produces it
    assert '-map' in cmd and '[vout]' in cmd and '[aout]' in cmd


def test_build_ffmpeg_command_chains_multiple_overlays_in_order():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/a.png'}, {'id': 'logo_2', 'file_path': 'logos/b.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [
            _overlay(source_id='logo_1', x_pct=0, y_pct=0),
            _overlay(source_id='logo_2', x_pct=80, y_pct=80),
        ],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    # First overlay composites onto an intermediate label, the second (last)
    # one is the one that finally produces [vout].
    assert filter_complex.count('overlay=x=') == 2
    assert '[vbase][ovl0]overlay=' in filter_complex
    assert '[vov0][ovl1]overlay=' in filter_complex
    assert filter_complex.endswith('[vout]')


def test_build_ffmpeg_command_rotated_overlay_pads_and_rotates_before_compositing():
    """Rotation pivots around the overlay's own top-left corner (matching
    `CanvasLayer`'s Konva `Group` semantics - see `build_ffmpeg_command`'s
    own comment) via a pad-to-double-size-then-rotate trick, not ffmpeg's
    default center pivot."""
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(x_pct=50, y_pct=50, width_pct=20, height_pct=20, rotation_deg=90)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    # 20% of 1920 (canvas width) for *both* dimensions -> 384x384 (a square,
    # since width_pct/height_pct share the canvas-width axis); padded to
    # double (768x768, image placed at the pad offset 384,384 - its own
    # center); rotated 90 degrees, whose bounding box is the padded frame
    # with width/height swapped - unchanged here since it's already square.
    assert 'scale=384:384,format=rgba,pad=768:768:384:384:color=0x00000000' in filter_complex
    assert 'rotate=1.570796:ow=768:oh=768:c=none' in filter_complex
    # Pivot (the overlay's own top-left corner) at 50%/50% of 1920x1080 =
    # (960, 540); the rotated frame's center must land exactly there:
    # x = 960 - 768/2 = 576, y = 540 - 768/2 = 156.
    assert 'overlay=x=576:y=156:' in filter_complex


def test_build_ffmpeg_command_unrotated_overlay_has_no_pad_or_rotate_filter():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(x_pct=50, y_pct=50, rotation_deg=0)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]
    # Isolate the overlay's own filter segment - the main clip chain has its
    # own unrelated `pad=` (letterboxing), so asserting against the whole
    # `filter_complex` string would false-positive on that.
    overlay_segment = next(part for part in filter_complex.split(';') if '[ovl0]' in part)

    assert 'pad=' not in overlay_segment
    assert 'rotate=' not in overlay_segment
    assert 'overlay=x=960:y=540:' in filter_complex


def test_build_ffmpeg_command_video_overlay_input_is_not_looped():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='video', source_id='ovv_1', start_ms=1000, duration_ms=2000)],
        'overlay_video_sources': [{'id': 'ovv_1', 'file_path': 'editor/overlay_sources/ovv_1.mp4', 'duration_seconds': None}],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))

    overlay_input_idx = cmd.index(str(Path('/proj') / plan['overlays'][0]['file_path']))
    # A real video stream, not a looped still image - no `-loop 1` before it.
    assert cmd[overlay_input_idx - 2] != '-loop'
    assert cmd[overlay_input_idx - 1] == '-i'


def test_build_ffmpeg_command_video_overlay_shifts_pts_and_is_never_mapped_for_audio():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='video', source_id='ovv_1', start_ms=1500, duration_ms=2000)],
        'overlay_video_sources': [{'id': 'ovv_1', 'file_path': 'editor/overlay_sources/ovv_1.mp4', 'duration_seconds': None}],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    joined = ' '.join(cmd)
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    # Re-aligns the overlay video's own frame 0 with the moment it becomes
    # visible (1.5s into the main timeline) - see build_ffmpeg_command's own
    # comment on why this is needed only for a real video stream.
    assert 'setpts=PTS+1.500/TB,scale=' in filter_complex
    # Silent-overlay invariant - the overlay video's own audio stream (index
    # 2, after the one clip [0] and the audio track [1]) is never mapped.
    assert '2:a' not in joined


def test_build_ffmpeg_command_reversed_video_overlay_reverses_before_the_pts_shift():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(kind='video', source_id='ovv_1', start_ms=1500, duration_ms=2000, reverse=True)],
        'overlay_video_sources': [{'id': 'ovv_1', 'file_path': 'editor/overlay_sources/ovv_1.mp4', 'duration_seconds': None}],
    }
    plan = editor.build_render_plan(project, video_edit, {})

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    assert 'reverse,setpts=PTS+1.500/TB,scale=' in filter_complex


def test_build_ffmpeg_command_reverse_on_an_image_overlay_is_ignored():
    """`reverse: true` only ever means anything for `kind: 'video'` - an
    image overlay's `-loop 1` stream is infinite, so applying `reverse` to it
    would hang ffmpeg (the filter needs a stream with a real end to buffer).
    A stray `reverse: true` on a logo/title-card overlay (never settable
    through the UI, but not guarded against on the data side either) must be
    silently ignored, not passed through to the filtergraph."""
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(reverse=True)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    assert 'reverse' not in filter_complex


def test_build_ffmpeg_command_image_overlay_has_no_pts_shift():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(start_ms=1500)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]
    # Isolate the overlay's own filter segment - the main clip chain has its
    # own unrelated `setpts=` (speed), so asserting against the whole
    # `filter_complex` string would false-positive on that.
    overlay_segment = next(part for part in filter_complex.split(';') if '[ovl0]' in part)

    assert 'setpts=' not in overlay_segment


def test_build_ffmpeg_command_no_fade_keeps_flat_colorchannelmixer_only():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(opacity=0.75)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]

    # Byte-for-byte the same as before fades existed - no extra filter for
    # the (common) no-fade case.
    assert 'colorchannelmixer=aa=0.750[ovl0]' in filter_complex
    assert 'fade=' not in filter_complex


def test_build_ffmpeg_command_fade_in_and_out_chains_both_fade_filters():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(start_ms=1000, duration_ms=2000, opacity=0.8, fade_in_ms=300, fade_out_ms=500)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]
    overlay_segment = next(part for part in filter_complex.split(';') if '[ovl0]' in part)

    # start_s=1.0, end_s=3.0, fade_out_start=2.5 - colorchannelmixer sets the
    # flat base, each fade filter then multiplies alpha further by its ramp.
    assert 'colorchannelmixer=aa=0.800,fade=t=in:st=1.000:d=0.300:alpha=1,fade=t=out:st=2.500:d=0.500:alpha=1[ovl0]' in overlay_segment


def test_build_ffmpeg_command_fade_in_only_has_no_fade_out_filter():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(start_ms=0, duration_ms=2000, opacity=1.0, fade_in_ms=400, fade_out_ms=0)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]
    overlay_segment = next(part for part in filter_complex.split(';') if '[ovl0]' in part)

    assert 'colorchannelmixer=aa=1.000,fade=t=in:st=0.000:d=0.400:alpha=1[ovl0]' in overlay_segment
    assert 'fade=t=out' not in overlay_segment


def test_build_ffmpeg_command_fade_out_only_has_no_fade_in_filter():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo_1.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(start_ms=0, duration_ms=2000, opacity=1.0, fade_in_ms=0, fade_out_ms=400)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    cmd = editor.build_ffmpeg_command(plan, Path('/proj'), Path('/proj/editor/out.mp4'))
    filter_complex = cmd[cmd.index('-filter_complex') + 1]
    overlay_segment = next(part for part in filter_complex.split(';') if '[ovl0]' in part)

    assert 'colorchannelmixer=aa=1.000,fade=t=out:st=1.600:d=0.400:alpha=1[ovl0]' in overlay_segment
    assert 'fade=t=in' not in overlay_segment


# ---------- _trim_plan_to_range ----------

def test_trim_plan_to_range_fully_inside_one_clip():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)]}
    plan = editor.build_render_plan(project, video_edit)

    trimmed = editor._trim_plan_to_range(plan, 1000, 3000)

    assert len(trimmed['clips']) == 1
    c = trimmed['clips'][0]
    assert c['trim_start_s'] == pytest.approx(1.0)
    assert c['trim_end_s'] == pytest.approx(3.0)
    assert c['tpad_s'] == 0.0
    assert trimmed['output_duration_s'] == pytest.approx(2.0)
    assert trimmed['audio_offset_s'] == pytest.approx(1.0)


def test_trim_plan_to_range_spans_clip_boundary_drops_outside_clips_and_adjusts_both_edges():
    project = _two_clip_project(duration_a=4, duration_b=4, track_duration_ms=8000)
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a', trim_end_ms=4000),
            _clip(scene_index=1, video_id='vid_b', trim_end_ms=4000),
        ],
    }
    plan = editor.build_render_plan(project, video_edit)
    # clip 0 spans output [0,4000), clip 1 spans [4000,8000).
    trimmed = editor._trim_plan_to_range(plan, 3000, 5000)

    assert len(trimmed['clips']) == 2
    c0, c1 = trimmed['clips']
    assert c0['trim_start_s'] == pytest.approx(3.0)
    assert c0['trim_end_s'] == pytest.approx(4.0)
    assert c1['trim_start_s'] == pytest.approx(0.0)
    assert c1['trim_end_s'] == pytest.approx(1.0)
    assert trimmed['output_duration_s'] == pytest.approx(2.0)


def test_trim_plan_to_range_drops_clips_entirely_outside_it():
    project = {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('vid_a', 2)]}, {'videos': [_video('vid_b', 2)]}, {'videos': [_video('vid_c', 2)]}],
        'mureka': {'tracks': [_track(duration_ms=6000)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a', trim_end_ms=2000),
            _clip(scene_index=1, video_id='vid_b', trim_end_ms=2000),
            _clip(scene_index=2, video_id='vid_c', trim_end_ms=2000),
        ],
    }
    plan = editor.build_render_plan(project, video_edit)
    # Only clip 1 (output [2000,4000)) intersects [2500,3500).
    trimmed = editor._trim_plan_to_range(plan, 2500, 3500)

    assert len(trimmed['clips']) == 1
    assert trimmed['clips'][0]['file_path'] == 'videos/vid_b.mp4'


def test_trim_plan_to_range_pulls_start_back_to_keep_a_transition_on_the_boundary():
    """The frontend timeline draws clip 0/clip 1 back-to-back with the
    boundary at 4000 (see this module's own top docstring - it doesn't model
    the transition's overlap), so a range typed as "start at 4000" is the
    obvious way a user would try to preview the transition sitting on that
    boundary. Naively that would drop clip 0 (its real content ends exactly
    at 4000) and, with it, clip 1's incoming transition (nothing left to
    blend from) - `_trim_plan_to_range` must instead pull the effective start
    back to 3500 (where the transition's own blend actually begins) so both
    clips are kept and the transition still renders."""
    project = _two_clip_project(duration_a=4, duration_b=4, track_duration_ms=8000)
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a', trim_end_ms=4000),
            _clip(
                scene_index=1, video_id='vid_b', trim_end_ms=4000,
                transition_in={'type': 'dissolve', 'duration_ms': 500},
            ),
        ],
    }
    plan = editor.build_render_plan(project, video_edit)
    assert plan['clips'][1]['transition_in'] is not None  # sanity check on the untrimmed plan

    trimmed = editor._trim_plan_to_range(plan, 4000, 6000)

    assert len(trimmed['clips']) == 2
    assert trimmed['clips'][1]['transition_in'] is not None
    assert trimmed['clips'][0]['trim_start_s'] == pytest.approx(3.5)  # 4.0 - the 0.5s transition
    assert trimmed['audio_offset_s'] == pytest.approx(3.5)


def test_trim_plan_to_range_drops_overlay_fully_outside_it():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)],
        'overlays': [_overlay(start_ms=0, duration_ms=500)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    trimmed = editor._trim_plan_to_range(plan, 1000, 3000)

    assert trimmed['overlays'] == []


def test_trim_plan_to_range_shifts_and_clamps_a_partially_overlapping_overlay():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)],
        # Overlay spans [500, 2500) - the [1000,3000) range keeps only its
        # [1000,2500) slice.
        'overlays': [_overlay(start_ms=500, duration_ms=2000)],
    }
    plan = editor.build_render_plan(project, video_edit, settings)

    trimmed = editor._trim_plan_to_range(plan, 1000, 3000)

    assert len(trimmed['overlays']) == 1
    ov = trimmed['overlays'][0]
    assert ov['start_s'] == pytest.approx(0.0)  # shifted so the range's own start is the new zero
    assert ov['duration_s'] == pytest.approx(1.5)  # clamped to the overlay's own remaining span


def test_trim_plan_to_range_raises_when_nothing_intersects():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=4000)]}
    plan = editor.build_render_plan(project, video_edit)

    with pytest.raises(editor.RenderPlanError, match='диапазон'):
        editor._trim_plan_to_range(plan, 9000, 10000)


# ---------- render_to_file ----------

def test_render_to_file_missing_ffmpeg_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(editor.shutil, 'which', lambda _name: None)
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}
    with pytest.raises(RuntimeError, match='ffmpeg'):
        asyncio.run(editor.render_to_file(project, video_edit, tmp_path, tmp_path / 'editor' / 'out.mp4'))


# ---------- job store ----------

def test_start_render_job_success(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    slug = 'poem-a'
    videos_dir = storage.project_dir(slug) / 'videos'
    videos_dir.mkdir(parents=True)
    (videos_dir / 'vid_1.mp4').write_bytes(b'fake')
    music_dir = storage.project_dir(slug) / 'music'
    music_dir.mkdir(parents=True)
    (music_dir / 'trk_1.mp3').write_bytes(b'fake')
    storage.save_project(slug, _project(_video(), _track()) | {
        'video_edit': {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'renders': []},
    })

    async def fake_render_to_file(project, video_edit, project_dir, dest_path, settings=None, range_start_ms=None, range_end_ms=None):
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(b'rendered')
        return {'duration_ms': 8000, 'clip_count': 1}

    monkeypatch.setattr(editor, 'render_to_file', fake_render_to_file)

    async def scenario():
        job_id = editor.start_render_job(slug)
        for _ in range(200):
            job = editor.get_job(job_id)
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())

    assert job['status'] == 'completed'
    assert job['render']['clip_count'] == 1
    assert job['render']['duration_ms'] == 8000
    assert job['render']['kind'] == 'final'
    assert job['render']['range'] is None

    project = storage.load_project(slug)
    assert len(project['video_edit']['renders']) == 1
    assert project['video_edit']['renders'][0]['render_id'] == job['render']['render_id']


def test_start_render_job_with_range_tags_the_render_test(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    slug = 'poem-a'
    storage.save_project(slug, _project(_video(), _track()) | {
        'video_edit': {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'renders': []},
    })

    captured = {}

    async def fake_render_to_file(project, video_edit, project_dir, dest_path, settings=None, range_start_ms=None, range_end_ms=None):
        captured['range_start_ms'] = range_start_ms
        captured['range_end_ms'] = range_end_ms
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(b'rendered')
        return {'duration_ms': 1000, 'clip_count': 1}

    monkeypatch.setattr(editor, 'render_to_file', fake_render_to_file)

    async def scenario():
        job_id = editor.start_render_job(slug, 500, 1500)
        for _ in range(200):
            job = editor.get_job(job_id)
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())

    assert job['status'] == 'completed'
    assert job['render']['kind'] == 'test'
    assert job['render']['range'] == {'start_ms': 500, 'end_ms': 1500}
    assert captured == {'range_start_ms': 500, 'range_end_ms': 1500}


def test_start_render_job_failure(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    slug = 'poem-a'
    storage.save_project(slug, _project(_video(), _track()) | {
        'video_edit': {'mureka_track_id': 'trk_1', 'clips': [_clip()], 'renders': []},
    })

    async def failing_render_to_file(*args, **kwargs):
        raise RuntimeError('boom')

    monkeypatch.setattr(editor, 'render_to_file', failing_render_to_file)

    async def scenario():
        job_id = editor.start_render_job(slug)
        for _ in range(200):
            job = editor.get_job(job_id)
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())

    assert job['status'] == 'failed'
    assert 'boom' in job['error']


def test_get_job_unknown_id_returns_none():
    assert editor.get_job('does-not-exist') is None


# ---------- real ffmpeg integration ----------

@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_produces_output(tmp_path):
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    for name in ('a.mp4', 'b.mp4'):
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / name)],
            check=True, capture_output=True,
        )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('a', 2)]}, {'videos': [_video('b', 2)]}],
        'mureka': {'tracks': [_track(duration_ms=5000)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(scene_index=0, video_id='a'), _clip(scene_index=1, video_id='b')],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest))

    assert dest.is_file()
    assert dest.stat().st_size > 0
    assert result['clip_count'] == 2


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_range(tmp_path):
    """The audio track's own `atrim`/`asetpts` offset (`build_ffmpeg_command`,
    only added for a ranged/test render) is new filtergraph territory - a
    real run is the only thing that proves the syntax is valid and the
    output is actually shorter than a full render."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    for name in ('a.mp4', 'b.mp4'):
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / name)],
            check=True, capture_output=True,
        )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {
        'id': 'poem-a',
        'scenes': [{'videos': [_video('a', 2)]}, {'videos': [_video('b', 2)]}],
        'mureka': {'tracks': [_track(duration_ms=4000)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(scene_index=0, video_id='a'), _clip(scene_index=1, video_id='b')],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, range_start_ms=1000, range_end_ms=2000))

    assert dest.is_file()
    assert dest.stat().st_size > 0
    assert result['duration_ms'] == 1000
    assert result['clip_count'] == 1


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_overlay(tmp_path, monkeypatch):
    """The overlay filter graph (scale/format/colorchannelmixer/overlay with
    `enable='between(...)'`, chained after concat) is exactly the kind of
    thing that can look right as a string and still fail ffmpeg's own
    parser - only a real run proves the syntax is valid."""
    data_root = tmp_path / 'data'
    monkeypatch.setenv('APP_DATA_DIR', str(data_root))
    project_dir = data_root / 'projects' / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)
    logos_dir = data_root / 'logos'
    logos_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.5:s=20x20', '-frames:v', '1', str(logos_dir / 'logo.png')],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=0, video_id='a')],
        'overlays': [_overlay(start_ms=0, duration_ms=1000, x_pct=70, y_pct=5, width_pct=15, height_pct=15, opacity=0.7)],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, settings))

    assert dest.is_file()
    assert dest.stat().st_size > 0
    assert result['clip_count'] == 1


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_rotated_overlay(tmp_path, monkeypatch):
    """The pad/rotate/re-center filter chain for a rotated overlay
    (`build_ffmpeg_command`'s rotation branch) is the fiddliest new piece of
    filtergraph in this module - a real run is the only thing that proves
    the syntax is actually valid, not just plausible-looking."""
    data_root = tmp_path / 'data'
    monkeypatch.setenv('APP_DATA_DIR', str(data_root))
    project_dir = data_root / 'projects' / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)
    logos_dir = data_root / 'logos'
    logos_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.5:s=20x20', '-frames:v', '1', str(logos_dir / 'logo.png')],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=0, video_id='a')],
        'overlays': [_overlay(start_ms=0, duration_ms=1000, x_pct=50, y_pct=50, width_pct=15, height_pct=15, rotation_deg=37)],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, settings))

    assert dest.is_file()
    assert dest.stat().st_size > 0


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_faded_overlay(tmp_path, monkeypatch):
    """The conditional `colorchannelmixer=aa='...'` expression
    (`_overlay_alpha_expr`'s fade branch - nested `if`/`max`, escaped
    commas) is exactly the kind of thing that can look right as a string and
    still fail ffmpeg's own eval parser - only a real run proves it."""
    data_root = tmp_path / 'data'
    monkeypatch.setenv('APP_DATA_DIR', str(data_root))
    project_dir = data_root / 'projects' / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)
    logos_dir = data_root / 'logos'
    logos_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.5:s=20x20', '-frames:v', '1', str(logos_dir / 'logo.png')],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/logo.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=0, video_id='a')],
        'overlays': [_overlay(start_ms=0, duration_ms=1500, opacity=0.9, fade_in_ms=300, fade_out_ms=400)],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, settings))

    assert dest.is_file()
    assert dest.stat().st_size > 0


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_reversed_clip(tmp_path):
    """`reverse` buffers the whole trimmed clip and re-emits it frame-order-
    reversed (`build_ffmpeg_command`'s new `reverse,` filter, dropped in right
    after the speed/PTS-reset) - a real run is the only thing that proves the
    filter graph is actually valid, not just plausible-looking."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=0, video_id='a', reverse=True)]}
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest))

    assert dest.is_file()
    assert dest.stat().st_size > 0
    assert result['clip_count'] == 1


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_reversed_video_overlay(tmp_path):
    """Same real-run proof as the reversed-clip test above, but for a video
    overlay's own `reverse,` (placed before its frame-0 `setpts` realignment,
    not after - see `build_ffmpeg_command`'s comment on why the order
    matters)."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)
    overlay_sources_dir = project_dir / 'editor' / 'overlay_sources'
    overlay_sources_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )
    subprocess.run(
        [
            'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=2',
            '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
            '-shortest', str(overlay_sources_dir / 'ovv_1.mp4'),
        ],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=0, video_id='a')],
        'overlays': [_overlay(
            kind='video', source_id='ovv_1', start_ms=500, duration_ms=1000,
            x_pct=20, y_pct=20, width_pct=30, height_pct=30, reverse=True,
        )],
        'overlay_video_sources': [{'id': 'ovv_1', 'file_path': 'editor/overlay_sources/ovv_1.mp4', 'duration_seconds': None}],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, {}))

    assert dest.is_file()
    assert dest.stat().st_size > 0


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_video_overlay(tmp_path):
    """The video-overlay filter chain (a real second `-i`, the `setpts`
    frame-0 realignment, then the same scale/crop/rotate/overlay pipeline
    images use) is new filtergraph territory - a real run is the only thing
    that proves the syntax is actually valid."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)
    overlay_sources_dir = project_dir / 'editor' / 'overlay_sources'
    overlay_sources_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )
    subprocess.run(
        [
            'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=2',
            '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
            '-shortest', str(overlay_sources_dir / 'ovv_1.mp4'),
        ],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(scene_index=0, video_id='a')],
        'overlays': [_overlay(kind='video', source_id='ovv_1', start_ms=500, duration_ms=1000, x_pct=20, y_pct=20, width_pct=30, height_pct=30)],
        'overlay_video_sources': [{'id': 'ovv_1', 'file_path': 'editor/overlay_sources/ovv_1.mp4', 'duration_seconds': None}],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, {}))

    assert dest.is_file()
    assert dest.stat().st_size > 0


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_zoomed_cover_fit(tmp_path):
    """`_resolve_fit`'s `zoom`/offset feed into a `scale` expression built
    from `ceil`/`max` and an escaped comma (`build_ffmpeg_command`'s cover
    branch) - exactly the kind of expression that can be syntactically
    plausible and still fail ffmpeg's own eval parser, so only a real run
    proves it."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    # Non-square, non-canvas-aspect source (64x40) so the cover-crop chain's
    # scale+crop actually does something, not a no-op.
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x40:d=2', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}], 'mureka': {'tracks': [_track(duration_ms=2000)]}}
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(scene_index=0, video_id='a', fit={'mode': 'cover', 'zoom': 1.8, 'offset_x_pct': 25, 'offset_y_pct': 75})],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest))

    assert dest.is_file()
    assert dest.stat().st_size > 0


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_transition(tmp_path):
    """The pairwise xfade/concat chain (`build_ffmpeg_command`'s
    `has_transitions` branch) is new filter-graph plumbing distinct from the
    plain single-`concat` path every other test exercises - only a real run
    proves ffmpeg actually accepts it."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    for name, color in (('a.mp4', 'red'), ('b.mp4', 'blue')):
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', f'color=c={color}:s=64x64:d=2', str(videos_dir / name)],
            check=True, capture_output=True,
        )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.5', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {
        'id': 'poem-a', 'scenes': [{'videos': [_video('a', 2)]}, {'videos': [_video('b', 2)]}],
        'mureka': {'tracks': [_track(duration_ms=3500)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='a'),
            _clip(scene_index=1, video_id='b', transition_in={'type': 'dissolve', 'duration_ms': 500}),
        ],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest))

    assert dest.is_file()
    assert dest.stat().st_size > 0
    assert result['clip_count'] == 2


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_with_fade_in_out(tmp_path):
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=3', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {'id': 'poem-a', 'scenes': [{'videos': [_video('a', 3)]}], 'mureka': {'tracks': [_track(duration_ms=3000)]}}
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(
            scene_index=0, video_id='a',
            fade_in={'color': 'black', 'duration_ms': 500}, fade_out={'color': 'white', 'duration_ms': 500},
        )],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest))

    assert dest.is_file()
    assert dest.stat().st_size > 0


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


def test_probe_duration_ms_reads_a_real_file(tmp_path):
    if shutil.which('ffprobe') is None:
        pytest.skip('ffprobe not installed in this environment')
    path = tmp_path / 'a.mp4'
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2.5', str(path)],
        check=True, capture_output=True,
    )
    assert editor._probe_duration_ms(path) == pytest.approx(2500, abs=50)


def test_probe_duration_ms_returns_none_for_a_missing_file(tmp_path):
    assert editor._probe_duration_ms(tmp_path / 'does-not-exist.mp4') is None


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_build_render_plan_probes_an_unbounded_clip_only_when_project_dir_given(tmp_path):
    """The exact fallback every other test in this section exercises through
    a full render - isolated here at the `build_render_plan` level: omitting
    `project_dir` (every pre-existing caller) must keep leaving the clip
    unbounded, so this fix can't have silently changed behavior for the ~80
    other calls to this function throughout this file."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=3', str(videos_dir / 'a.mp4')],
        check=True, capture_output=True,
    )
    project = _project(_video('a', duration_seconds=None), _track(duration_ms=3000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(video_id='a', trim_end_ms=None)]}

    plan_without_probe = editor.build_render_plan(project, video_edit)
    assert plan_without_probe['clips'][0]['trim_end_s'] is None

    plan_with_probe = editor.build_render_plan(project, video_edit, project_dir=project_dir)
    assert plan_with_probe['clips'][0]['trim_end_s'] == pytest.approx(3.0, abs=0.1)


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_render_to_file_real_ffmpeg_transition_between_two_unbounded_clips(tmp_path):
    """The exact scenario that silently dropped every transition/fade_out in
    a real project (2026-08-19): both clips are `model: 'upload'` with
    `duration_seconds: None` and no explicit `trim_end_ms` - `xfade`'s
    `offset` can't be computed without a real duration for the clip the
    transition blends *into*, so `build_ffmpeg_command` fell back to a hard
    `concat` and the transition never rendered. `render_to_file` passing
    `project_dir` into `build_render_plan` now probes the real file as a
    fallback - checked here by sampling actual frames, not just checking the
    file exists, since a hard-cut fallback still produces a valid non-empty
    mp4."""
    project_dir = tmp_path / 'poem-a'
    videos_dir = project_dir / 'videos'
    videos_dir.mkdir(parents=True)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True)

    for name, color in (('a.mp4', 'red'), ('b.mp4', 'blue')):
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', f'color=c={color}:s=64x64:d=2', str(videos_dir / name)],
            check=True, capture_output=True,
        )
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.5', str(music_dir / 'trk_1.mp3')],
        check=True, capture_output=True,
    )

    project = {
        'id': 'poem-a',
        'scenes': [
            {'videos': [_video('a', duration_seconds=None)]},
            {'videos': [_video('b', duration_seconds=None)]},
        ],
        'mureka': {'tracks': [_track(duration_ms=3500)]},
    }
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='a', trim_end_ms=None),
            _clip(scene_index=1, video_id='b', trim_end_ms=None,
                  transition_in={'type': 'fadeblack', 'duration_ms': 500}),
        ],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest))

    # Clip 'a' is 2s red; the 500ms fadeblack transition blends [1.5, 2.0),
    # dipping through black early in that window (fadeblack ramps down to
    # black then back up, not a linear crossfade - the darkest frame sits
    # well before the window's midpoint).
    r0, g0, b0 = _frame_rgb(dest, 1.0)  # still plain red, before the blend
    assert r0 > 240 and g0 < 15 and b0 < 15, f'expected plain red, got {(r0, g0, b0)}'
    r, g, b = _frame_rgb(dest, 1.6)
    assert r < 60 and g < 60 and b < 60, f'expected a near-black blend frame, got {(r, g, b)}'
