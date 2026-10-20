import { describe, expect, it } from 'vitest';
import {
  EMPTY_WATCHING,
  endedWatchedLives,
  focusWatched,
  pruneWatching,
  resetWatching,
  showGrid,
  unwatch,
  watch,
  watchAndFocus,
  type WatchingState,
} from './watching';

const state = (watched: string[], focused: string | null): WatchingState => ({
  watched,
  focused,
});

describe('watch', () => {
  it('starts from nothing watched', () => {
    expect(EMPTY_WATCHING).toEqual({ watched: [], focused: null });
    expect(resetWatching()).toEqual(EMPTY_WATCHING);
  });

  it('adds streams to the grid in the order they were picked', () => {
    const one = watch(EMPTY_WATCHING, 'ana');
    expect(one).toEqual(state(['ana'], null));
    const two = watch(one, 'beto#camera');
    expect(two).toEqual(state(['ana', 'beto#camera'], null));
  });

  it('also puts a screen share in destaque when one is already there', () => {
    expect(watch(state(['ana'], 'ana'), 'beto')).toEqual(state(['ana', 'beto'], 'beto'));
    expect(watch(state(['ana', 'beto'], 'beto'), 'ana')).toEqual(state(['ana', 'beto'], 'ana'));
  });

  it('never lets a camera take the destaque', () => {
    expect(watch(state(['ana'], 'ana'), 'beto#camera')).toEqual(
      state(['ana', 'beto#camera'], 'ana'),
    );
  });

  it('returns the same state when nothing changes (no duplicates)', () => {
    const grid = state(['ana', 'beto'], null);
    expect(watch(grid, 'ana')).toBe(grid);
    const focused = state(['ana'], 'ana');
    expect(watch(focused, 'ana')).toBe(focused);
    const camera = state(['ana', 'ana#camera'], 'ana');
    expect(watch(camera, 'ana#camera')).toBe(camera);
  });
});

describe('watchAndFocus', () => {
  it('watches and puts the live in destaque from the grid or from nothing', () => {
    expect(watchAndFocus(EMPTY_WATCHING, 'ana')).toEqual(state(['ana'], 'ana'));
    expect(watchAndFocus(state(['ana', 'beto'], null), 'carla')).toEqual(
      state(['ana', 'beto', 'carla'], 'carla'),
    );
  });

  it('only refocuses a stream that is already watched', () => {
    expect(watchAndFocus(state(['ana', 'beto'], null), 'ana')).toEqual(
      state(['ana', 'beto'], 'ana'),
    );
    const current = state(['ana'], 'ana');
    expect(watchAndFocus(current, 'ana')).toBe(current);
  });
});

describe('focusWatched', () => {
  it('puts a watched stream in destaque, cameras included', () => {
    expect(focusWatched(state(['ana', 'beto'], null), 'ana')).toEqual(
      state(['ana', 'beto'], 'ana'),
    );
    expect(focusWatched(state(['ana', 'beto#camera'], 'ana'), 'beto#camera')).toEqual(
      state(['ana', 'beto#camera'], 'beto#camera'),
    );
  });

  it('never watches anything new', () => {
    const current = state(['ana'], 'ana');
    expect(focusWatched(current, 'carla')).toBe(current);
    expect(focusWatched(EMPTY_WATCHING, 'carla')).toBe(EMPTY_WATCHING);
  });
});

describe('showGrid', () => {
  it('leaves destaque and keeps every watched stream', () => {
    expect(showGrid(state(['ana', 'beto'], 'beto'))).toEqual(state(['ana', 'beto'], null));
  });

  it('returns the same state when already on the grid', () => {
    const current = state(['ana', 'beto'], null);
    expect(showGrid(current)).toBe(current);
  });
});

describe('unwatch', () => {
  it('removes a stream and keeps the destaque', () => {
    expect(unwatch(state(['ana', 'beto', 'carla'], 'carla'), 'ana')).toEqual(
      state(['beto', 'carla'], 'carla'),
    );
  });

  it('goes back to the grid when the stream in destaque is removed (no handover)', () => {
    expect(unwatch(state(['ana', 'beto', 'carla'], 'beto'), 'beto')).toEqual(
      state(['ana', 'carla'], null),
    );
  });

  it('empties the stage when the last watched stream is removed', () => {
    expect(unwatch(state(['ana'], 'ana'), 'ana')).toEqual(EMPTY_WATCHING);
    expect(unwatch(state(['ana'], null), 'ana')).toEqual(EMPTY_WATCHING);
  });

  it('keeps a screen share when only the same person’s camera is removed', () => {
    expect(unwatch(state(['ana', 'ana#camera'], 'ana'), 'ana#camera')).toEqual(
      state(['ana'], 'ana'),
    );
  });

  it('ignores streams that are not watched', () => {
    const current = state(['ana'], 'ana');
    expect(unwatch(current, 'zoe')).toBe(current);
  });
});

describe('pruneWatching', () => {
  it('drops watched streams that ended and keeps the rest in order', () => {
    expect(
      pruneWatching(state(['ana', 'beto#camera', 'carla'], 'carla'), ['carla', 'ana']),
    ).toEqual(state(['ana', 'carla'], 'carla'));
  });

  it('goes back to the grid when the stream in destaque ended', () => {
    expect(pruneWatching(state(['ana', 'beto', 'carla'], 'ana'), ['beto', 'carla'])).toEqual(
      state(['beto', 'carla'], null),
    );
  });

  it('keeps camera keys that are still published', () => {
    const current = state(['ana#camera', 'beto'], 'beto');
    expect(pruneWatching(current, ['ana', 'ana#camera', 'beto'])).toBe(current);
  });

  it('empties the stage when every watched stream ended', () => {
    expect(pruneWatching(state(['ana', 'beto'], 'beto'), [])).toEqual(EMPTY_WATCHING);
  });

  it('returns the same state when every watched stream is still on', () => {
    const current = state(['ana', 'beto'], 'ana');
    expect(pruneWatching(current, ['ana', 'beto', 'carla'])).toBe(current);
  });

  it('never adds streams that were not chosen', () => {
    expect(pruneWatching(EMPTY_WATCHING, ['ana', 'beto'])).toBe(EMPTY_WATCHING);
  });
});

describe('endedWatchedLives', () => {
  it('reports watched lives that are no longer on the air', () => {
    expect(endedWatchedLives(['ana', 'bia'], new Set(['bia', 'caio']))).toEqual(['ana']);
  });

  it('is empty when every watched live is still on', () => {
    expect(endedWatchedLives(['ana'], new Set(['ana']))).toEqual([]);
    expect(endedWatchedLives([], new Set())).toEqual([]);
  });
});
