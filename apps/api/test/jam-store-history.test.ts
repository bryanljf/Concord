import { describe, expect, it, vi } from 'vitest';
import { JAM_HISTORY_MAX, jamPositionAt, type JamItem, type JamState } from '@concord/shared';
import { JamError } from '../src/jam/errors';
import {
  JAM_SEEK_TOLERANCE_MS,
  JamStore,
  withoutReadySongs,
  type JamStoreOptions,
  type JamUpdate,
} from '../src/jam/store';
import { FakeClock, track, VIDEO_A, VIDEO_B, VIDEO_C } from './jam-helpers';

function setup(options: JamStoreOptions = {}) {
  const clock = new FakeClock();
  let next = 0;
  const store = new JamStore({ now: clock.now, newId: () => `item-${++next}`, ...options });
  const updates: JamUpdate[] = [];
  store.subscribe((update) => updates.push(update));
  return { store, clock, updates };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    if (err instanceof JamError) return err.code;
    throw err;
  }
  return undefined;
}

/** Shorthand view of a room: the current item id and the queue as `id:status`. */
function shape(state: JamState): { current: string | null; queue: string[] } {
  return {
    current: state.current?.item.id ?? null,
    queue: state.queue.map((item) => `${item.id}:${item.status}`),
  };
}

/** Ids of a room's history, most recent first. */
function historyOf(store: JamStore, room = 'geral'): string[] {
  return (store.state(room).history ?? []).map((item) => item.id);
}

/** Queues ready songs in `geral` (item-1 plays). */
function queue(store: JamStore, videoIds: string[]): void {
  for (const videoId of videoIds) store.enqueue('geral', track(videoId), 'alice', true);
}

describe('JamStore seek', () => {
  it('moves the song playing for everyone, from the new position on', () => {
    const { store, clock, updates } = setup();
    queue(store, [VIDEO_A]);
    clock.advance(10_000);
    updates.length = 0;
    expect(store.seek('geral', 'item-1', 90_000)).toBe(true);
    expect(store.current('geral')).toMatchObject({ positionMs: 90_000, at: clock.time });
    expect(updates).toEqual([
      { type: 'jam_updated', state: store.state('geral'), serverTime: clock.time },
    ]);
    clock.advance(5_000);
    const current = store.current('geral');
    expect(current && jamPositionAt(current, clock.time)).toBe(95_000);
  });

  it('keeps a paused song paused at the new position', () => {
    const { store, clock } = setup();
    queue(store, [VIDEO_A]);
    clock.advance(10_000);
    store.pause('geral', 'bob');
    store.seek('geral', 'item-1', 60_000);
    clock.advance(30_000);
    const current = store.current('geral');
    expect(current).toMatchObject({ positionMs: 60_000, paused: true, pausedBy: 'bob' });
    expect(current && jamPositionAt(current, clock.time)).toBe(60_000);
  });

  it('clamps the position to the song', () => {
    const { store } = setup();
    store.enqueue('geral', track(VIDEO_A, { durationMs: 180_000 }), 'alice', true);
    store.seek('geral', 'item-1', 999_999);
    expect(store.current('geral')?.positionMs).toBe(180_000);
    store.seek('geral', 'item-1', -5);
    expect(store.current('geral')?.positionMs).toBe(0);
  });

  it('changes nothing within JAM_SEEK_TOLERANCE_MS of where the song already is', () => {
    const { store, clock, updates } = setup();
    queue(store, [VIDEO_A]);
    clock.advance(10_000);
    updates.length = 0;
    expect(store.seek('geral', 'item-1', 10_000 + JAM_SEEK_TOLERANCE_MS - 1)).toBe(false);
    expect(store.seek('geral', 'item-1', 10_000 - JAM_SEEK_TOLERANCE_MS + 1)).toBe(false);
    expect(store.seek('geral', 'item-1', Number.NaN)).toBe(false);
    expect(updates).toEqual([]);
    expect(store.seek('geral', 'item-1', 10_000 + JAM_SEEK_TOLERANCE_MS)).toBe(true);
  });

  it('seeks only the song still playing', () => {
    const { store } = setup();
    expect(code(() => store.seek('geral', 'item-1', 0))).toBe('stale');
    queue(store, [VIDEO_A, VIDEO_B]);
    expect(code(() => store.seek('geral', 'item-2', 5_000))).toBe('stale');
    expect(code(() => store.seek('jogos', 'item-1', 5_000))).toBe('stale');
  });
});

