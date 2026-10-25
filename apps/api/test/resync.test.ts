import { ParticipantInfo, Room, TrackInfo, TrackSource, TrackType } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEvent } from '@concord/shared';
import { PresenceStore } from '../src/presence-store';
import { retryDelayMs, startResync } from '../src/resync';
import { fakeLogger } from './helpers';

const alicePresence = {
  id: 'alice',
  name: 'Alice',
  streaming: false,
  joinedAt: 10_000,
  avatarUrl: null,
  camera: false,
};

function fakeRoomService(listRooms: () => Promise<Room[]>) {
  return {
    listRooms: vi.fn(listRooms),
    listParticipants: vi.fn(async () => [
      new ParticipantInfo({ identity: 'alice', name: 'Alice', joinedAt: 10n }),
    ]),
  };
}

describe('startResync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('syncs right away and then every interval until stopped', async () => {
    const presence = new PresenceStore(['geral']);
    const roomService = fakeRoomService(async () => [new Room({ name: 'geral' })]);
    const log = fakeLogger();
    const resync = startResync({ presence, roomService, log, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(roomService.listRooms).toHaveBeenCalledTimes(1);
    expect(presence.snapshot().rooms.geral).toEqual([alicePresence]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(roomService.listRooms).toHaveBeenCalledTimes(2);

    resync.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(roomService.listRooms).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never lets auxiliary identities into presence', async () => {
    const presence = new PresenceStore(['geral']);
    const roomService = {
      listRooms: vi.fn(async () => [new Room({ name: 'geral' })]),
      listParticipants: vi.fn(async () => [
        new ParticipantInfo({ identity: 'alice~popout', name: 'Alice', joinedAt: 11n }),
        new ParticipantInfo({ identity: 'alice', name: 'Alice', joinedAt: 10n }),
      ]),
    };
    const resync = startResync({ presence, roomService, log: fakeLogger() });

    await vi.advanceTimersByTimeAsync(0);
    expect(presence.snapshot().rooms.geral).toEqual([alicePresence]);
    resync.stop();
  });

  it('never lets the jam bot into presence, nor announces its music', async () => {
    const presence = new PresenceStore(['geral']);
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));
    const roomService = {
      listRooms: vi.fn(async () => [new Room({ name: 'geral' })]),
      listParticipants: vi.fn(async () => [
        new ParticipantInfo({
          identity: '@jam',
          name: 'Jam',
          joinedAt: 12n,
          tracks: [
            new TrackInfo({
              sid: 'TR_jam',
              type: TrackType.AUDIO,
              source: TrackSource.MICROPHONE,
              name: 'concord:music:jam',
            }),
          ],
        }),
      ]),
    };
    const resync = startResync({ presence, roomService, log: fakeLogger(), intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(roomService.listRooms).toHaveBeenCalledTimes(2);
    expect(presence.snapshot().rooms.geral).toEqual([]);
    expect(events).toEqual([]);
    resync.stop();
  });

  it('reconciles cameras, announcing each flip with participant_updated', async () => {
    const presence = new PresenceStore(['geral']);
    const camera = new TrackInfo({
      sid: 'TR_cam',
      type: TrackType.VIDEO,
      source: TrackSource.CAMERA,
    });
    let tracks = [camera];
    const roomService = {
      listRooms: vi.fn(async () => [new Room({ name: 'geral' })]),
      listParticipants: vi.fn(async () => [
        new ParticipantInfo({ identity: 'alice', name: 'Alice', joinedAt: 10n, tracks }),
      ]),
    };
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));
    const resync = startResync({ presence, roomService, log: fakeLogger(), intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(presence.snapshot().rooms.geral).toEqual([{ ...alicePresence, camera: true }]);
    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: alicePresence },
      {
        type: 'participant_updated',
        room: 'geral',
        participant: { ...alicePresence, camera: true },
      },
    ]);

    events.length = 0;
    await vi.advanceTimersByTimeAsync(1000); // same camera: nothing to announce
    expect(events).toEqual([]);

    tracks = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([
      { type: 'participant_updated', room: 'geral', participant: alicePresence },
    ]);
    resync.stop();
  });

  it('ignores a Microphone track from a person', async () => {
    const presence = new PresenceStore(['geral']);
    const microphone = new TrackInfo({
      sid: 'TR_mic',
      type: TrackType.AUDIO,
      source: TrackSource.MICROPHONE,
      name: 'mic',
    });
    let tracks = [microphone];
    const roomService = {
      listRooms: vi.fn(async () => [new Room({ name: 'geral' })]),
      listParticipants: vi.fn(async () => [
        new ParticipantInfo({ identity: 'alice', name: 'Alice', joinedAt: 10n, tracks }),
      ]),
    };
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));
    const resync = startResync({ presence, roomService, log: fakeLogger(), intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(presence.snapshot().rooms.geral).toEqual([alicePresence]);
    expect(events).toEqual([
      { type: 'participant_joined', room: 'geral', participant: alicePresence },
    ]);

    events.length = 0;
    tracks = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);
    resync.stop();
  });

  it('honours the initial delay', async () => {
    const roomService = fakeRoomService(async () => []);
    const resync = startResync({
      presence: new PresenceStore(),
      roomService,
      log: fakeLogger(),
      initialDelayMs: 500,
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(roomService.listRooms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(roomService.listRooms).toHaveBeenCalledTimes(1);
    resync.stop();
  });

  it('backs off until the first success and logs the failure streak once', async () => {
    let attempts = 0;
    const roomService = fakeRoomService(async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error('connection refused');
      return [];
    });
    const log = fakeLogger();
    const resync = startResync({
      presence: new PresenceStore(),
      roomService,
      log,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails -> retry in 1 s
    expect(attempts).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // t = 1 s: attempt 2 fails -> retry in 2 s
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); // t = 3 s: attempt 3 fails -> retry in 4 s
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(4000); // t = 7 s: attempt 4 succeeds
    expect(attempts).toBe(4);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ failures: 3 }, expect.any(String));

    await vi.advanceTimersByTimeAsync(60_000); // back to the regular interval
    expect(attempts).toBe(5);
    resync.stop();
  });

  it('keeps the regular interval for failures after the first success', async () => {
    let attempts = 0;
    const roomService = fakeRoomService(async () => {
      attempts += 1;
      if (attempts === 2 || attempts === 3) throw new Error('timeout');
      return [];
    });
    const log = fakeLogger();
    const resync = startResync({
      presence: new PresenceStore(),
      roomService,
      log,
      intervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 1 succeeds
    await vi.advanceTimersByTimeAsync(5000); // attempt 2 fails
    expect(attempts).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999); // no backoff retry in between
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // attempt 3 fails, still one warning
    expect(attempts).toBe(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // attempt 4 recovers
    expect(attempts).toBe(4);
    expect(log.info).toHaveBeenCalledWith({ failures: 2 }, expect.any(String));
    resync.stop();
  });
});

describe('retryDelayMs', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    expect([1, 2, 3, 5, 6, 20].map(retryDelayMs)).toEqual([
      1000, 2000, 4000, 16_000, 30_000, 30_000,
    ]);
  });
});
