import type { JamItem, UserInfo } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import type { Session } from '../preload/api';
import { createWebApi, WEB_CAPABILITIES, WEB_UPDATE_REASON } from './api';
import { emptyResponse, fakeEnv, jsonResponse, type FetchHandler } from './fakes';
import { JAM_ERROR_MESSAGES, SESSION_EXPIRED_MESSAGE } from './http';
import { SETTINGS_STORAGE_KEY } from './settings';
import { UNSUPPORTED_MESSAGE } from './unsupported';

const USER: UserInfo = {
  id: 'ana',
  displayName: 'Ana',
  admin: false,
  avatarUrl: null,
  discordName: null,
  nickname: null,
};

const ITEM: JamItem = {
  id: 'item-1',
  track: {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artists: 'Rick Astley',
    album: null,
    durationMs: 213_000,
    artworkUrl: null,
  },
  requestedBy: 'ana',
  addedAt: 1,
  status: 'downloading',
};

/** A server where Ana is logged in and every route answers. */
const server: FetchHandler = (path, init) => {
  if (path === '/api/me') return jsonResponse(200, { user: USER });
  if (path === '/api/rooms') return jsonResponse(200, { rooms: ['geral', 'jogos'] });
  if (path === '/api/token') return jsonResponse(200, { token: 't', url: 'wss://x', expiresAt: 1 });
  if (path === '/api/server')
    return jsonResponse(200, { name: 'vm', region: null, provider: null });
  if (path === '/api/health') return jsonResponse(200, { ok: true });
  if (path === '/api/rooms/geral/jam/queue')
    return jsonResponse(200, { item: ITEM, upload: false });
  if (path === '/api/rooms/geral/jam/skip') return emptyResponse(204);
  if (path === '/api/jam/search?q=rick') {
    return jsonResponse(200, { results: [ITEM.track], cached: [] });
  }
  if (path === '/api/jam/recent') return jsonResponse(200, { tracks: [] });
  return jsonResponse(404, { error: 'not_found', message: `${init?.method ?? 'GET'} ${path}` });
};

