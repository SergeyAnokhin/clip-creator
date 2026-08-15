import { describe, expect, it } from 'vitest';
import { bestMagicLayerGroup, makeMagicLayer, moveLayerInList, normalizeMagicLayers } from './posterLayers.js';

describe('makeMagicLayer', () => {
  it('carries its own source, unlike the constructor’s fixed image slots', () => {
    const layer = makeMagicLayer({ groupId: 'mg_1', index: 2, filePath: 'magic/mg_1/L2.png' });
    expect(layer.kind).toBe('magic');
    expect(layer.src).toEqual({ group_id: 'mg_1', index: 2, file_path: 'magic/mg_1/L2.png', is_background: false });
    expect(layer).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, crop: null });
    expect(layer.effects.opacity).toBe(1);
  });

  it('flags the inpainted background slice', () => {
    expect(makeMagicLayer({ groupId: 'mg_1', index: 0, filePath: 'a.png', isBackground: true }).src.is_background)
      .toBe(true);
  });
});

describe('normalizeMagicLayers', () => {
  it('reads a poster saved before this feature as having no magic layers', () => {
    expect(normalizeMagicLayers(undefined)).toEqual([]);
    expect(normalizeMagicLayers(null)).toEqual([]);
  });

  it('drops entries whose source did not survive', () => {
    expect(normalizeMagicLayers([{ id: 'a' }, { id: 'b', src: {} }])).toEqual([]);
  });

  it('backfills missing transform fields and keeps the source', () => {
    const [layer] = normalizeMagicLayers([
      { id: 'l_1', src: { group_id: 'mg_1', index: 1, file_path: 'magic/mg_1/L1.png' } },
    ]);
    expect(layer).toMatchObject({
      id: 'l_1', kind: 'magic', x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, crop: null,
      src: { group_id: 'mg_1', index: 1, file_path: 'magic/mg_1/L1.png', is_background: false },
    });
    expect(layer.effects.glow.enabled).toBe(false);
  });

  it('round-trips a saved transform', () => {
    const saved = {
      id: 'l_2', x: 40, y: -12, scaleX: 0.5, scaleY: 0.5, rotation: 15,
      crop: { x: 1, y: 2, width: 3, height: 4 },
      src: { group_id: 'mg_2', index: 0, file_path: 'magic/mg_2/L0.png', is_background: true },
    };
    expect(normalizeMagicLayers([saved])[0]).toMatchObject({
      x: 40, y: -12, scaleX: 0.5, scaleY: 0.5, rotation: 15,
      crop: { x: 1, y: 2, width: 3, height: 4 },
      src: { group_id: 'mg_2', index: 0, file_path: 'magic/mg_2/L0.png', is_background: true },
    });
  });
});

describe('bestMagicLayerGroup', () => {
  const groups = [
    { source_path: 'images/a.png', layers: [1, 2, 3] },
    { source_path: 'images/b.png', layers: [1, 2] },
    { source_path: 'images/a.png', layers: [1, 2, 3, 4] },
    { source_path: 'images/a.png', layers: [1, 2] },
  ];

  it('returns null when the source has no group', () => {
    expect(bestMagicLayerGroup(groups, 'images/none.png')).toBeNull();
    expect(bestMagicLayerGroup([], 'images/a.png')).toBeNull();
    expect(bestMagicLayerGroup(undefined, 'images/a.png')).toBeNull();
  });

  it('picks the group with the most layers among matching source_path', () => {
    expect(bestMagicLayerGroup(groups, 'images/a.png')).toBe(groups[2]);
    expect(bestMagicLayerGroup(groups, 'images/b.png')).toBe(groups[1]);
  });

  it('breaks a tie by recency (last match wins)', () => {
    const tied = [
      { source_path: 'images/a.png', layers: [1, 2, 3] },
      { source_path: 'images/a.png', layers: [1, 2, 3] },
    ];
    expect(bestMagicLayerGroup(tied, 'images/a.png')).toBe(tied[1]);
  });
});

describe('moveLayerInList', () => {
  const list = ['a', 'b', 'c'];

  it('swaps with the neighbour in the given direction', () => {
    expect(moveLayerInList(list, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveLayerInList(list, 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('returns the list unchanged at either end or for an unknown layer', () => {
    expect(moveLayerInList(list, 0, -1)).toBe(list);
    expect(moveLayerInList(list, 2, 1)).toBe(list);
    expect(moveLayerInList(list, -1, 1)).toBe(list);
  });
});
