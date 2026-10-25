import { describe, expect, it } from 'vitest';
import {
  JAM_QUEUE_MAX,
  JAM_UPLOAD_TIMEOUT_MS,
  jamPositionAt,
  type JamState,
} from '@concord/shared';
import { JamError } from '../src/jam/errors';
import { JamStore, withoutReadySongs, type JamUpdate } from '../src/jam/store';
import { FakeClock, track, VIDEO_A, VIDEO_B, VIDEO_C } from './jam-helpers';

function setup() {
  const clock = new FakeClock();
  let next = 0;
  const store = new JamStore({ now: clock.now, newId: () => `item-${++next}` });
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

describe('JamStore', () => {
  describe('enqueue', () => {
    it('plays a song already on the server right away', () => {
      const { store, clock, updates } = setup();
      const result = store.enqueue('geral', track(VIDEO_A), 'alice', true);
      expect(result).toEqual({
        item: {
          id: 'item-1',
          track: track(VIDEO_A),
          requestedBy: 'alice',
          addedAt: clock.time,
          status: 'ready',
        },
        upload: false,
      });
      expect(store.current('geral')).toEqual({
        item: result.item,
        positionMs: 0,
        at: clock.time,
        paused: false,
        pausedBy: null,
      });
      expect(updates).toEqual([
        { type: 'jam_updated', state: store.state('geral'), serverTime: clock.time },
      ]);
    });

    it('asks the requester for the audio of a song the server does not have', () => {
      const { store } = setup();
      const result = store.enqueue('geral', track(VIDEO_A), 'alice', false);
      expect(result.upload).toBe(true);
      expect(result.item.status).toBe('downloading');
      expect(shape(store.state('geral'))).toEqual({ current: null, queue: ['item-1:downloading'] });
      expect(store.pendingUploads()).toEqual([
        {
          videoId: VIDEO_A,
          itemId: 'item-1',
          room: 'geral',
          requestedBy: 'alice',
          deadline: expect.any(Number),
          receiving: false,
          fetcher: null,
          assignments: 0,
          tried: [],
        },
      ]);
    });

    it('makes later copies of a song wait for the same upload, even in another room', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false);
      expect(store.enqueue('geral', track(VIDEO_A), 'bob', false).upload).toBe(false);
      expect(store.enqueue('jogos', track(VIDEO_A), 'carol', false).upload).toBe(false);
      expect(store.pendingUploads()).toHaveLength(1);

      const upload = store.beginUpload('geral', 'item-1', 'alice');
      expect(store.completeUpload(upload, 201_000)).toBe(true);
      expect(shape(store.state('geral'))).toEqual({ current: 'item-1', queue: ['item-2:ready'] });
      expect(shape(store.state('jogos'))).toEqual({ current: 'item-3', queue: [] });
      // The file's exact duration replaces YouTube Music's rounded one.
      expect(store.current('jogos')?.item.track.durationMs).toBe(201_000);
      expect(store.pendingUploads()).toEqual([]);
    });

    it('rejects a song past JAM_QUEUE_MAX upcoming ones (the one playing does not count)', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      for (let i = 0; i < JAM_QUEUE_MAX; i += 1)
        store.enqueue('geral', track(VIDEO_B), 'alice', true);
      expect(store.state('geral').queue).toHaveLength(JAM_QUEUE_MAX);
      expect(code(() => store.enqueue('geral', track(VIDEO_C), 'bob', true))).toBe('queue_full');
      expect(code(() => store.assertQueueNotFull('geral'))).toBe('queue_full');
      expect(code(() => store.assertQueueNotFull('jogos'))).toBeUndefined();
    });
  });

  describe('play order', () => {
    it('moves on to the first ready song; songs still downloading keep their place', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false); // item-1, downloading
      store.enqueue('geral', track(VIDEO_B), 'bob', true); // item-2, plays at once
      store.enqueue('geral', track(VIDEO_C), 'bob', true); // item-3, ready
      expect(shape(store.state('geral'))).toEqual({
        current: 'item-2',
        queue: ['item-1:downloading', 'item-3:ready'],
      });

      expect(store.finish('geral', 'item-2')).toBe(true);
      expect(shape(store.state('geral'))).toEqual({
        current: 'item-3',
        queue: ['item-1:downloading'],
      });

      store.completeUpload(store.beginUpload('geral', 'item-1', 'alice'));
      expect(shape(store.state('geral'))).toEqual({ current: 'item-3', queue: ['item-1:ready'] });
      store.finish('geral', 'item-3');
      expect(shape(store.state('geral'))).toEqual({ current: 'item-1', queue: [] });
    });

    it('waits, silent, while only songs still downloading are left', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.enqueue('geral', track(VIDEO_B), 'alice', false);
      store.finish('geral', 'item-1');
      expect(shape(store.state('geral'))).toEqual({ current: null, queue: ['item-2:downloading'] });
      store.completeUpload(store.beginUpload('geral', 'item-2', 'alice'));
      expect(shape(store.state('geral'))).toEqual({ current: 'item-2', queue: [] });
    });

    it('ignores the end of a song that is no longer the one playing', () => {
      const { store, updates } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      updates.length = 0;
      expect(store.finish('geral', 'item-9')).toBe(false);
      expect(store.finish('jogos', 'item-1')).toBe(false);
      expect(updates).toEqual([]);
    });

    it('keeps the session history when the last song finishes', () => {
      const { store, updates, clock } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      clock.advance(1000);
      store.finish('geral', 'item-1');
      expect(updates.at(-1)).toEqual({
        type: 'jam_updated',
        state: {
          room: 'geral',
          current: null,
          queue: [],
          history: [expect.objectContaining({ id: 'item-1' })],
        },
        serverTime: clock.time,
      });
      expect(store.isEmpty('geral')).toBe(false);
      expect(store.isIdle('geral')).toBe(true);
      expect(store.snapshot(true).rooms.geral?.history).toHaveLength(1);
    });
  });

  describe('skip and remove', () => {
    it('skips only the song still playing', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.enqueue('geral', track(VIDEO_B), 'alice', true);
      expect(code(() => store.skip('geral', 'item-2'))).toBe('stale');
      store.skip('geral', 'item-1');
      expect(store.current('geral')?.item.id).toBe('item-2');
      // A second, late skip of the same song skips nothing more.
      expect(code(() => store.skip('geral', 'item-1'))).toBe('stale');
      expect(code(() => store.skip('jogos', 'item-1'))).toBe('stale');
    });

    it('removes an upcoming song, and skips the current one', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.enqueue('geral', track(VIDEO_B), 'alice', true);
      store.enqueue('geral', track(VIDEO_C), 'alice', true);
      store.remove('geral', 'item-3');
      expect(shape(store.state('geral'))).toEqual({ current: 'item-1', queue: ['item-2:ready'] });
      store.remove('geral', 'item-1');
      expect(shape(store.state('geral'))).toEqual({ current: 'item-2', queue: [] });
      expect(code(() => store.remove('geral', 'item-1'))).toBe('item_not_found');
      expect(code(() => store.remove('jogos', 'item-2'))).toBe('item_not_found');
    });

    it('starts the next song playing even when the skipped one was paused', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.enqueue('geral', track(VIDEO_B), 'alice', true);
      store.pause('geral', 'bob');
      store.skip('geral', 'item-1');
      expect(store.current('geral')).toMatchObject({
        paused: false,
        pausedBy: null,
        positionMs: 0,
      });
    });
  });

  describe('pause and resume', () => {
    it('freezes the position while paused and continues from it', () => {
      const { store, clock } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      const start = clock.time;
      clock.advance(30_000);
      store.pause('geral', 'bob');
      expect(store.current('geral')).toMatchObject({
        positionMs: 30_000,
        at: start + 30_000,
        paused: true,
        pausedBy: 'bob',
      });
      clock.advance(10_000);
      const paused = store.current('geral');
      expect(paused && jamPositionAt(paused, clock.time)).toBe(30_000);

      store.resume('geral');
      expect(store.current('geral')).toMatchObject({
        positionMs: 30_000,
        at: clock.time,
        paused: false,
        pausedBy: null,
      });
      clock.advance(5_000);
      const playing = store.current('geral');
      expect(playing && jamPositionAt(playing, clock.time)).toBe(35_000);
    });

    it('keeps who paused first and ignores pausing nothing', () => {
      const { store, updates } = setup();
      store.pause('geral', 'alice');
      store.resume('geral');
      expect(updates).toEqual([]);
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.pause('geral', 'alice');
      updates.length = 0;
      store.pause('geral', 'bob');
      expect(store.current('geral')?.pausedBy).toBe('alice');
      expect(updates).toEqual([]);
    });

    it("adopts the bot's position only for the song and state it describes", () => {
      const { store, clock } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      clock.advance(2_000);
      store.setPosition('geral', 'item-1', 1_250, false);
      expect(store.current('geral')).toMatchObject({ positionMs: 1_250, at: clock.time });
      store.setPosition('geral', 'item-1', 9_999, true); // the bot is paused, the jam is not
      store.setPosition('geral', 'item-2', 9_999, false);
      store.setPosition('geral', 'item-1', Number.NaN, false);
      expect(store.current('geral')?.positionMs).toBe(1_250);
    });
  });

  describe('uploads', () => {
    it('lets only the requester claim the upload, once', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false);
      store.enqueue('geral', track(VIDEO_A), 'bob', false); // waits for alice's upload
      store.enqueue('geral', track(VIDEO_B), 'bob', true);
      expect(code(() => store.beginUpload('geral', 'item-9', 'alice'))).toBe('item_not_found');
      expect(code(() => store.beginUpload('jogos', 'item-1', 'alice'))).toBe('item_not_found');
      expect(code(() => store.beginUpload('geral', 'item-1', 'bob'))).toBe('not_requester');
      expect(code(() => store.beginUpload('geral', 'item-2', 'bob'))).toBe('already_uploaded');
      expect(code(() => store.beginUpload('geral', 'item-3', 'bob'))).toBe('already_uploaded');
      expect(store.beginUpload('geral', 'item-1', 'alice')).toMatchObject({ receiving: true });
      expect(code(() => store.beginUpload('geral', 'item-1', 'alice'))).toBe('already_uploaded');
    });

    it('drops every song waiting for a failed upload, in every room', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_B), 'bob', true); // item-1 plays
      store.enqueue('geral', track(VIDEO_A), 'alice', false); // item-2
      store.enqueue('jogos', track(VIDEO_A), 'bob', false); // item-3
      store.failUpload(store.beginUpload('geral', 'item-2', 'alice'));
      expect(shape(store.state('geral'))).toEqual({ current: 'item-1', queue: [] });
      expect(store.isEmpty('jogos')).toBe(true);
      expect(store.pendingUploads()).toEqual([]);
    });

    it('drops songs whose audio did not arrive in time; one being received gets longer', () => {
      const { store, clock } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false); // item-1
      clock.advance(1_000);
      store.enqueue('geral', track(VIDEO_B), 'alice', false); // item-2
      store.beginUpload('geral', 'item-2', 'alice');
      clock.advance(JAM_UPLOAD_TIMEOUT_MS - 1_001);
      store.expireUploads();
      expect(store.state('geral').queue).toHaveLength(2);
      clock.advance(1);
      store.expireUploads();
      expect(shape(store.state('geral'))).toEqual({ current: null, queue: ['item-2:downloading'] });
      // item-2 was added 1 s later and is being received: twice the timeout from then.
      clock.advance(JAM_UPLOAD_TIMEOUT_MS + 999);
      store.expireUploads();
      expect(store.state('geral').queue).toHaveLength(1);
      clock.advance(1);
      store.expireUploads();
      expect(store.isEmpty('geral')).toBe(true);
    });

    it('still takes the upload when its own song left but a copy waits for it', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false); // item-1 uploads
      store.enqueue('jogos', track(VIDEO_A), 'bob', false); // item-2 waits
      store.remove('geral', 'item-1');
      const upload = store.beginUpload('geral', 'item-1', 'alice');
      expect(store.completeUpload(upload)).toBe(true);
      expect(shape(store.state('jogos'))).toEqual({ current: 'item-2', queue: [] });
    });

    it('forgets an upload nobody waits for anymore', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false);
      const upload = store.beginUpload('geral', 'item-1', 'alice');
      store.remove('geral', 'item-1');
      expect(store.isAwaited(upload)).toBe(false);
      expect(store.completeUpload(upload)).toBe(false);
      expect(code(() => store.beginUpload('geral', 'item-1', 'alice'))).toBe('item_not_found');
    });

    it('does not let a stale upload complete a newer request for the same song', () => {
      const { store, clock } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false); // item-1
      const stale = store.beginUpload('geral', 'item-1', 'alice');
      clock.advance(2 * JAM_UPLOAD_TIMEOUT_MS);
      store.expireUploads();
      store.enqueue('geral', track(VIDEO_A), 'bob', false); // item-2, a new upload
      expect(store.completeUpload(stale)).toBe(false);
      store.failUpload(stale);
      expect(shape(store.state('geral'))).toEqual({ current: null, queue: ['item-2:downloading'] });
    });
  });

  describe('streamed uploads', () => {
    it('drops every copy of a song whose audio failed after it was ready, moving on', () => {
      const { store, updates } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', false); // item-1
      store.enqueue('geral', track(VIDEO_B), 'alice', true); // item-2: plays
      store.enqueue('jogos', track(VIDEO_A), 'bob', false); // item-3: waits for item-1's upload
      store.completeUpload(store.beginUpload('geral', 'item-1', 'alice'));
      store.skip('geral', 'item-2'); // item-1 plays
      expect(shape(store.state('geral'))).toEqual({ current: 'item-1', queue: [] });
      store.enqueue('geral', track(VIDEO_C), 'alice', true); // item-4
      updates.length = 0;
      store.dropVideo(VIDEO_A);
      expect(shape(store.state('geral'))).toEqual({ current: 'item-4', queue: [] });
      expect(store.isEmpty('jogos')).toBe(true);
      expect(updates.map((update) => update.state.room).sort()).toEqual(['geral', 'jogos']);
      store.dropVideo(VIDEO_A); // again: nothing left to drop
      expect(updates).toHaveLength(2);
    });

    it('gives every copy of a song its exact duration once known', () => {
      const { store, updates } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.enqueue('geral', track(VIDEO_A), 'alice', true);
      store.enqueue('jogos', track(VIDEO_A), 'alice', true);
      store.enqueue('jogos', track(VIDEO_B), 'alice', true);
      updates.length = 0;
      store.setDuration(VIDEO_A, 201_234);
      for (const room of ['geral', 'jogos']) {
        const state = store.state(room);
        const items = [state.current?.item, ...state.queue];
        for (const item of items) {
          const expected = item?.track.videoId === VIDEO_A ? 201_234 : 200_000;
          expect(item?.track.durationMs).toBe(expected);
        }
      }
      expect(updates).toHaveLength(2);
      store.setDuration(VIDEO_A, 201_234); // unchanged: no update
      store.setDuration(VIDEO_A, 0); // nonsense: ignored
      expect(updates).toHaveLength(2);
    });

    it('drops, from a saved jam, the ready songs whose audio is missing', () => {
      const { store } = setup();
      store.enqueue('geral', track(VIDEO_A), 'alice', true); // item-1 plays
      store.enqueue('geral', track(VIDEO_B), 'alice', true); // item-2
      store.enqueue('geral', track(VIDEO_C), 'alice', false); // item-3 downloading
      store.enqueue('geral', track(VIDEO_B), 'alice', true); // item-4
      const saved = withoutReadySongs(store.toJSON(), new Set([VIDEO_A, VIDEO_C]));
      const restored = new JamStore();
      restored.load(saved);
      // The song playing is gone: the first ready one plays; one still downloading stays.
      expect(shape(restored.state('geral'))).toEqual({
        current: 'item-2',
        queue: ['item-3:downloading', 'item-4:ready'],
      });
    });
  });

  it('clears a room and forgets the uploads only it waited for', () => {
    const { store, updates } = setup();
    store.enqueue('geral', track(VIDEO_A), 'alice', true);
    store.enqueue('geral', track(VIDEO_B), 'alice', false);
    updates.length = 0;
    store.clear('geral');
    expect(updates.map((update) => update.state)).toEqual([
      { room: 'geral', current: null, queue: [], history: [] },
    ]);
    expect(store.pendingUploads()).toEqual([]);
    expect(store.activeRooms()).toEqual([]);
  });

  it('lists what the cache must keep', () => {
    const { store } = setup();
    store.enqueue('geral', track(VIDEO_A), 'alice', true);
    store.enqueue('jogos', track(VIDEO_B), 'alice', false);
    expect(store.referencedVideoIds()).toEqual(new Set([VIDEO_A, VIDEO_B]));
  });

  it('round-trips through toJSON and load', () => {
    const { store, clock } = setup();
    store.enqueue('geral', track(VIDEO_A), 'alice', true);
    store.enqueue('geral', track(VIDEO_B), 'alice', false);
    clock.advance(10_000);
    store.pause('geral', 'bob');
    store.beginUpload('geral', 'item-2', 'alice');
    const saved = store.toJSON();
    expect(saved.uploads[0]?.receiving).toBe(false);

    const restored = new JamStore({ now: clock.now });
    const updates: JamUpdate[] = [];
    restored.subscribe((update) => updates.push(update));
    restored.load(saved);
    expect(restored.state('geral')).toEqual(store.state('geral'));
    expect(restored.pendingUploads()).toEqual([{ ...store.pendingUploads()[0], receiving: false }]);
    expect(updates).toEqual([]);
  });

  it('drops, on load, songs waiting for an upload nobody will send, and starts a ready one', () => {
    const { store, clock } = setup();
    store.enqueue('geral', track(VIDEO_A), 'alice', false);
    store.enqueue('geral', track(VIDEO_B), 'alice', false);
    const saved = store.toJSON();
    const geral = saved.rooms[0];
    if (!geral?.queue[1]) throw new Error('unexpected state');
    geral.queue[1].status = 'ready';
    saved.uploads = [];

    const restored = new JamStore({ now: clock.now });
    restored.load(saved);
    expect(shape(restored.state('geral'))).toEqual({ current: 'item-2', queue: [] });
  });
});
