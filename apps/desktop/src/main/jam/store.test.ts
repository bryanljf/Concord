import type { JamEvent, JamState } from '@concord/shared';
import { describe, expect, it, vi } from 'vitest';
import { createJamStore, UNAVAILABLE_JAM } from './store';

const state: JamState = {
  room: 'sala-1',
  current: null,
  queue: [
    {
      id: 'item-1',
      track: {
        videoId: '4D7u5KF7SP8',
        title: 'Get Lucky',
        artists: 'Daft Punk',
        album: null,
        durationMs: 370_000,
        artworkUrl: null,
      },
      requestedBy: 'bryan',
      addedAt: 1,
      status: 'downloading',
    },
  ],
};

describe('createJamStore', () => {
  it('starts unavailable, applies events and re-emits them', () => {
    const store = createJamStore();
    const listener = vi.fn();
    store.onEvent(listener);
    expect(store.get()).toEqual({ available: false, rooms: {}, serverTime: 0 });

    const snapshot: JamEvent = {
      type: 'jam_snapshot',
      data: { available: true, rooms: {}, serverTime: 10 },
    };
    store.apply(snapshot);
    expect(store.get()).toEqual(snapshot.data);
    expect(listener).toHaveBeenLastCalledWith(snapshot);

    store.apply({ type: 'jam_updated', state, serverTime: 20 });
    expect(store.get()).toEqual({ available: true, rooms: { 'sala-1': state }, serverTime: 20 });

    // An empty state ends the room's jam.
    store.apply({
      type: 'jam_updated',
      state: { room: 'sala-1', current: null, queue: [] },
      serverTime: 30,
    });
    expect(store.get()).toEqual({ available: true, rooms: {}, serverTime: 30 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('resets to unavailable with one snapshot event, only when something changes', () => {
    const store = createJamStore();
    const listener = vi.fn();
    const unsubscribe = store.onEvent(listener);
    store.reset();
    expect(listener).not.toHaveBeenCalled();

    store.apply({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 1 } });
    store.reset();
    expect(store.get()).toBe(UNAVAILABLE_JAM);
    expect(listener).toHaveBeenLastCalledWith({ type: 'jam_snapshot', data: UNAVAILABLE_JAM });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.apply({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 2 } });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('snapshotNow', () => {
  it('moves serverTime forward by the time since the snapshot arrived', () => {
    let clock = 1_000;
    const store = createJamStore(() => clock);
    expect(store.snapshotNow()).toBe(UNAVAILABLE_JAM);
    store.apply({
      type: 'jam_snapshot',
      data: { available: true, rooms: { 'sala-1': state }, serverTime: 50_000 },
    });
    expect(store.snapshotNow().serverTime).toBe(50_000);
    clock += 7_500;
    expect(store.snapshotNow()).toEqual({
      available: true,
      rooms: { 'sala-1': state },
      serverTime: 57_500,
    });
    expect(store.get().serverTime).toBe(50_000);
  });
});
