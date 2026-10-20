import { describe, expect, it } from 'vitest';
import { computeStageLayout, type StageLayoutInput } from './stageLayout';

const base: StageLayoutInput = {
  liveKeys: [],
  watchedKeys: [],
  focusedKey: null,
  elsewhereKeys: [],
  localScreen: false,
  localCamera: false,
  fullscreen: false,
};

const layout = (input: Partial<StageLayoutInput>) => computeStageLayout({ ...base, ...input });

const tile = (key: string, elsewhere = false) => ({ key, elsewhere });

describe('computeStageLayout: destaque', () => {
  it('puts the focused stream on the stage and the rest in the strip, previews first', () => {
    const result = layout({
      liveKeys: ['ana', 'ana#camera', 'beto', 'carla'],
      watchedKeys: ['ana', 'ana#camera', 'carla'],
      focusedKey: 'carla',
      localScreen: true,
      localCamera: true,
    });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('carla') });
    expect(result.strip).toEqual([
      { kind: 'local', source: 'screen' },
      { kind: 'local', source: 'camera' },
      { kind: 'mini', tile: tile('ana') },
      { kind: 'mini', tile: tile('ana#camera') },
      { kind: 'card', key: 'beto' },
    ]);
    expect(result.cards).toEqual(['beto']);
    expect(result.effectiveFocus).toBe('carla');
    expect(result.canShowGrid).toBe(true);
  });

  it('can put a camera in destaque', () => {
    const result = layout({
      liveKeys: ['ana', 'ana#camera'],
      watchedKeys: ['ana', 'ana#camera'],
      focusedKey: 'ana#camera',
    });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('ana#camera') });
    expect(result.strip).toEqual([{ kind: 'mini', tile: tile('ana') }]);
    expect(result.effectiveFocus).toBe('ana#camera');
  });

  it('offers no way back to the grid with a single watched stream', () => {
    const result = layout({ liveKeys: ['ana'], watchedKeys: ['ana'], focusedKey: 'ana' });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('ana') });
    expect(result.canShowGrid).toBe(false);
  });

  it('ignores a focused key that is no longer published (falls back to the grid)', () => {
    const result = layout({
      liveKeys: ['ana', 'beto'],
      watchedKeys: ['ana', 'beto', 'zoe'],
      focusedKey: 'zoe',
    });
    expect(result.main).toEqual({ kind: 'grid', tiles: [tile('ana'), tile('beto')], slot: false });
    expect(result.canShowGrid).toBe(false);
  });

  it('keeps a stream shown by another window in place, as a notice', () => {
    const result = layout({
      liveKeys: ['ana', 'ana#camera', 'beto'],
      watchedKeys: ['ana', 'ana#camera', 'beto'],
      focusedKey: 'ana',
      elsewhereKeys: ['ana', 'ana#camera'],
    });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('ana', true) });
    expect(result.strip).toEqual([
      { kind: 'mini', tile: tile('ana#camera', true) },
      { kind: 'mini', tile: tile('beto') },
    ]);
    // Nothing plays big in this window: M and the header's pop-out have no target.
    expect(result.effectiveFocus).toBeNull();
  });
});

describe('computeStageLayout: single stream and grid', () => {
  it('shows a single watched stream big, previews and cards in the strip', () => {
    const result = layout({
      liveKeys: ['ana', 'beto'],
      watchedKeys: ['ana'],
      localCamera: true,
    });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('ana') });
    expect(result.strip).toEqual([
      { kind: 'local', source: 'camera' },
      { kind: 'card', key: 'beto' },
    ]);
    expect(result.effectiveFocus).toBe('ana');
    expect(result.canShowGrid).toBe(false);
  });

  it('puts 2+ watched streams on the grid in watch order, other streams stay in the strip', () => {
    const result = layout({
      liveKeys: ['ana', 'beto', 'beto#camera', 'carla'],
      watchedKeys: ['carla', 'beto#camera'],
      localScreen: true,
    });
    expect(result.main).toEqual({
      kind: 'grid',
      tiles: [tile('carla'), tile('beto#camera')],
      slot: false,
    });
    expect(result.strip).toEqual([
      { kind: 'local', source: 'screen' },
      { kind: 'card', key: 'ana' },
      { kind: 'card', key: 'beto' },
    ]);
    expect(result.effectiveFocus).toBeNull();
    expect(result.canShowGrid).toBe(false);
  });

  it('adds the free slot when the count is odd', () => {
    const result = layout({
      liveKeys: ['ana', 'beto', 'carla'],
      watchedKeys: ['ana', 'beto', 'carla'],
    });
    expect(result.main).toEqual({
      kind: 'grid',
      tiles: [tile('ana'), tile('beto'), tile('carla')],
      slot: true,
    });
  });

  it('marks grid tiles shown by another window', () => {
    const result = layout({
      liveKeys: ['ana', 'beto'],
      watchedKeys: ['ana', 'beto'],
      elsewhereKeys: ['beto'],
    });
    expect(result.main).toEqual({
      kind: 'grid',
      tiles: [tile('ana'), tile('beto', true)],
      slot: false,
    });
  });

  it('skips watched keys that are no longer published', () => {
    const result = layout({ liveKeys: ['ana', 'beto'], watchedKeys: ['zoe', 'ana'] });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('ana') });
  });
});

describe('computeStageLayout: nothing watched', () => {
  it('puts your screen preview on the stage, the camera preview and the cards in the strip', () => {
    const result = layout({ liveKeys: ['ana'], localScreen: true, localCamera: true });
    expect(result.main).toEqual({ kind: 'local', source: 'screen' });
    expect(result.strip).toEqual([
      { kind: 'local', source: 'camera' },
      { kind: 'card', key: 'ana' },
    ]);
    expect(result.effectiveFocus).toBeNull();
  });

  it('falls back to your camera preview', () => {
    const result = layout({ liveKeys: ['ana#camera'], localCamera: true });
    expect(result.main).toEqual({ kind: 'local', source: 'camera' });
    expect(result.strip).toEqual([{ kind: 'card', key: 'ana#camera' }]);
  });

  it('shows the cards on the stage when you are not live', () => {
    const result = layout({ liveKeys: ['ana', 'ana#camera'] });
    expect(result.main).toEqual({ kind: 'cards' });
    expect(result.cards).toEqual(['ana', 'ana#camera']);
    expect(result.strip).toEqual([]);
  });

  it('is empty when nobody publishes anything', () => {
    const result = layout({});
    expect(result.main).toEqual({ kind: 'empty' });
    expect(result.strip).toEqual([]);
    expect(result.effectiveFocus).toBeNull();
  });
});

describe('computeStageLayout: fullscreen', () => {
  it('hides the strip and keeps the stage', () => {
    const result = layout({
      liveKeys: ['ana', 'beto'],
      watchedKeys: ['ana', 'beto'],
      focusedKey: 'beto',
      localScreen: true,
      fullscreen: true,
    });
    expect(result.main).toEqual({ kind: 'focus', tile: tile('beto') });
    expect(result.strip).toEqual([]);
    expect(result.canShowGrid).toBe(true);
  });
});
