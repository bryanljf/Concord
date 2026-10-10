import type { PresenceEvent, PresenceSnapshot } from '@telao/shared';
import type { NavigateTarget, PresenceConnectionStatus } from '../preload/api';
import type { ProcessWatcher } from './discord-watcher';
import { log } from './log';
import type { Notifier } from './notifications';
import type { PresenceClient } from './presence-client';
import type { SessionManager } from './session';
import type { SettingsStore } from './settings';

const logger = log('presence-ctl');

export type TrayState = 'offline' | 'idle' | 'live';

export interface TrayStatus {
  state: TrayState;
  /** pt-BR detail for the tooltip when live, e.g. "Fulano ao vivo em #jogos". */
  detail: string | null;
}

/** Derives the tray icon state from the connection status and the current snapshot (pure). */
export function computeTrayStatus(
  status: PresenceConnectionStatus,
  snapshot: PresenceSnapshot,
): TrayStatus {
  if (status.state !== 'connected') return { state: 'offline', detail: null };
  const live: { name: string; room: string }[] = [];
  for (const [room, participants] of Object.entries(snapshot.rooms)) {
    for (const participant of participants) {
      if (participant.streaming) live.push({ name: participant.name, room });
    }
  }
  const first = live[0];
  if (!first) return { state: 'idle', detail: null };
  if (live.length === 1)
    return { state: 'live', detail: `${first.name} ao vivo em #${first.room}` };
  return { state: 'live', detail: `${live.length} transmissões ao vivo` };
}

export interface PresenceControllerDeps {
  settings: SettingsStore;
  session: SessionManager;
  discord: ProcessWatcher;
  client: PresenceClient;
  notifier: Notifier;
}

export type TrayStatusListener = (status: TrayStatus) => void;
export type NavigateListener = (target: NavigateTarget) => void;

/**
 * Decides when the presence connection should be up (stored session, and Discord running when
 * `followDiscord` is on), derives the tray state from it and raises the "ao vivo" notifications.
 */
export class PresenceController {
  private trayStatus: TrayStatus = { state: 'offline', detail: null };
  private readonly trayListeners = new Set<TrayStatusListener>();
  private readonly navigateListeners = new Set<NavigateListener>();
  private subscriptions: (() => void)[] = [];

  constructor(private readonly deps: PresenceControllerDeps) {}

  start(): void {
    const { settings, session, discord, client } = this.deps;
    this.subscriptions = [
      settings.onChange((next, previous) => {
        if (next.serverUrl !== previous.serverUrl) this.evaluate(true);
        else if (next.followDiscord !== previous.followDiscord) this.evaluate();
      }),
      session.onChange(() => this.evaluate(true)),
      discord.onChange(() => this.evaluate()),
      client.onStatus(() => this.refreshTray()),
      client.onEvent((event) => this.handleEvent(event)),
    ];
    this.evaluate();
  }

  stop(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
  }

  /** Connects or disconnects according to the current session, settings and Discord state. */
  evaluate(forceReconnect = false): void {
    const { settings, session, discord, client } = this.deps;
    if (!session.isAuthenticated()) {
      logger.info('presence idle (no session)');
      client.disconnect('no_session');
      return;
    }
    if (settings.get().followDiscord && !discord.isRunning) {
      logger.info('presence idle (Discord closed)');
      client.disconnect('discord_closed');
      return;
    }
    logger.info(forceReconnect ? 'presence reconnecting' : 'presence should be connected');
    if (forceReconnect) client.reconnect();
    else client.connect();
  }

  getTrayStatus(): TrayStatus {
    return this.trayStatus;
  }

  onTrayStatus(listener: TrayStatusListener): () => void {
    this.trayListeners.add(listener);
    return () => {
      this.trayListeners.delete(listener);
    };
  }

  /** Fired when a notification is clicked: the window should open on that stream. */
  onNavigate(listener: NavigateListener): () => void {
    this.navigateListeners.add(listener);
    return () => {
      this.navigateListeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------

  private refreshTray(): void {
    const { client } = this.deps;
    const next = computeTrayStatus(client.getStatus(), client.getSnapshot());
    if (next.state === this.trayStatus.state && next.detail === this.trayStatus.detail) return;
    this.trayStatus = next;
    logger.info(`tray → ${next.state}${next.detail ? ` (${next.detail})` : ''}`);
    for (const listener of this.trayListeners) listener(next);
  }

  private handleEvent(event: PresenceEvent): void {
    this.refreshTray();
    if (event.type !== 'stream_started') return;
    const { session, settings, client, notifier } = this.deps;
    const user = session.get().user;
    if (user && event.participantId === user.id) return;
    const { mutedRooms, mutedUsers } = settings.get();
    if (mutedRooms.includes(event.room) || mutedUsers.includes(event.participantId)) {
      logger.info(`notification muted for ${event.participantId} in #${event.room}`);
      return;
    }
    const participant = client
      .getSnapshot()
      .rooms[event.room]?.find((candidate) => candidate.id === event.participantId);
    const name = participant?.name ?? event.participantId;
    const target: NavigateTarget = { room: event.room, participantId: event.participantId };
    notifier.show({
      title: `🔴 ${name} está ao vivo em #${event.room}`,
      body: 'Clique para assistir',
      onClick: () => {
        for (const listener of this.navigateListeners) listener(target);
      },
    });
  }
}
