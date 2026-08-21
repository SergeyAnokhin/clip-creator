"""`editor_ffmpeg.build_ffmpeg_command` - the filtergraph a resolved plan turns
into. Each test builds a real plan with `build_render_plan` first, so a change
on either side of that seam shows up here."""

from pathlib import Path

import pytest

from app.providers import editor

from tests.editor_fixtures import _audio_chain, _clip, _overlay, _project, _text_overlay, _track, _two_clip_project, _video


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


def test_audio_chain_is_unchanged_without_audio_settings():
    project = _project(_video(), _track())
    video_edit = {'mureka_track_id': 'trk_1', 'clips': [_clip()]}

    plan = editor.build_render_plan(project, video_edit, {})
    cmd = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))

    assert _audio_chain(cmd) == '[1:a]apad[aout]'


def test_audio_volume_fades_and_offset_reach_the_filter_chain():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip()],
        'audio': {'volume': 0.5, 'fade_in_ms': 1000, 'fade_out_ms': 2000, 'offset_ms': 3000},
    }

    plan = editor.build_render_plan(project, video_edit, {})
    chain = _audio_chain(editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4')))

    assert 'atrim=start=3.000' in chain
    assert 'asetpts=PTS-STARTPTS' in chain
    assert 'volume=0.500' in chain
    assert 'afade=t=in:st=0:d=1.000' in chain
    # Output is the 8s track, so the 2s fade-out starts at 6s.
    assert 'afade=t=out:st=6.000:d=2.000' in chain
    assert chain.endswith('apad[aout]')


def test_test_range_offset_adds_to_the_users_own_audio_offset():
    """The window offset of a test render and the user's own "start the song
    later" offset are different decisions - one must not replace the other."""
    project = _project(_video(duration_seconds=8), _track(duration_ms=8000))
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip(trim_end_ms=8000)],
        'audio': {'offset_ms': 2000},
    }

    plan = editor.build_render_plan(project, video_edit, {})
    trimmed = editor._trim_plan_to_range(plan, 1000, 4000)
    chain = _audio_chain(editor.build_ffmpeg_command(trimmed, Path('/p'), Path('/p/out.mp4')))

    assert 'atrim=start=3.000' in chain


# ---------------------------------------------------------------------------
# Per-clip colour correction (`clip.adjust`)
# ---------------------------------------------------------------------------

def test_no_eq_filter_without_colour_correction():
    project = _project(_video(), _track())
    plan = editor.build_render_plan(project, {'mureka_track_id': 'trk_1', 'clips': [_clip()]}, {})
    cmd = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))

    assert plan['clips'][0]['adjust'] is None
    assert 'eq=' not in cmd[cmd.index('-filter_complex') + 1]


def test_adjust_becomes_an_eq_filter_after_the_fit_chain():
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(adjust={'brightness': 0.1, 'contrast': 1.2, 'saturation': 0.5, 'gamma': 0.9})],
    }

    plan = editor.build_render_plan(project, video_edit, {})
    graph = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))[
        editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4')).index('-filter_complex') + 1
    ]

    assert 'eq=brightness=0.100:contrast=1.200:saturation=0.500:gamma=0.900' in graph
    assert graph.index('setsar=1') < graph.index('eq=brightness')


# ---------------------------------------------------------------------------
# Freeze frame (`clip.freeze`)
# ---------------------------------------------------------------------------

def test_freeze_clip_holds_one_frame_for_its_whole_window():
    project = _project(_video(duration_seconds=8), _track())
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [_clip(trim_start_ms=2000, trim_end_ms=4000, freeze=True)],
    }

    plan = editor.build_render_plan(project, video_edit, {})
    cmd = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))
    graph = cmd[cmd.index('-filter_complex') + 1]

    assert plan['clips'][0]['freeze'] is True
    # One frame at 30fps starting from the trim start...
    assert 'trim=start=2.000:end=2.033' in graph
    # ...cloned for the remaining 2s window minus that frame.
    assert 'tpad=stop_mode=clone:stop_duration=1.967' in graph


# ---------------------------------------------------------------------------
# Export settings (`video_edit.export`)
# ---------------------------------------------------------------------------

def test_export_defaults_keep_the_canvas_and_add_quality_flags():
    project = _project(_video(), _track())
    plan = editor.build_render_plan(project, {'mureka_track_id': 'trk_1', 'clips': [_clip()]}, {})
    cmd = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))

    assert (plan['target_width'], plan['target_height']) == (1920, 1080)
    assert plan['fps'] == 30
    assert cmd[cmd.index('-crf') + 1] == '18'
    assert cmd[cmd.index('-preset') + 1] == 'medium'


def test_export_resolution_scales_the_canvas_keeping_its_shape():
    project = _project(_video(aspect_ratio='9:16'), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()],
        'export': {'resolution': '4k', 'fps': 60, 'quality': 'low'},
    }

    plan = editor.build_render_plan(project, video_edit, {})
    cmd = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))

    # Portrait canvas (1080x1920) with 2160 on the short side.
    assert (plan['target_width'], plan['target_height']) == (2160, 3840)
    assert plan['fps'] == 60
    assert 'fps=60' in cmd[cmd.index('-filter_complex') + 1]
    assert cmd[cmd.index('-crf') + 1] == '28'
    assert cmd[cmd.index('-preset') + 1] == 'veryfast'


# ---------------------------------------------------------------------------
# Extended transition catalogue
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('kind', ['wipeleft', 'slideup', 'circleopen', 'radial', 'pixelize'])
def test_extended_transition_types_map_to_their_xfade_names(kind):
    project = _two_clip_project()
    video_edit = {
        'mureka_track_id': 'trk_1',
        'clips': [
            _clip(scene_index=0, video_id='vid_a'),
            _clip(scene_index=1, video_id='vid_b', transition_in={'type': kind, 'duration_ms': 500}),
        ],
    }

    plan = editor.build_render_plan(project, video_edit, {})
    cmd = editor.build_ffmpeg_command(plan, Path('/p'), Path('/p/out.mp4'))

    assert plan['clips'][1]['transition_in']['type'] == kind
    assert f'xfade=transition={kind}:' in cmd[cmd.index('-filter_complex') + 1]


def test_text_overlay_composites_through_the_normal_image_overlay_path(tmp_path):
    """A text overlay must add no new ffmpeg filter of its own - it becomes a
    PNG and rides the same `overlay=` chain every image overlay uses."""
    project = _project(_video(), _track())
    video_edit = {
        'mureka_track_id': 'trk_1', 'clips': [_clip()], 'overlays': [_text_overlay()],
    }

    plan = editor.build_render_plan(project, video_edit, {}, tmp_path)
    cmd = editor.build_ffmpeg_command(plan, tmp_path, tmp_path / 'out.mp4')
    graph = cmd[cmd.index('-filter_complex') + 1]

    assert 'drawtext' not in graph
    assert 'overlay=x=' in graph
    # `-loop 1` marks it as a still image input, same as a logo/title card.
    assert '-loop' in cmd
    # The real render writes the PNG, and it is a genuine RGBA image.
    written = tmp_path / plan['overlays'][0]['file_path']
    assert written.exists()
    from PIL import Image
    with Image.open(written) as image:
        assert image.mode == 'RGBA'
        assert image.width > 1 and image.height > 1
