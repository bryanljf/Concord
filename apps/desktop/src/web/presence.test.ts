import type { JamEvent, PresenceEvent } from '@concord/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceConnectionStatus } from '../preload/api';
import { FakeEventSource, FakeVisibility } from './fakes';
import { networkErrorMessage } from './http';
import {
  backoffDelay,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  createWebPresence,
  PRESENCE_URL,
  STALE_AFTER_HIDDEN_MS,
} from './presence';

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 30 s (the desktop numbers)', () => {
    const noJitter = () => 0.5;
    expect(backoffDelay(1, noJitter)).toBe(1_000);
    expect(backoffDelay(2, noJitter)).toBe(2_000);
    expect(backoffDelay(3, noJitter)).toBe(4_000);
    expect(backoffDelay(5, noJitter)).toBe(16_000);
    expect(backoffDelay(6, noJitter)).toBe(30_000);
    expect(backoffDelay(50, noJitter)).toBe(30_000);
  });

  it('applies ±20% jitter within [1 s, 30 s]', () => {
    expect(backoffDelay(3, () => 0)).toBe(3_200);
    expect(backoffDelay(3, () => 1)).toBe(4_800);
    expect(backoffDelay(1, () => 0)).toBe(BACKOFF_MIN_MS);
    expect(backoffDelay(6, () => 1)).toBe(BACKOFF_MAX_MS);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let i = 0; i < 20; i += 1) {
        const delay = backoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
        expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Connection state machine driven by a fake EventSource
// ---------------------------------------------------------------------------

const snapshotEvent: PresenceEvent = {
  type: 'snapshot',
  data: { rooms: { geral: [{ id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 }] } },
};

const jamSnapshot: JamEvent = {
  type: 'jam_snapshot',
  data: { available: true, rooms: {}, serverTime: 5_000 },
};

describe('createWebPresence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sources: FakeEventSource[] = [];
    const visibility = new FakeVisibility();
    const refused = vi.fn();
    let clock = 0;
    const presence = createWebPresence({
      host: 'concord.test',
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      backoff: (attempt) => attempt * 100,
      visibility,
      now: () => clock,
      onRefused: refused,
    });
    const statuses: PresenceConnectionStatus[] = [];
    const events: PresenceEvent[] = [];
    const jamEvents: JamEvent[] = [];
    presence.onStatus((status) => statuses.push(status));
    presence.onEvent((event) => events.push(event));
    presence.jam.onEvent((event) => jamEvents.push(event));
    const tick = (ms: number): void => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    const last = (): FakeEventSource => {
      const source = sources[sources.length - 1];
      if (!source) throw new Error('no EventSource yet');
      return source;
    };
    return { presence, sources, visibility, refused, statuses, events, jamEvents, tick, last };
  }

  it('connects with the jam query and applies the events to its snapshot', () => {
    const { presence, sources, statuses, events, last } = setup();
    presence.connect();
    expect(sources).toHaveLength(1);
    expect(last().url).toBe(PRESENCE_URL);
    expect(statuses).toEqual([{ state: 'connecting', attempt: 1 }]);

    last().open();
    expect(statuses[1]).toEqual({ state: 'connected' });
    last().send(snapshotEvent);
    const joined: PresenceEvent = {
      type: 'participant_joined',
      room: 'geral',
      participant: { id: 'bia~web', name: 'Bia', streaming: false, joinedAt: 2, client: 'web' },
    };
    last().send(joined);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject(snapshotEvent);
    expect(presence.getState().snapshot.rooms.geral?.map((p) => p.id)).toEqual(['ana', 'bia~web']);
    expect(presence.getState().status).toEqual({ state: 'connected' });
    // Connecting again while active changes nothing.
    presence.connect();
    expect(sources).toHaveLength(1);
  });

  it('feeds the jam events of the same stream to the jam store', () => {
    const { presence, events, jamEvents, last } = setup();
    presence.connect();
    last().open();
    expect(presence.jam.get().available).toBe(false);
    last().send(jamSnapshot);
    expect(presence.jam.get().available).toBe(true);
    expect(jamEvents).toEqual([jamSnapshot]);
    expect(events).toEqual([]);
  });

  it('ignores payloads that are not valid events', () => {
    const { presence, events, last } = setup();
    presence.connect();
    last().open();
    last().send('not json');
    last().send({ type: 'snapshot', data: 5 });
    last().send({ type: 'jam_updated', state: {} });
    last().send({ type: 'something_else' });
    expect(events).toEqual([]);
    expect(presence.jam.get().available).toBe(false);
  });

  it('reconnects with the backoff after a drop; a refusal also checks the session', () => {
    const { presence, sources, statuses, refused, tick, last } = setup();
    presence.connect();
    last().open();
    last().fail();
    expect(sources[0]?.closed).toBe(true);
    // A dropped connection retries like attempt 1.
    expect(statuses[2]).toEqual({
      state: 'error',
      message: 'A conexão com o servidor caiu.',
      retryInMs: 100,
    });
    expect(refused).not.toHaveBeenCalled();

    tick(99);
    expect(sources).toHaveLength(1);
    tick(1);
    expect(sources).toHaveLength(2);
    expect(statuses[3]).toEqual({ state: 'connecting', attempt: 1 });

    // Refused before it opened: the network message, the session check, and a longer wait.
    last().fail();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(statuses[4]).toEqual({
      state: 'error',
      message: networkErrorMessage('concord.test'),
      retryInMs: 100,
    });
    tick(100);
    expect(statuses[5]).toEqual({ state: 'connecting', attempt: 2 });
    last().fail();
    expect(statuses[6]).toMatchObject({ state: 'error', retryInMs: 200 });
    tick(200);
    last().open();
    expect(statuses[8]).toEqual({ state: 'connected' });
  });

  it('retries when the EventSource cannot even be created', () => {
    const presence = createWebPresence({
      host: 'concord.test',
      createEventSource: () => {
        throw new Error('no EventSource');
      },
      backoff: () => 50,
    });
    presence.connect();
    expect(presence.getState().status).toMatchObject({ state: 'error', retryInMs: 50 });
    presence.disconnect('no_session');
  });

  it('disconnect closes the stream, clears the snapshot and stops retrying', () => {
    const { presence, sources, events, statuses, tick, last } = setup();
    presence.connect();
    last().open();
    last().send(snapshotEvent);
    last().send(jamSnapshot);
    presence.disconnect('no_session');
    expect(sources[0]?.closed).toBe(true);
    expect(events[1]).toEqual({ type: 'snapshot', data: { rooms: {} } });
    expect(presence.getState()).toEqual({
      status: { state: 'idle', reason: 'no_session' },
      snapshot: { rooms: {} },
    });
    expect(presence.jam.get().available).toBe(false);
    expect(statuses[statuses.length - 1]).toEqual({ state: 'idle', reason: 'no_session' });
    tick(60_000);
    expect(sources).toHaveLength(1);

    // Disconnected while waiting for a retry: that retry never fires either.
    presence.connect();
    last().fail();
    presence.disconnect('no_session');
    tick(60_000);
    expect(sources).toHaveLength(2);
    // Same idle reason twice is not re-emitted.
    const count = statuses.length;
    presence.disconnect('no_session');
    expect(statuses).toHaveLength(count);
  });

  it('reconnects right away when the page becomes visible while waiting for a retry', () => {
    const { presence, sources, visibility, tick, last } = setup();
    presence.connect();
    last().open();
    visibility.set(true);
    last().fail();
    expect(presence.getState().status).toMatchObject({ state: 'error', retryInMs: 100 });
    visibility.set(false);
    expect(sources).toHaveLength(2);
    expect(presence.getState().status).toEqual({ state: 'connecting', attempt: 1 });
    // The pending retry was dropped: no third connection.
    tick(1_000);
    expect(sources).toHaveLength(2);
  });

  it('reconnects after a long time hidden even if the stream looks open', () => {
    const { presence, sources, visibility, tick, last } = setup();
    presence.connect();
    last().open();
    visibility.set(true);
    tick(1_000);
    visibility.set(false);
    expect(sources).toHaveLength(1);

    visibility.set(true);
    tick(STALE_AFTER_HIDDEN_MS);
    visibility.set(false);
    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(2);

    // Not connected: visibility changes nothing.
    presence.disconnect('no_session');
    visibility.set(true);
    tick(STALE_AFTER_HIDDEN_MS);
    visibility.set(false);
    expect(sources).toHaveLength(2);
  });

  it('reconnect drops the current stream; dispose stops watching the page', () => {
    const { presence, sources, visibility, last } = setup();
    presence.connect();
    last().open();
    presence.reconnect();
    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(2);
    expect(presence.getState().status).toEqual({ state: 'connecting', attempt: 1 });
    expect(visibility.listenerCount).toBe(1);
    presence.dispose();
    expect(visibility.listenerCount).toBe(0);
  });

  it('ignores callbacks from a stream it already replaced', () => {
    const { presence, sources, statuses, last } = setup();
    presence.connect();
    const first = last();
    presence.reconnect();
    const count = statuses.length;
    first.onopen?.(new Event('open'));
    first.onerror?.(new Event('error'));
    expect(statuses).toHaveLength(count);
    expect(sources).toHaveLength(2);
  });
});