describe('JamStore history', () => {
  it('remembers the songs that ended or were skipped, most recent first', () => {
    const { store } = setup();
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_C, VIDEO_A]);
    store.finish('geral', 'item-1'); // played to the end
    store.skip('geral', 'item-2');
    store.remove('geral', 'item-3'); // the one playing: a skip
    expect(historyOf(store)).toEqual(['item-3', 'item-2', 'item-1']);
    expect(store.current('geral')?.item.id).toBe('item-4');
    expect(store.state('geral').history?.[0]).toMatchObject({
      status: 'ready',
      track: track(VIDEO_C),
    });
  });

  it('leaves out songs removed before they played and songs the bot gave up on', () => {
    const { store } = setup();
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_C]);
    store.remove('geral', 'item-3');
    store.finish('geral', 'item-1', 'failed');
    expect(historyOf(store)).toEqual([]);
    expect(store.current('geral')?.item.id).toBe('item-2');
  });

  it('never keeps a song whose streamed upload failed', () => {
    const { store } = setup();
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_A, VIDEO_C]);
    store.skip('geral', 'item-1'); // A
    store.skip('geral', 'item-2'); // B; item-3 (A again) plays
    store.dropVideo(VIDEO_A);
    expect(historyOf(store)).toEqual(['item-2']);
    expect(store.current('geral')?.item.id).toBe('item-4');
  });

  it(`keeps the latest ${JAM_HISTORY_MAX}`, () => {
    const { store } = setup();
    queue(
      store,
      Array.from({ length: JAM_HISTORY_MAX + 6 }, () => VIDEO_A),
    );
    for (let i = 1; i <= JAM_HISTORY_MAX + 5; i += 1) store.skip('geral', `item-${i}`);
    const history = historyOf(store);
    expect(history).toHaveLength(JAM_HISTORY_MAX);
    expect(history[0]).toBe(`item-${JAM_HISTORY_MAX + 5}`);
    expect(history.at(-1)).toBe('item-6');
  });

  it('keeps history after playback ends until the session is cleared', () => {
    const { store, updates } = setup();
    store.enqueue('geral', track(VIDEO_A), 'alice', true);
    store.enqueue('geral', track(VIDEO_B), 'alice', false); // downloading: the jam goes on
    store.finish('geral', 'item-1');
    expect(store.state('geral')).toMatchObject({ current: null, history: [{ id: 'item-1' }] });
    store.remove('geral', 'item-2');
    expect(updates.at(-1)?.state).toMatchObject({
      room: 'geral',
      current: null,
      queue: [],
      history: [{ id: 'item-1' }],
    });
    expect(historyOf(store)).toEqual(['item-1']);
    store.clear('geral');
    expect(historyOf(store)).toEqual([]);
    queue(store, [VIDEO_C]);
    expect(historyOf(store)).toEqual([]);
  });

  it('is forgotten when the room is cleared', () => {
    const { store } = setup();
    queue(store, [VIDEO_A, VIDEO_B]);
    store.skip('geral', 'item-1');
    store.clear('geral');
    expect(store.state('geral').history).toEqual([]);
  });

  it('plays the previous song from the start, the one playing going back to the front', () => {
    const { store, clock } = setup();
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_C]);
    clock.advance(30_000);
    store.skip('geral', 'item-1');
    clock.advance(10_000);
    store.pause('geral', 'bob');
    const previous = store.previousOf('geral', 'item-2');
    expect(previous).toMatchObject({ id: 'item-1', track: track(VIDEO_A) });
    store.playPrevious('geral', 'item-2', previous.id);
    expect(store.current('geral')).toEqual({
      item: previous,
      positionMs: 0,
      at: clock.time,
      paused: false,
      pausedBy: null,
    });
    expect(shape(store.state('geral'))).toEqual({
      current: 'item-1',
      queue: ['item-2:ready', 'item-3:ready'],
    });
    expect(historyOf(store)).toEqual([]);
    // Skipping returns to the song that was playing.
    store.skip('geral', 'item-1');
    expect(store.current('geral')?.item.id).toBe('item-2');
    expect(historyOf(store)).toEqual(['item-1']);
  });

  it('plays the previous song when nothing plays', () => {
    const { store } = setup();
    store.enqueue('geral', track(VIDEO_A), 'alice', true);
    store.enqueue('geral', track(VIDEO_B), 'alice', false);
    store.finish('geral', 'item-1');
    store.playPrevious('geral', null, store.previousOf('geral', null).id);
    expect(shape(store.state('geral'))).toEqual({
      current: 'item-1',
      queue: ['item-2:downloading'],
    });
  });

  it('rejects a stale request and an empty history', () => {
    const { store } = setup();
    expect(code(() => store.previousOf('geral', null))).toBe('no_previous');
    queue(store, [VIDEO_A, VIDEO_B]);
    expect(code(() => store.previousOf('geral', 'item-1'))).toBe('no_previous');
    expect(code(() => store.previousOf('geral', 'item-2'))).toBe('stale');
    expect(code(() => store.previousOf('geral', null))).toBe('stale');
    store.skip('geral', 'item-1');
    expect(code(() => store.previousOf('geral', 'item-1'))).toBe('stale');
    // Checked again when it plays: the jam may have moved on meanwhile.
    expect(code(() => store.playPrevious('geral', 'item-1', 'item-1'))).toBe('stale');
    expect(code(() => store.playPrevious('geral', 'item-2', 'item-9'))).toBe('stale');
  });

  it('forgets a song of the history', () => {
    const { store, updates } = setup();
    queue(store, [VIDEO_A, VIDEO_B]);
    store.skip('geral', 'item-1');
    updates.length = 0;
    store.forgetPrevious('geral', 'item-1');
    expect(historyOf(store)).toEqual([]);
    expect(updates).toHaveLength(1);
    store.forgetPrevious('geral', 'item-1');
    expect(updates).toHaveLength(1);
  });

  it('keeps the files of the history and gives its copies the exact duration', () => {
    const { store } = setup();
    queue(store, [VIDEO_A, VIDEO_B]);
    store.skip('geral', 'item-1');
    expect(store.referencedVideoIds()).toEqual(new Set([VIDEO_A, VIDEO_B]));
    store.setDuration(VIDEO_A, 201_234);
    expect(store.state('geral').history?.[0]?.track.durationMs).toBe(201_234);
    expect(store.track(VIDEO_A)?.durationMs).toBe(201_234);
    expect(store.track(VIDEO_C)).toBeUndefined();
  });

  it('reports songs entering the history and songs starting to play', () => {
    const onHistory = vi.fn<(videoId: string) => void>();
    const onStart = vi.fn<(item: JamItem) => void>();
    const { store } = setup({ onHistory, onStart });
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_C]);
    store.skip('geral', 'item-1');
    store.finish('geral', 'item-2', 'failed');
    store.playPrevious('geral', 'item-3', 'item-1');
    expect(onHistory.mock.calls).toEqual([[VIDEO_A]]);
    expect(onStart.mock.calls.map(([item]) => item.id)).toEqual([
      'item-1',
      'item-2',
      'item-3',
      'item-1',
    ]);
  });

  it('round-trips through toJSON and load, with only songs that played, within the limit', () => {
    const { store, clock } = setup();
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_C]);
    store.skip('geral', 'item-1');
    store.skip('geral', 'item-2');
    const saved = store.toJSON();
    expect(saved.rooms[0]?.history?.map((item) => item.id)).toEqual(['item-2', 'item-1']);
    const restored = new JamStore({ now: clock.now });
    restored.load(saved);
    expect(restored.state('geral')).toEqual(store.state('geral'));

    const latest = saved.rooms[0]?.history?.[0];
    if (!saved.rooms[0] || !latest) throw new Error('unexpected state');
    const older = Array.from({ length: JAM_HISTORY_MAX }, (_, i) => ({
      ...latest,
      id: `old-${i}`,
    }));
    saved.rooms[0].history = [{ ...latest, status: 'downloading' }, ...older];
    restored.load(saved);
    const history = restored.state('geral').history ?? [];
    expect(history).toHaveLength(JAM_HISTORY_MAX);
    expect(history[0]?.id).toBe('old-0');
  });

  it('drops, from a saved jam, the songs of the history whose audio is missing', () => {
    const { store } = setup();
    queue(store, [VIDEO_A, VIDEO_B, VIDEO_C]);
    store.skip('geral', 'item-1');
    store.skip('geral', 'item-2');
    const saved = withoutReadySongs(store.toJSON(), new Set([VIDEO_A]));
    expect(saved.rooms[0]?.history?.map((item) => item.id)).toEqual(['item-2']);
  });
});
