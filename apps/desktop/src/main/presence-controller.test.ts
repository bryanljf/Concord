import type { PresenceEvent, PresenceSnapshot } from '@telao/shared';
import { describe, expect, it, vi } from 'vitest';
import type { NavigateTarget, PresenceConnectionStatus, Session } from '../preload/api';
import type { ProcessWatcher } from './discord-watcher';
import type { NotificationRequest, Notifier } from './notifications';
import type { PresenceClient } from './presence-client';
import { computeTrayStatus, PresenceController } from './presence-controller';
import type { SessionManager } from './session';
import { defaultSettings, type SettingsStore } from './settings';

const ana = { id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 };
const beto = { id: 'beto', name: 'Beto', streaming: true, joinedAt: 2 };
const connected: PresenceConnectionStatus = { state: 'connected' };

describe('computeTrayStatus', () => {
  it('is offline unless connected', () => {
    const snapshot: PresenceSnapshot = { rooms: { jogos: [beto] } };
    expect(computeTrayStatus({ state: 'idle', reason: 'no_session' }, snapshot).state).toBe(
      'offline',
    );
    expect(computeTrayStatus({ state: 'connecting', attempt: 2 }, snapshot).state).toBe('offline');
    expect(computeTrayStatus({ state: 'error', message: 'x', retryInMs: 1 }, snapshot).state).toBe(
      'offline',
    );
  });

  it('is idle when nobody streams and live otherwise', () => {
    expect(computeTrayStatus(connected, { rooms: { geral: [ana] } })).toEqual({
      state: 'idle',
      detail: null,
    });
    expect(computeTrayStatus(connected, { rooms: { geral: [ana], jogos: [beto] } })).toEqual({
      state: 'live',
      detail: 'Beto ao vivo em #jogos',
    });
    expect(
      computeTrayStatus(connected, { rooms: { jogos: [beto, { ...ana, streaming: true }] } }),
    ).toEqual({ state: 'live', detail: '2 transmissões ao vivo' });
  });
});

// ---------------------------------------------------------------------------

type Listener<T> = (value: T) => void;

