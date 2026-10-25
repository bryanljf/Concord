import type { JamItem, JamTrack } from '@concord/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api-client';
import { UserFacingError } from '../validation';
import {
  createJamService,
  JAM_PLATFORM_UNSUPPORTED_MESSAGE,
  jamSessionOwner,
  type JamServiceDeps,
} from './service';
import { createJamStore } from './store';
import type { JamUploads } from './uploads';

const track: JamTrack = {
  videoId: '4D7u5KF7SP8',
  title: 'Get Lucky',
  artists: 'Daft Punk',
  album: null,
  durationMs: 370_000,
  artworkUrl: null,
};
const item: JamItem = {
  id: 'item-1',
  track,
  requestedBy: 'bryan',
  addedAt: 1,
  status: 'downloading',
};

const other: JamTrack = { ...track, videoId: 'xxxxxxxxxxx', title: 'Other' };

function setup(overrides: Partial<JamServiceDeps> = {}) {
  type Api = JamServiceDeps['api'];
  const api = {
    jamSearch: vi.fn<Api['jamSearch']>(async () => ({ results: [track, other], cached: [] })),
    jamRecent: vi.fn<Api['jamRecent']>(async () => []),
    jamEnqueue: vi.fn<Api['jamEnqueue']>(async () => ({ item, upload: true })),
    jamRemove: vi.fn<Api['jamRemove']>(async () => undefined),
    jamSkip: vi.fn<Api['jamSkip']>(async () => undefined),
    jamSeek: vi.fn<Api['jamSeek']>(async () => undefined),
    jamPrevious: vi.fn<Api['jamPrevious']>(async () => undefined),
    jamPause: vi.fn<Api['jamPause']>(async () => undefined),
    jamResume: vi.fn<Api['jamResume']>(async () => undefined),
    jamFetchDecline: vi.fn<Api['jamFetchDecline']>(async () => undefined),
  };
  const uploads = {
    start: vi.fn(),
    isSending: vi.fn<(videoId: string) => boolean>(() => false),
    list: vi.fn(() => []),
    onStatus: vi.fn(() => () => undefined),
    cancelAll: vi.fn(),
    destroy: vi.fn(),
  } satisfies JamUploads;
  const prefetches = {
    prefetch: vi.fn<(videoIds: readonly string[]) => void>(),
    discard: vi.fn<(videoId: string) => void>(),
    clear: vi.fn(),
  };
  const prepare = vi.fn();
  const store = createJamStore();
  // The jam is up unless a test says otherwise.
  store.apply({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 1 } });
  const service = createJamService({
    api,
    store,
    uploads,
    prefetches,
    canDownload: true,
    prepare,
    ...overrides,
  });
  return { service, api, uploads, prefetches, prepare, store };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('createJamService', () => {
  it('adds a song and sends its audio when the server asks for it', async () => {
    const { service, api, uploads, prefetches } = setup();
    expect(await service.add('sala-1', '4D7u5KF7SP8')).toEqual(item);
    expect(api.jamEnqueue).toHaveBeenCalledWith('sala-1', '4D7u5KF7SP8');
    expect(uploads.start).toHaveBeenCalledWith('sala-1', item);
    expect(prefetches.discard).not.toHaveBeenCalled();

    // The server has it (or someone else is sending it): its prefetch is not needed.
    api.jamEnqueue.mockResolvedValueOnce({ item: { ...item, id: 'item-2' }, upload: false });
    await service.add('sala-1', '4D7u5KF7SP8');
    expect(uploads.start).toHaveBeenCalledTimes(1);
    expect(prefetches.discard).toHaveBeenCalledWith('4D7u5KF7SP8');
  });

  it('refuses to add songs where yt-dlp cannot run', async () => {
    const { service, api } = setup({ canDownload: false });
    const err = await rejection(service.add('sala-1', '4D7u5KF7SP8'));
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toBe(JAM_PLATFORM_UNSUPPORTED_MESSAGE);
    expect(api.jamEnqueue).not.toHaveBeenCalled();
  });

  it('downloads a song for the server silently, or declines where yt-dlp cannot run', async () => {
    const { service, uploads, api } = setup();
    service.fetch('sala-1', item);
    expect(uploads.start).toHaveBeenCalledWith('sala-1', item, { delegated: true });
    expect(api.jamFetchDecline).not.toHaveBeenCalled();

    const elsewhere = setup({ canDownload: false });
    elsewhere.service.fetch('sala-1', item);
    expect(elsewhere.uploads.start).not.toHaveBeenCalled();
    expect(elsewhere.api.jamFetchDecline).toHaveBeenCalledWith(
      'sala-1',
      'item-1',
      'cannot download on this platform',
    );
    // Gone or handed to someone else meanwhile, or any failure: nobody to tell (logged only).
    elsewhere.api.jamFetchDecline.mockRejectedValueOnce(
      new ApiClientError('http', 'x', 404, 'item_not_found'),
    );
    elsewhere.service.fetch('sala-1', item);
    elsewhere.api.jamFetchDecline.mockRejectedValueOnce(new ApiClientError('network', 'offline'));
    elsewhere.service.fetch('sala-1', item);
    await new Promise((resolve) => setImmediate(resolve));
    expect(elsewhere.api.jamFetchDecline).toHaveBeenCalledTimes(3);
  });

  it('passes enqueue errors through', async () => {
    const { service, api, uploads } = setup();
    api.jamEnqueue.mockRejectedValue(
      new ApiClientError('http', 'Entre na sala para mexer na Jam.', 403, 'not_in_room'),
    );
    expect((await rejection(service.add('sala-1', '4D7u5KF7SP8'))).message).toBe(
      'Entre na sala para mexer na Jam.',
    );
    expect(uploads.start).not.toHaveBeenCalled();
  });

  it('gets yt-dlp ready and prefetches the top result after a search', async () => {
    const { service, prepare, prefetches } = setup();
    expect(await service.search('daft punk')).toEqual([track, other]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prefetches.prefetch).toHaveBeenCalledTimes(1);
    expect(prefetches.prefetch).toHaveBeenCalledWith([track.videoId]);

    const elsewhere = setup({ canDownload: false });
    await elsewhere.service.search('daft punk');
    expect(elsewhere.prepare).not.toHaveBeenCalled();
    expect(elsewhere.prefetches.prefetch).not.toHaveBeenCalled();

    const nothing = setup();
    nothing.api.jamSearch.mockResolvedValue({ results: [], cached: [] });
    expect(await nothing.service.search('zzz')).toEqual([]);
    expect(nothing.prefetches.prefetch).not.toHaveBeenCalled();
  });

  it('never prefetches what the server already has', async () => {
    const { service, api, prefetches } = setup();
    api.jamSearch.mockResolvedValue({ results: [track, other], cached: [track.videoId] });
    await service.search('daft punk');
    expect(prefetches.prefetch).not.toHaveBeenCalled();
    // The last search's list holds for the songs pointed at afterwards.
    service.prefetch([track.videoId, other.videoId]);
    expect(prefetches.prefetch).toHaveBeenLastCalledWith([other.videoId]);
    service.prefetch([track.videoId]);
    expect(prefetches.prefetch).toHaveBeenCalledTimes(1);

    // A new search replaces that list.
    api.jamSearch.mockResolvedValue({ results: [other], cached: [] });
    await service.search('other');
    service.prefetch([track.videoId]);
    expect(prefetches.prefetch).toHaveBeenLastCalledWith([track.videoId]);
  });

  it('lists the recent songs and never prefetches them while they are listed', async () => {
    const { service, api, prefetches } = setup();
    const recent = [{ ...track, usedAt: 5_000 }];
    api.jamRecent.mockResolvedValue(recent);
    expect(await service.recent()).toEqual(recent);
    // The server has them: pointing at one downloads nothing, nor does a search they top.
    service.prefetch([track.videoId, other.videoId]);
    expect(prefetches.prefetch).toHaveBeenLastCalledWith([other.videoId]);
    await service.search('daft punk');
    expect(prefetches.prefetch).toHaveBeenCalledTimes(1);

    // The next listing replaces the last one; a failed one keeps it.
    api.jamRecent.mockRejectedValueOnce(
      new ApiClientError('http', 'Fora do ar.', 503, 'jam_unavailable'),
    );
    expect((await rejection(service.recent())).message).toBe('Fora do ar.');
    service.prefetch([track.videoId]);
    expect(prefetches.prefetch).toHaveBeenCalledTimes(1);
    api.jamRecent.mockResolvedValue([]);
    await service.recent();
    service.prefetch([track.videoId]);
    expect(prefetches.prefetch).toHaveBeenLastCalledWith([track.videoId]);
  });

  it('skips songs being sent or ready in some jam, and prefetches nothing without a jam', () => {
    const { service, uploads, prefetches, store } = setup();
    uploads.isSending.mockImplementation((videoId) => videoId === other.videoId);
    store.apply({
      type: 'jam_updated',
      state: {
        room: 'sala-2',
        current: null,
        queue: [{ ...item, track: { ...track, videoId: 'readyreadyx' }, status: 'ready' }],
      },
      serverTime: 2,
    });
    service.prefetch([other.videoId, 'readyreadyx', track.videoId]);
    expect(prefetches.prefetch).toHaveBeenCalledWith([track.videoId]);

    // The jam going away drops the prefetches and stops new ones.
    store.reset();
    expect(prefetches.clear).toHaveBeenCalledTimes(1);
    service.prefetch([track.videoId]);
    expect(prefetches.prefetch).toHaveBeenCalledTimes(1);

    const elsewhere = setup({ canDownload: false });
    elsewhere.service.prefetch([track.videoId]);
    expect(elsewhere.prefetches.prefetch).not.toHaveBeenCalled();
  });

  it('treats an already removed or skipped song as done', async () => {
    const { service, api } = setup();
    api.jamRemove.mockRejectedValueOnce(new ApiClientError('http', 'x', 404, 'item_not_found'));
    await expect(service.remove('sala-1', 'item-1')).resolves.toBeUndefined();
    api.jamSkip.mockRejectedValueOnce(new ApiClientError('http', 'x', 409, 'stale'));
    await expect(service.skip('sala-1', 'item-1')).resolves.toBeUndefined();
    api.jamSkip.mockRejectedValueOnce(new ApiClientError('http', 'x', 404, 'item_not_found'));
    await expect(service.skip('sala-1', 'item-1')).resolves.toBeUndefined();

    api.jamRemove.mockRejectedValueOnce(
      new ApiClientError('http', 'Entre na sala.', 403, 'not_in_room'),
    );
    expect((await rejection(service.remove('sala-1', 'item-1'))).message).toBe('Entre na sala.');
    api.jamSkip.mockRejectedValueOnce(new ApiClientError('network', 'offline'));
    expect((await rejection(service.skip('sala-1', 'item-1'))).message).toBe('offline');
  });

  it('seeks the song playing, and lets go once another one plays', async () => {
    const { service, api } = setup();
    await service.seek('sala-1', 'item-1', 83_000);
    expect(api.jamSeek).toHaveBeenCalledWith('sala-1', 'item-1', 83_000);

    // Skipped or ended meanwhile: never move the next song by accident.
    api.jamSeek.mockRejectedValueOnce(new ApiClientError('http', 'x', 409, 'stale'));
    await expect(service.seek('sala-1', 'item-1', 0)).resolves.toBeUndefined();
    api.jamSeek.mockRejectedValueOnce(new ApiClientError('http', 'x', 404, 'item_not_found'));
    await expect(service.seek('sala-1', 'item-1', 0)).resolves.toBeUndefined();

    api.jamSeek.mockRejectedValueOnce(
      new ApiClientError('http', 'Entre na sala.', 403, 'not_in_room'),
    );
    expect((await rejection(service.seek('sala-1', 'item-1', 0))).message).toBe('Entre na sala.');
    api.jamSeek.mockRejectedValueOnce(new ApiClientError('rate_limited', 'Aguarde.', 429));
    expect((await rejection(service.seek('sala-1', 'item-1', 0))).message).toBe('Aguarde.');
  });

  it('goes back one song, and lets go once the song playing changed', async () => {
    const { service, api } = setup();
    await service.previous('sala-1', 'item-1');
    await service.previous('sala-1', null);
    expect(api.jamPrevious).toHaveBeenNthCalledWith(1, 'sala-1', 'item-1');
    expect(api.jamPrevious).toHaveBeenNthCalledWith(2, 'sala-1', null);

    // Someone went back or skipped first: two quick presses go back one song only.
    api.jamPrevious.mockRejectedValueOnce(new ApiClientError('http', 'x', 409, 'stale'));
    await expect(service.previous('sala-1', 'item-1')).resolves.toBeUndefined();

    // Nothing to go back to: the user is told.
    api.jamPrevious.mockRejectedValueOnce(
      new ApiClientError('http', 'Não há música anterior nesta Jam.', 409, 'no_previous'),
    );
    expect((await rejection(service.previous('sala-1', null))).message).toBe(
      'Não há música anterior nesta Jam.',
    );
    api.jamPrevious.mockRejectedValueOnce(
      new ApiClientError('http', 'Indisponível.', 410, 'previous_unavailable'),
    );
    expect((await rejection(service.previous('sala-1', 'item-1'))).message).toBe('Indisponível.');
    api.jamPrevious.mockRejectedValueOnce(
      new ApiClientError('http', 'Entre na sala.', 403, 'not_in_room'),
    );
    expect((await rejection(service.previous('sala-1', 'item-1'))).message).toBe('Entre na sala.');
  });

  it('pauses and resumes, and reads the jam from the store', async () => {
    const { service, api, store } = setup();
    await service.pause('sala-1');
    await service.resume('sala-1');
    expect(api.jamPause).toHaveBeenCalledWith('sala-1');
    expect(api.jamResume).toHaveBeenCalledWith('sala-1');

    const listener = vi.fn();
    service.onEvent(listener);
    const event = {
      type: 'jam_snapshot',
      data: { available: true, rooms: {}, serverTime: 1 },
    } as const;
    store.apply(event);
    expect(service.getState()).toEqual(event.data);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('stops the uploads and prefetches on logout and destroy', () => {
    const { service, uploads, prefetches, store } = setup();
    service.cancelUploads();
    expect(uploads.cancelAll).toHaveBeenCalledTimes(1);
    expect(prefetches.clear).toHaveBeenCalledTimes(1);
    service.destroy();
    expect(uploads.cancelAll).toHaveBeenCalledTimes(2);
    expect(uploads.destroy).toHaveBeenCalledTimes(1);
    expect(prefetches.clear).toHaveBeenCalledTimes(2);
    // No longer listening to the jam.
    store.reset();
    expect(prefetches.clear).toHaveBeenCalledTimes(2);
  });
});

describe('jamSessionOwner', () => {
  const user = { id: 'bryan', displayName: 'Bryan', admin: false };

  it('changes with the account or the server, not with the name', () => {
    const owner = jamSessionOwner({ serverUrl: 'https://a.example', user });
    expect(
      jamSessionOwner({ serverUrl: 'https://a.example', user: { ...user, nickname: 'B' } }),
    ).toBe(owner);
    expect(jamSessionOwner({ serverUrl: 'https://b.example', user })).not.toBe(owner);
    expect(
      jamSessionOwner({ serverUrl: 'https://a.example', user: { ...user, id: 'ana' } }),
    ).not.toBe(owner);
    expect(jamSessionOwner({ serverUrl: 'https://a.example', user: null })).toBeNull();
  });
});
