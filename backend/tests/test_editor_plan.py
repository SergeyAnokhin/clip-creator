"""`editor_plan.build_render_plan` / `_trim_plan_to_range` - resolving an EDL
into a render plan. Tests that assert on the built ffmpeg command live in
`test_editor_ffmpeg.py`; the job store and the real-ffmpeg integration tests
live in `test_editor_provider.py`."""

import shutil
import subprocess
from pathlib import Path

import pytest

from app.providers import editor

from tests.editor_fixtures import _clip, _legacy_overlay, _overlay, _project, _text_overlay, _track, _two_clip_project, _video


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
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': 'nosuchtransition', 'duration_ms': 500}),
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


def test_audio_offset_is_clamped_inside_the_track():
    project = _project(_video(), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'audio': {'offset_ms': 999999},
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert plan['audio']['offset_s'] == pytest.approx(7.999)


def test_audio_fades_are_compressed_when_they_would_overlap():
    project = _project(_video(), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'audio': {'fade_in_ms': 6000, 'fade_out_ms': 6000},
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert plan['audio']['fade_in_s'] == pytest.approx(4.0)
    assert plan['audio']['fade_out_s'] == pytest.approx(4.0)


def test_test_range_reclamps_audio_fades_to_the_shorter_output():
    project = _project(_video(duration_seconds=8), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=8000)],
        'audio': {'fade_in_ms': 3000, 'fade_out_ms': 3000},
    }

    plan = editor.build_render_plan(project, video_edit, {})
    trimmed = editor._trim_plan_to_range(plan, 0, 2000)

    # 3s + 3s of fades cannot fit a 2s window - both are halved to 1s.
    assert trimmed['audio']['fade_in_s'] == pytest.approx(1.0)
    assert trimmed['audio']['fade_out_s'] == pytest.approx(1.0)


def test_default_valued_adjust_still_emits_no_filter():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(adjust={'brightness': 0, 'contrast': 1, 'saturation': 1, 'gamma': 1})],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert plan['clips'][0]['adjust'] is None


def test_adjust_values_are_clamped_to_ffmpeg_eq_ranges():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(adjust={'brightness': 9, 'contrast': 1, 'saturation': 99, 'gamma': 0})],
    }

    adjust = editor.build_render_plan(project, video_edit, {})['clips'][0]['adjust']

    assert adjust['brightness'] == 1.0
    assert adjust['saturation'] == 3.0
    assert adjust['gamma'] == pytest.approx(0.1)


def test_freeze_clip_still_contributes_its_full_window_to_the_timeline():
    project = _project(_video(duration_seconds=8), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(trim_start_ms=0, trim_end_ms=2000, freeze=True)],
    }

    plan = editor.build_render_plan(project, video_edit, {})

    # 2s of frozen frame + a 6s tail pad = the 8s track.
    assert plan['clips'][0]['tpad_s'] == pytest.approx(6.0)


def test_export_falls_back_on_unknown_preset_values():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'export': {'resolution': 'nope', 'fps': 137, 'quality': 'ultra'},
    }

    plan = editor.build_render_plan(project, video_edit, {})

    assert (plan['target_width'], plan['target_height']) == (1920, 1080)
    assert plan['fps'] == 30
    assert plan['crf'] == 18


def test_text_overlay_resolves_to_a_content_addressed_cache_path_without_disk():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_text_overlay()],
    }

    plan = editor.build_render_plan(project, video_edit, {})
    overlay = plan['overlays'][0]

    assert overlay['kind'] == 'text'
    assert overlay['file_path'].startswith('editor/text_cache/')
    assert overlay['file_path'].endswith('.png')


def test_text_overlay_path_changes_with_the_text_and_its_styling():
    project = _project(_video(), _track())

    def path_for(**kwargs):
        video_edit = {
            'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_text_overlay(**kwargs)],
        }
        return editor.build_render_plan(project, video_edit, {})['overlays'][0]['file_path']

    base = path_for()
    assert path_for() == base
    assert path_for(content='Другое') != base
    assert path_for(color='#ff0000') != base


def test_text_overlay_png_is_cached_not_redrawn(tmp_path):
    """The cache is content-addressed, so re-rendering an unchanged overlay
    must reuse the existing PNG rather than redraw it - proved here by
    replacing the file's bytes with a sentinel and checking they survive."""
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_text_overlay()],
    }

    plan = editor.build_render_plan(project, video_edit, {}, tmp_path)
    written = tmp_path / plan['overlays'][0]['file_path']
    written.write_bytes(b'sentinel')

    editor.build_render_plan(project, video_edit, {}, tmp_path)

    assert written.read_bytes() == b'sentinel'
    assert len(list((tmp_path / 'editor' / 'text_cache').iterdir())) == 1
