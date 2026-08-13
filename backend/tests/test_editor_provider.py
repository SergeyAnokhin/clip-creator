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


def _clip(scene_index=0, video_id='vid_1', trim_start_ms=0, trim_end_ms=None, speed=1.0):
    return {
        'scene_index': scene_index, 'video_id': video_id,
        'trim_start_ms': trim_start_ms, 'trim_end_ms': trim_end_ms, 'speed': speed,
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

    async def fake_render_to_file(project, video_edit, project_dir, dest_path):
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
