import { describe, expect, it } from 'vitest';
import { buildDefaultClips, defaultMurekaTrackId } from './editorDefaults.js';

describe('buildDefaultClips', () => {
  it('returns one clip per scene with an is_selected video, in scene order', () => {
    const scenes = [
      { videos: [{ video_id: 'v1', is_selected: false }, { video_id: 'v2', is_selected: true }] },
      { videos: [{ video_id: 'v3', is_selected: true }] },
    ];
    const clips = buildDefaultClips(scenes);
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ scene_index: 0, video_id: 'v2', trim_start_ms: 0, trim_end_ms: null, speed: 1.0 });
    expect(clips[1]).toMatchObject({ scene_index: 1, video_id: 'v3' });
  });

  it('skips scenes with no is_selected video', () => {
    const scenes = [
      { videos: [{ video_id: 'v1', is_selected: false }] },
      { videos: [] },
      { videos: [{ video_id: 'v3', is_selected: true }] },
    ];
    const clips = buildDefaultClips(scenes);
    expect(clips).toHaveLength(1);
    expect(clips[0].scene_index).toBe(2);
  });

  it('gives every clip a unique clip_id', () => {
    const scenes = [
      { videos: [{ video_id: 'v1', is_selected: true }] },
      { videos: [{ video_id: 'v2', is_selected: true }] },
    ];
    const clips = buildDefaultClips(scenes);
    expect(clips[0].clip_id).not.toBe(clips[1].clip_id);
  });

  it('returns an empty array for no scenes', () => {
    expect(buildDefaultClips([])).toEqual([]);
    expect(buildDefaultClips(undefined)).toEqual([]);
  });
});

describe('defaultMurekaTrackId', () => {
  it('picks the is_selected track', () => {
    const tracks = [{ track_id: 't1', is_selected: false }, { track_id: 't2', is_selected: true }];
    expect(defaultMurekaTrackId(tracks)).toBe('t2');
  });

  it('returns null when nothing is selected', () => {
    expect(defaultMurekaTrackId([{ track_id: 't1', is_selected: false }])).toBeNull();
  });

  it('returns null for no tracks', () => {
    expect(defaultMurekaTrackId([])).toBeNull();
    expect(defaultMurekaTrackId(undefined)).toBeNull();
  });
});
