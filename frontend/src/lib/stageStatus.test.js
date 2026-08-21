import { describe, expect, it } from 'vitest';
import { nextIncompleteStage, stageName, stageProgress, STAGE_KEYS } from './stageStatus.js';

const EMPTY = { blocks: [], scenes: [] };

function scenes(specs) {
  return specs.map((s) => ({ images: s.images || [], videos: s.videos || [] }));
}

describe('stageProgress', () => {
  it('reports nothing as done on a brand-new project', () => {
    const done = STAGE_KEYS.filter((k) => stageProgress(k, EMPTY).status === 'completed');
    expect(done).toEqual([]);
  });

  it('does not claim lyrics is finished before any block exists', () => {
    expect(stageProgress('lyrics', EMPTY).status).toBe('pending');
    expect(stageProgress('lyrics', { ...EMPTY, blocks: [{}, {}] })).toMatchObject({
      status: 'completed', counter: '2',
    });
  });

  it('blocks a stage on the one that feeds it, and names it', () => {
    expect(stageProgress('suno', EMPTY)).toMatchObject({ status: 'blocked', blockedBy: 'lyrics' });
    expect(stageProgress('images', { ...EMPTY, blocks: [{}] })).toMatchObject({ status: 'blocked', blockedBy: 'scenes' });
    expect(stageProgress('video', { blocks: [{}], scenes: scenes([{}, {}]) })).toMatchObject({
      status: 'blocked', blockedBy: 'images',
    });
  });

  it('counts partially-filled per-scene stages', () => {
    const project = { blocks: [{}], scenes: scenes([{ images: [{}] }, {}, {}]) };
    expect(stageProgress('images', project)).toMatchObject({ status: 'processing', counter: '1/3' });
  });

  it('completes a per-scene stage only when every scene has one', () => {
    const project = { blocks: [{}], scenes: scenes([{ images: [{}] }, { images: [{}] }]) };
    expect(stageProgress('images', project)).toMatchObject({ status: 'completed', counter: '2/2' });
  });

  it('treats export as partial until both a video and a picked track exist', () => {
    const withVideo = { blocks: [{}], scenes: scenes([{ images: [{}], videos: [{}] }]) };
    expect(stageProgress('export', withVideo).status).toBe('processing');
    const withBoth = { ...withVideo, mureka: { tracks: [{ is_selected: true }] } };
    expect(stageProgress('export', withBoth).status).toBe('completed');
  });

  it('marks the editor done only once a render exists', () => {
    const base = { blocks: [{}], scenes: scenes([{ images: [{}], videos: [{}] }]) };
    expect(stageProgress('editor', { ...base, video_edit: { clips: [{}] } }).status).toBe('processing');
    expect(stageProgress('editor', { ...base, video_edit: { clips: [{}], renders: [{}] } }).status).toBe('completed');
  });

  it('never blocks a stage that already has its own output', () => {
    // The Editor-timeline fixture is exactly this: videos and a track were
    // hand-authored without ever generating a scene image.
    const imported = { blocks: [{}], scenes: scenes([{ videos: [{}] }, { videos: [{}] }]) };
    expect(stageProgress('video', imported)).toMatchObject({ status: 'completed', counter: '2/2' });
    expect(stageProgress('title_card', { ...imported, title_card: { variants: [{}] } })).toMatchObject({
      status: 'completed', counter: '1',
    });
    expect(stageProgress('editor', { blocks: [{}], scenes: scenes([{}]), video_edit: { renders: [{}] } })).toMatchObject({
      status: 'completed',
    });
  });

  it('tolerates a project missing every optional collection', () => {
    expect(() => STAGE_KEYS.forEach((k) => stageProgress(k, {}))).not.toThrow();
  });
});

describe('nextIncompleteStage', () => {
  it('points at the first stage with work left', () => {
    expect(nextIncompleteStage(EMPTY)).toBe('lyrics');
    expect(nextIncompleteStage({ ...EMPTY, blocks: [{}] })).toBe('suno');
  });

  it('falls back to the last stage when everything is done', () => {
    const full = {
      blocks: [{}], style: 'x',
      scenes: scenes([{ images: [{}], videos: [{}] }]),
      mureka: { tracks: [{ is_selected: true }] },
      title_card: { variants: [{}] },
      video_edit: { clips: [{}], renders: [{}] },
    };
    expect(nextIncompleteStage(full)).toBe('editor');
  });
});

describe('stageName', () => {
  it('maps every stage key to a dictionary entry', () => {
    // `title_card` is `stage_titleCard`, so a built `'stage_' + key` lookup
    // silently misses exactly one stage.
    const L = {
      stage_lyrics: 'L', stage_suno: 'S', stage_mureka: 'M', stage_scenes: 'Sc',
      stage_images: 'I', stage_titleCard: 'T', stage_video: 'V', stage_export: 'E', stage_editor: 'Ed',
    };
    expect(STAGE_KEYS.map((k) => stageName(L, k))).toEqual(['L', 'S', 'M', 'Sc', 'I', 'T', 'V', 'E', 'Ed']);
  });
});