describe('createWebApi', () => {
  it('says what it is and what it can do', () => {
    const api = createWebApi(fakeEnv(server));
    expect(api.client).toBe('web');
    expect(api.joinPurpose).toBe('web');
    expect(api.capabilities).toEqual(WEB_CAPABILITIES);
    expect(api.capabilities.camera).toBe(true);
    expect(api.capabilities.nativeVideoPip).toBe(true);
    expect(api.capabilities.screenShare).toBe(false);
    expect(api.windowKind).toBe('main');
    expect(api.platform).toBe('iPhone');
    // `__APP_VERSION__` is only defined by the Vite build.
    expect(api.version).toBe('0.0.0');
  });

  it('requests tokens with the web purpose unless told otherwise', async () => {
    const env = fakeEnv(server);
    const api = createWebApi(env);
    await expect(api.requestToken('geral')).resolves.toEqual({
      token: 't',
      url: 'wss://x',
      expiresAt: 1,
    });
    expect(env.calls[0]).toMatchObject({
      path: '/api/token',
      init: { method: 'POST', credentials: 'same-origin' },
      json: { room: 'geral', purpose: 'web' },
    });
    await api.requestToken('geral', 'pip');
    expect(env.calls[1]?.json).toEqual({ room: 'geral', purpose: 'pip' });
  });

  it('answers the plain api calls', async () => {
    const api = createWebApi(fakeEnv(server));
    await expect(api.getRooms()).resolves.toEqual(['geral', 'jogos']);
    await expect(api.getServerInfo()).resolves.toEqual({
      name: 'vm',
      region: null,
      provider: null,
    });
    await expect(api.pingServer()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('rejects what the web cannot do with the unsupported envelope', async () => {
    const api = createWebApi(fakeEnv(server));
    const envelope = {
      name: 'UnsupportedError',
      code: 'unsupported',
      message: UNSUPPORTED_MESSAGE,
    };
    await expect(api.login('http://x', 'key')).rejects.toMatchObject(envelope);
    await expect(api.openPopout({ room: 'geral', participantId: 'ana' })).rejects.toMatchObject(
      envelope,
    );
    await expect(api.openPip({ room: 'geral', participantIds: [] })).rejects.toMatchObject(
      envelope,
    );
    await expect(api.checkForUpdates()).rejects.toMatchObject(envelope);
    await expect(api.startProcessAudio({ kind: 'source', sourceId: 'x' })).rejects.toMatchObject(
      envelope,
    );
    await expect(api.selectCaptureSource({ sourceId: 'x', systemAudio: false })).rejects.toThrow(
      UNSUPPORTED_MESSAGE,
    );
  });

  it('subscriptions to events the web never emits are no-ops', () => {
    const api = createWebApi(fakeEnv(server));
    for (const subscribe of [
      api.onNavigate,
      api.onStreamToggleRequested,
      api.onOpenSettings,
      api.onStreamingStateChanged,
      api.onPopoutStateChanged,
      api.onPipStateChanged,
      api.onPipTarget,
      api.onPipFullscreenChanged,
      api.onUpdateStatus,
      api.onProcessAudioData,
      api.onJamUploadStatus,
    ]) {
      const unsubscribe = subscribe(() => undefined);
      expect(typeof unsubscribe).toBe('function');
      expect(unsubscribe()).toBeUndefined();
    }
    expect(api.hideToTray()).toBeUndefined();
  });

  it('answers the getters the renderer calls on mount with sane empties', async () => {
    const api = createWebApi(fakeEnv(server));
    await expect(api.getStreamingState()).resolves.toEqual({
      active: false,
      room: null,
      sourceName: null,
      quality: null,
    });
    await expect(api.getPopoutState()).resolves.toEqual({ open: false, target: null });
    await expect(api.getPipState()).resolves.toEqual({ open: false });
    await expect(api.getUpdateStatus()).resolves.toEqual({
      state: 'unsupported',
      reason: WEB_UPDATE_REASON,
    });
    await expect(api.getProcessAudioSupport()).resolves.toEqual({
      supported: false,
      reason: UNSUPPORTED_MESSAGE,
    });
    await expect(api.getCaptureSources()).resolves.toEqual([]);
    await expect(api.getPopoutTarget()).resolves.toBeNull();
    await expect(api.getPipTarget()).resolves.toBeNull();
    await expect(api.getAlwaysOnTop()).resolves.toBe(false);
    await expect(api.getJamUploads()).resolves.toEqual([]);
    await expect(api.prefetchJam(['dQw4w9WgXcQ'])).resolves.toBeUndefined();
    await expect(api.getJam()).resolves.toEqual({ available: false, rooms: {}, serverTime: 0 });
    await expect(api.getPresence()).resolves.toEqual({
      status: { state: 'idle', reason: 'no_session' },
      snapshot: { rooms: {} },
    });
  });

  it('opens the presence stream while someone is logged in, and only then', async () => {
    const env = fakeEnv(server);
    const api = createWebApi(env);
    const changes: Session[] = [];
    api.onSessionChanged((session) => changes.push(session));
    expect(env.sources).toHaveLength(0);

    await expect(api.getSession()).resolves.toEqual({ serverUrl: 'http://localhost', user: USER });
    expect(env.sources).toHaveLength(1);
    expect(env.sources[0]?.url).toBe('/api/presence?jam=1');
    await expect(api.getPresence()).resolves.toMatchObject({
      status: { state: 'connecting', attempt: 1 },
    });

    await api.logout();
    expect(env.sources[0]?.closed).toBe(true);
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
    await expect(api.getPresence()).resolves.toMatchObject({
      status: { state: 'idle', reason: 'no_session' },
    });
  });

  it('stays offline when nobody is logged in', async () => {
    const env = fakeEnv(() => jsonResponse(401, { error: 'unauthorized', message: 'x' }));
    const api = createWebApi(env);
    await expect(api.getSession()).resolves.toEqual({ serverUrl: 'http://localhost', user: null });
    expect(env.sources).toHaveLength(0);
  });

  it('a 401 after the login means the session expired: the UI goes back to the login', async () => {
    let loggedIn = true;
    const env = fakeEnv((path, init) =>
      loggedIn ? server(path, init) : jsonResponse(401, { error: 'unauthorized', message: 'x' }),
    );
    const api = createWebApi(env);
    const changes: Session[] = [];
    api.onSessionChanged((session) => changes.push(session));
    await api.getSession();
    loggedIn = false;
    await expect(api.getRooms()).rejects.toMatchObject({ message: SESSION_EXPIRED_MESSAGE });
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
    expect(env.sources[0]?.closed).toBe(true);
  });

  it('the presence stream being refused re-checks the session', async () => {
    let loggedIn = true;
    const env = fakeEnv((path, init) =>
      loggedIn ? server(path, init) : jsonResponse(401, { error: 'unauthorized', message: 'x' }),
    );
    const api = createWebApi(env);
    const changes: Session[] = [];
    api.onSessionChanged((session) => changes.push(session));
    await api.getSession();
    loggedIn = false;
    env.sources[0]?.fail();
    // `revalidate` runs in the background.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
  });

  it('keeps the settings in localStorage', async () => {
    const env = fakeEnv(server);
    const api = createWebApi(env);
    const seen: unknown[] = [];
    api.onSettingsChanged((settings) => seen.push(settings.viewerSounds));
    await expect(api.getSettings()).resolves.toMatchObject({
      serverUrl: 'http://localhost',
      viewerSounds: true,
    });
    await api.updateSettings({ viewerSounds: false });
    expect(JSON.parse(env.stored.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      viewerSounds: false,
    });
    expect(seen).toEqual([false]);
  });

  it('opens links in a new tab and tolerates a refused fullscreen', async () => {
    const env = fakeEnv(server);
    const api = createWebApi(env);
    await api.openExternal('https://example.com/');
    expect(env.opened).toEqual(['https://example.com/']);

    const seen: boolean[] = [];
    api.onFullscreenChanged((enabled) => seen.push(enabled));
    await api.setFullscreen(true);
    expect(env.fullscreen.active).toBe(true);
    await api.setFullscreen(true);
    expect(env.fullscreen.requests).toBe(1);
    await api.setFullscreen(false);
    expect(seen).toEqual([true, false]);

    env.fullscreen.request = async () => {
      throw new DOMException('not allowed', 'NotAllowedError');
    };
    await expect(api.setFullscreen(true)).resolves.toBeUndefined();
  });

  it('adds songs through the queue route and keeps the jam messages', async () => {
    const env = fakeEnv(server);
    const api = createWebApi(env);
    await expect(api.addToJam('geral', 'dQw4w9WgXcQ')).resolves.toEqual(ITEM);
    expect(env.calls[0]).toMatchObject({
      path: '/api/rooms/geral/jam/queue',
      json: { videoId: 'dQw4w9WgXcQ' },
    });
    await expect(api.searchJam('rick')).resolves.toEqual([ITEM.track]);
    await expect(api.getJamRecent()).resolves.toEqual([]);
    await expect(api.skipJam('geral', 'item-1')).resolves.toBeUndefined();
    expect(env.calls[3]).toMatchObject({
      path: '/api/rooms/geral/jam/skip',
      init: { method: 'POST' },
      json: { itemId: 'item-1' },
    });
  });

  it('jam errors: known codes get the app wording, unknown ones keep the server message', async () => {
    const api = createWebApi(
      fakeEnv((path) => {
        if (path === '/api/rooms/geral/jam/queue') {
          return jsonResponse(503, { error: 'no_downloader', message: 'Ninguém para baixar.' });
        }
        if (path === '/api/rooms/geral/jam/pause') {
          return jsonResponse(403, { error: 'not_in_room', message: 'whatever' });
        }
        return emptyResponse(404);
      }),
    );
    await expect(api.addToJam('geral', 'dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'no_downloader',
      status: 503,
      message: 'Ninguém para baixar.',
    });
    await expect(api.pauseJam('geral')).rejects.toMatchObject({
      code: 'not_in_room',
      message: JAM_ERROR_MESSAGES.not_in_room,
    });
  });
});