function makeSettings(overrides = {}) {
  let settings = { ...defaultSettings(), ...overrides };
  const listeners = new Set<(next: typeof settings, previous: typeof settings) => void>();
  const store = {
    get: () => settings,
    update: (patch: Partial<typeof settings>) => {
      const previous = settings;
      settings = { ...settings, ...patch };
      for (const listener of listeners) listener(settings, previous);
      return settings;
    },
    onChange: (listener: (next: typeof settings, previous: typeof settings) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store as unknown as SettingsStore;
}

function makeSession(user: Session['user']) {
  let current: Session = { serverUrl: 'http://127.0.0.1:3000', user };
  const listeners = new Set<Listener<Session>>();
  return {
    manager: {
      get: () => current,
      isAuthenticated: () => current.user !== null,
      onChange: (listener: Listener<Session>) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as SessionManager,
    set(next: Session) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function makeDiscord(running: boolean) {
  const listeners = new Set<Listener<boolean>>();
  const watcher = {
    isRunning: running,
    start() {},
    stop() {},
    onChange: (listener: Listener<boolean>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    watcher: watcher as ProcessWatcher,
    set(next: boolean) {
      watcher.isRunning = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function makeClient() {
  let status: PresenceConnectionStatus = { state: 'idle', reason: 'no_session' };
  let snapshot: PresenceSnapshot = { rooms: {} };
  const statusListeners = new Set<Listener<PresenceConnectionStatus>>();
  const eventListeners = new Set<Listener<PresenceEvent>>();
  const client = {
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: () => status,
    getSnapshot: () => snapshot,
    onStatus: (listener: Listener<PresenceConnectionStatus>) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onEvent: (listener: Listener<PresenceEvent>) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
  return {
    client: client as unknown as PresenceClient,
    mocks: client,
    setStatus(next: PresenceConnectionStatus) {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
    emit(event: PresenceEvent, nextSnapshot: PresenceSnapshot) {
      snapshot = nextSnapshot;
      for (const listener of eventListeners) listener(event);
    },
  };
}

function makeNotifier() {
  const shown: NotificationRequest[] = [];
  const notifier: Notifier = { show: (request) => shown.push(request) };
  return { notifier, shown };
}

describe('PresenceController', () => {
  it('connects only with a session and (when following) a running Discord', () => {
    const settings = makeSettings({ followDiscord: true });
    const session = makeSession(null);
    const discord = makeDiscord(false);
    const { client, mocks } = makeClient();
    const controller = new PresenceController({
      settings,
      session: session.manager,
      discord: discord.watcher,
      client,
      notifier: makeNotifier().notifier,
    });

    controller.start();
    expect(mocks.disconnect).toHaveBeenLastCalledWith('no_session');

    session.set({
      serverUrl: 'http://127.0.0.1:3000',
      user: { id: 'bryan', displayName: 'B', admin: false },
    });
    expect(mocks.disconnect).toHaveBeenLastCalledWith('discord_closed');
    expect(mocks.connect).not.toHaveBeenCalled();

    discord.set(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);

    // Not following Discord any more: its state no longer matters (connect() is idempotent).
    settings.update({ followDiscord: false });
    discord.set(false);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);

    // A new session (login) forces a fresh connection with the new credentials.
    session.set({
      serverUrl: 'http://127.0.0.1:3000',
      user: { id: 'ana', displayName: 'A', admin: false },
    });
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);

    controller.stop();
    discord.set(true);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it('tracks the tray state and notifies about other people going live', () => {
    const settings = makeSettings({
      followDiscord: false,
      mutedRooms: ['filme'],
      mutedUsers: ['carl'],
    });
    const session = makeSession({ id: 'bryan', displayName: 'Bryan', admin: false });
    const { client, setStatus, emit } = makeClient();
    const { notifier, shown } = makeNotifier();
    const controller = new PresenceController({
      settings,
      session: session.manager,
      discord: makeDiscord(true).watcher,
      client,
      notifier,
    });
    const trayStates: string[] = [];
    const targets: NavigateTarget[] = [];
    controller.onTrayStatus((status) => trayStates.push(status.state));
    controller.onNavigate((target) => targets.push(target));
    controller.start();

    setStatus({ state: 'connected' });
    expect(trayStates).toEqual(['idle']);

    const liveAna = { ...ana, streaming: true };
    emit(
      { type: 'stream_started', room: 'jogos', participantId: 'ana' },
      { rooms: { jogos: [liveAna] } },
    );
    expect(trayStates).toEqual(['idle', 'live']);
    expect(controller.getTrayStatus()).toEqual({ state: 'live', detail: 'Ana ao vivo em #jogos' });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: '🔴 Ana está ao vivo em #jogos',
      body: 'Clique para assistir',
    });
    shown[0]?.onClick?.();
    expect(targets).toEqual([{ room: 'jogos', participantId: 'ana' }]);

    // Own streams, muted rooms and muted users stay silent.
    emit(
      { type: 'stream_started', room: 'jogos', participantId: 'bryan' },
      { rooms: { jogos: [liveAna] } },
    );
    emit(
      { type: 'stream_started', room: 'filme', participantId: 'beto' },
      { rooms: { jogos: [liveAna] } },
    );
    emit(
      { type: 'stream_started', room: 'jogos', participantId: 'carl' },
      { rooms: { jogos: [liveAna] } },
    );
    expect(shown).toHaveLength(1);

    emit(
      { type: 'stream_stopped', room: 'jogos', participantId: 'ana' },
      { rooms: { jogos: [ana] } },
    );
    expect(trayStates).toEqual(['idle', 'live', 'idle']);
    setStatus({ state: 'error', message: 'x', retryInMs: 5 });
    expect(trayStates).toEqual(['idle', 'live', 'idle', 'offline']);
    controller.stop();
  });
});
