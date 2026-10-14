import { describe, expect, it } from 'vitest';
import {
  EMPTY_WATCHING,
  endedWatchedLives,
  focusWatched,
  pruneWatching,
  resetWatching,
  unwatch,
  watch,
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

  it('adds the live at the end of the list and focuses it', () => {
    const one = watch(EMPTY_WATCHING, 'ana');
    expect(one).toEqual(state(['ana'], 'ana'));
    const two = watch(one, 'beto');
    expect(two).toEqual(state(['ana', 'beto'], 'beto'));
  });

  it('only refocuses a live that is already watched (no duplicates)', () => {
    expect(watch(state(['ana', 'beto'], 'beto'), 'ana')).toEqual(state(['ana', 'beto'], 'ana'));
  });

  it('returns the same state when the live is already watched and focused', () => {
    const current = state(['ana'], 'ana');
    expect(watch(current, 'ana')).toBe(current);
  });
});

describe('focusWatched', () => {
  it('switches the stage between watched lives', () => {
    expect(focusWatched(state(['ana', 'beto'], 'beto'), 'ana')).toEqual(
      state(['ana', 'beto'], 'ana'),
    );
  });

  it('never watches anything new', () => {
    const current = state(['ana'], 'ana');
    expect(focusWatched(current, 'carla')).toBe(current);
    expect(focusWatched(EMPTY_WATCHING, 'carla')).toBe(EMPTY_WATCHING);
  });
});

describe('unwatch', () => {
  it('removes a mini tile and keeps the focus', () => {
    expect(unwatch(state(['ana', 'beto', 'carla'], 'carla'), 'ana')).toEqual(
      state(['beto', 'carla'], 'carla'),
    );
  });

  it('hands the stage to the next watched live when the focused one is removed', () => {
    expect(unwatch(state(['ana', 'beto', 'carla'], 'beto'), 'beto')).toEqual(
      state(['ana', 'carla'], 'carla'),
    );
  });

  it('falls back to the previous watched live when the focused one was the last', () => {
    expect(unwatch(state(['ana', 'beto', 'carla'], 'carla'), 'carla')).toEqual(
      state(['ana', 'beto'], 'beto'),
    );
  });

  it('empties the stage when the last watched live is removed', () => {
    expect(unwatch(state(['ana'], 'ana'), 'ana')).toEqual(EMPTY_WATCHING);
  });

  it('ignores lives that are not watched', () => {
    const current = state(['ana'], 'ana');
    expect(unwatch(current, 'zoe')).toBe(current);
  });
});

describe('pruneWatching', () => {
  it('drops watched lives that ended and keeps the rest in order', () => {
    expect(pruneWatching(state(['ana', 'beto', 'carla'], 'carla'), ['carla', 'ana'])).toEqual(
      state(['ana', 'carla'], 'carla'),
    );
  });

  it('hands the stage over when the focused live ended', () => {
    expect(pruneWatching(state(['ana', 'beto', 'carla'], 'ana'), ['beto', 'carla'])).toEqual(
      state(['beto', 'carla'], 'beto'),
    );
  });

  it('hands the stage over past other lives that ended at the same time', () => {
    expect(pruneWatching(state(['ana', 'beto', 'carla', 'dani'], 'beto'), ['ana', 'dani'])).toEqual(
      state(['ana', 'dani'], 'dani'),
    );
  });

  it('empties the stage when every watched live ended', () => {
    expect(pruneWatching(state(['ana', 'beto'], 'beto'), [])).toEqual(EMPTY_WATCHING);
  });

  it('returns the same state when every watched live is still on', () => {
    const current = state(['ana', 'beto'], 'ana');
    expect(pruneWatching(current, ['ana', 'beto', 'carla'])).toBe(current);
  });

  it('never adds lives that were not chosen', () => {
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
