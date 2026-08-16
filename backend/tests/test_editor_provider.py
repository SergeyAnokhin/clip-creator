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


def _clip(scene_index=0, video_id='vid_1', trim_start_ms=0, trim_end_ms=None, speed=1.0,
          transition_in=None, fade_in=None, fade_out=None):
    clip = {
        'scene_index': scene_index, 'video_id': video_id,
        'trim_start_ms': trim_start_ms, 'trim_end_ms': trim_end_ms, 'speed': speed,
    }
    if transition_in is not None:
        clip['transition_in'] = transition_in
    if fade_in is not None:
        clip['fade_in'] = fade_in
    if fade_out is not None:
        clip['fade_out'] = fade_out
    return clip


def _overlay(kind='logo', source_id='logo_1', start_ms=0, duration_ms=2000, position='bottom-right',
             width_pct=20, opacity=1.0):
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


def test_build_render_plan_speed_scales_effective_duration():
    project = _project(_video(duration_seconds=4), _track(duration_ms=4000))
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip(speed=2.0)]}

    plan = editor.build_render_plan(project, video_edit)

    # 4s of source at 2x plays back in 2s, so a 4s track needs 2s of padding.
    assert plan['clips'][0]['tpad_s'] == pytest.approx(2.0)


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
    assert ov['position'] == 'bottom-right'
    assert ov['width_pct'] == 20


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


def test_build_render_plan_defaults_unknown_position_and_clamps_bounds():
    project = _project(_video(), _track())
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/l.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [_overlay(position='nowhere', width_pct=500, opacity=5)],
    }

    plan = editor.build_render_plan(project, video_edit, settings)

    ov = plan['overlays'][0]
    assert ov['position'] == 'bottom-right'
    assert ov['width_pct'] == 100.0
    assert ov['opacity'] == 1.0


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
        'overlays': [_overlay(start_ms=500, duration_ms=1500, position='top-left', width_pct=25, opacity=0.5)],
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
    assert "scale=480:-2,format=rgba,colorchannelmixer=aa=0.500" in joined  # 25% of 1920
    assert "enable='between(t,0.500,2.000)'" in joined
    assert '[vout]' in joined  # the (only) overlay stage is the one that produces it
    assert '-map' in cmd and '[vout]' in cmd and '[aout]' in cmd


def test_build_ffmpeg_command_chains_multiple_overlays_in_order():
    project = _project(_video(duration_seconds=4), _track(duration_ms=8000))
    settings = {'logos': [{'id': 'logo_1', 'file_path': 'logos/a.png'}, {'id': 'logo_2', 'file_path': 'logos/b.png'}]}
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'overlays': [
            _overlay(source_id='logo_1', position='top-left'),
            _overlay(source_id='logo_2', position='bottom-right'),
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

    async def fake_render_to_file(project, video_edit, project_dir, dest_path, settings=None):
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

    project = storage.load_project(slug)
    assert len(project['video_edit']['renders']) == 1
    assert project['video_edit']['renders'][0]['render_id'] == job['render']['render_id']


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
        'overlays': [_overlay(start_ms=0, duration_ms=1000, position='top-right', width_pct=15, opacity=0.7)],
    }
    dest = project_dir / 'editor' / 'out.mp4'

    result = asyncio.run(editor.render_to_file(project, video_edit, project_dir, dest, settings))

    assert dest.is_file()
    assert dest.stat().st_size > 0
    assert result['clip_count'] == 1


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
