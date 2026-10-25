/**
 * The jam routes (`@concord/shared` jam.ts) with the jam's own pt-BR messages. The web never
 * downloads audio: `POST …/queue` makes the api ask a desktop app to fetch the song when needed.
 */
import type {
  JamEnqueueRequest,
  JamItem,
  JamPreviousRequest,
  JamRecentTrack,
  JamSeekRequest,
  JamSkipRequest,
  JamTrack,
  RoomId,
} from '@concord/shared';
import { JAM_LOOKUP_TIMEOUT_MS, jamErrorFromResponse, type Http } from './http';
import { parseJamEnqueue, parseJamRecent, parseJamSearch } from './parse';

export interface JamApi {
  search(query: string): Promise<JamTrack[]>;
  recent(): Promise<JamRecentTrack[]>;
  enqueue(room: RoomId, videoId: string): Promise<JamItem>;
  remove(room: RoomId, itemId: string): Promise<void>;
  skip(room: RoomId, itemId: string): Promise<void>;
  seek(room: RoomId, itemId: string, positionMs: number): Promise<void>;
  previous(room: RoomId, itemId: string | null): Promise<void>;
  pause(room: RoomId): Promise<void>;
  resume(room: RoomId): Promise<void>;
}

export function createJamApi(http: Http): JamApi {
  const jamPath = (room: RoomId, rest: string): string =>
    `/api/rooms/${encodeURIComponent(room)}/jam/${rest}`;
  const jamErrors = { mapError: jamErrorFromResponse };
  // Search and enqueue wait for the api to ask YouTube Music.
  const jamLookup = { ...jamErrors, timeoutMs: JAM_LOOKUP_TIMEOUT_MS };

  return {
    async search(query) {
      const path = `/api/jam/search?q=${encodeURIComponent(query)}`;
      const found = await http.request(path, parseJamSearch, undefined, 'GET', jamLookup);
      return found.results;
    },
    recent: () => http.request('/api/jam/recent', parseJamRecent, undefined, 'GET', jamErrors),
    async enqueue(room, videoId) {
      const body: JamEnqueueRequest = { videoId };
      const queued = await http.request(jamPath(room, 'queue'), parseJamEnqueue, body, 'POST', {
        ...jamLookup,
      });
      return queued.item;
    },
    remove: (room, itemId) =>
      http.command(jamPath(room, `items/${encodeURIComponent(itemId)}`), 'DELETE', undefined, {
        ...jamErrors,
      }),
    skip(room, itemId) {
      const body: JamSkipRequest = { itemId };
      return http.command(jamPath(room, 'skip'), 'POST', body, jamErrors);
    },
    seek(room, itemId, positionMs) {
      const body: JamSeekRequest = { itemId, positionMs };
      return http.command(jamPath(room, 'seek'), 'POST', body, jamErrors);
    },
    previous(room, itemId) {
      const body: JamPreviousRequest = { itemId };
      return http.command(jamPath(room, 'previous'), 'POST', body, jamErrors);
    },
    pause: (room) => http.command(jamPath(room, 'pause'), 'POST', undefined, jamErrors),
    resume: (room) => http.command(jamPath(room, 'resume'), 'POST', undefined, jamErrors),
  };
}
