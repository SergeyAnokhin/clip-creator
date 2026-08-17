import { describe, expect, it } from 'vitest';
import { resolveOverlaySource } from './overlaySource.js';

const L = { overlay_kindLogo: 'Логотип', overlay_kindTitleCard: 'Заголовок', overlay_sourceMissing: 'Источник удалён' };

describe('resolveOverlaySource', () => {
  it('resolves a logo against the global settings library, no project prefix', () => {
    const overlay = { kind: 'logo', source_id: 'logo_1' };
    const { src, label } = resolveOverlaySource(overlay, { logos: [{ id: 'logo_1', name: 'My logo', file_path: 'logos/l.png' }], L });
    expect(src).toContain('logos/l.png');
    expect(label).toBe('My logo');
  });

  it('resolves a title card variant under the project', () => {
    const overlay = { kind: 'title_card', source_id: 'tcv_1' };
    const { src, label } = resolveOverlaySource(overlay, {
      projectId: 'poem-a', titleCardVariants: [{ variant_id: 'tcv_1', file_path: 'titlecard/tcv_1.png' }], L,
    });
    expect(src).toContain('poem-a');
    expect(src).toContain('titlecard/tcv_1.png');
    expect(label).toBe(L.overlay_kindTitleCard);
  });

  it('resolves a video overlay against overlay_video_sources, under the project', () => {
    const overlay = { kind: 'video', source_id: 'ovv_1' };
    const { src, label } = resolveOverlaySource(overlay, {
      projectId: 'poem-a',
      overlayVideoSources: [{ id: 'ovv_1', file_path: 'editor/overlay_sources/ovv_1.mp4' }],
      L,
    });
    expect(src).toContain('poem-a');
    expect(src).toContain('editor/overlay_sources/ovv_1.mp4');
    expect(label).toBe('ovv_1.mp4');
  });

  it('returns a null src and the missing-source label for a dangling logo', () => {
    expect(resolveOverlaySource({ kind: 'logo', source_id: 'nope' }, { logos: [], L }))
      .toEqual({ src: null, label: L.overlay_sourceMissing });
  });

  it('returns a null src and the missing-source label for a dangling video source', () => {
    expect(resolveOverlaySource({ kind: 'video', source_id: 'nope' }, { overlayVideoSources: [], L }))
      .toEqual({ src: null, label: L.overlay_sourceMissing });
  });

  it('returns a null src and the missing-source label for a dangling title card variant', () => {
    expect(resolveOverlaySource({ kind: 'title_card', source_id: 'nope' }, { titleCardVariants: [], L }))
      .toEqual({ src: null, label: L.overlay_sourceMissing });
  });
});
