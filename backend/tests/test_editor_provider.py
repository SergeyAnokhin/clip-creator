"""The Editor stage's runtime surface: `render_to_file`, the job store, and the
integration tests that shell out to a real `ffmpeg`. Plan resolution is covered
in `test_editor_plan.py`, command building in `test_editor_ffmpeg.py`."""

import asyncio
import shutil
import subprocess

import pytest

from app.providers import editor

from tests.editor_fixtures import _clip, _frame_rgb, _overlay, _project, _track, _video


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
