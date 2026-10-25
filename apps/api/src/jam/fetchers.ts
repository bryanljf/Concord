import { randomBytes, randomUUID } from 'node:crypto';
import { JAM_FETCH_PING_MS, type JamFetchEvent } from '@concord/shared';

/** A desktop app able to download songs for others, as the ranking sees it (a copy). */
export interface FetchConnectionInfo {
  /** The presence connection (`GET /api/presence?jam=1&fetch=1`) the app holds. */
  id: string;
  userId: string;
  /** Last measured round trip; null until the first pong, or again after a ping went unanswered. */
  rttMs: number | null;
}

export interface FetchConnectionInit {
  userId: string;
  /** Writes the event to the app's presence stream. */
  send(event: JamFetchEvent): void;
}

interface Connection extends FetchConnectionInfo {
  send(event: JamFetchEvent): void;
  /** The ping not answered yet (one at a time). */
  pending: { nonce: string; sentAt: number } | undefined;
  timer: NodeJS.Timeout | undefined;
}

export interface PickOptions {
  /** Users not to ask (the requester, and whoever was already asked for the song). */
  exclude: ReadonlySet<string>;
  /** Whether the person is in the song's room (asked first). */
  inRoom(userId: string): boolean;
  /** Fetches the connection is busy with (fewest first, as the tie-break). */
  active(connectionId: string): number;
}

export interface JamFetchersOptions {
  /** Interval of the round-trip pings (default JAM_FETCH_PING_MS). */
  pingMs?: number;
  now?: () => number;
  newNonce?: () => string;
}

/** Unknown round trips sort last. */
function compareRtt(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function info(connection: Connection): FetchConnectionInfo {
  return { id: connection.id, userId: connection.userId, rttMs: connection.rttMs };
}

/**
 * The desktop apps that can download a song for a client that cannot (the web): one entry per
 * presence stream opened with `?jam=1&fetch=1`, each pinged right away and every `pingMs` after
 * that (`jam_fetch_ping`; the app answers with `POST /api/jam/fetch/pong`) to measure its round
 * trip. `pick` ranks them for a song: apps whose person is in the song's room first, then lowest
 * round trip (unknown last), then fewest fetches in progress.
 */
export class JamFetchers {
  private readonly entries = new Map<string, Connection>();
  private readonly byNonce = new Map<string, Connection>();
  private readonly pingMs: number;
  private readonly now: () => number;
  private readonly newNonce: () => string;

  constructor(options: JamFetchersOptions = {}) {
    this.pingMs = options.pingMs ?? JAM_FETCH_PING_MS;
    this.now = options.now ?? Date.now;
    this.newNonce = options.newNonce ?? (() => randomBytes(12).toString('base64url'));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Adds a connection (pinged at once); the result removes it (on close). */
  register(init: FetchConnectionInit): () => void {
    const connection: Connection = {
      id: randomUUID(),
      userId: init.userId,
      send: init.send,
      rttMs: null,
      pending: undefined,
      timer: undefined,
    };
    this.entries.set(connection.id, connection);
    connection.timer = setInterval(() => this.ping(connection), this.pingMs);
    connection.timer.unref();
    this.ping(connection);
    return () => this.unregister(connection.id);
  }

  /** Forgets every connection (shutdown). */
  clear(): void {
    for (const id of [...this.entries.keys()]) this.unregister(id);
  }

  has(connectionId: string): boolean {
    return this.entries.has(connectionId);
  }

  /** Whether the person has an app able to download (so their own songs are theirs to send). */
  hasUser(userId: string): boolean {
    for (const connection of this.entries.values()) {
      if (connection.userId === userId) return true;
    }
    return false;
  }

  connections(): FetchConnectionInfo[] {
    return [...this.entries.values()].map(info);
  }

  /**
   * The answer to a ping: records the round trip on the connection it was sent on. False (and
   * nothing recorded) for a nonce that is unknown, already answered, replaced by a newer ping or
   * sent to someone else's app.
   */
  pong(nonce: string, userId: string): boolean {
    const connection = this.byNonce.get(nonce);
    if (!connection || connection.userId !== userId || connection.pending?.nonce !== nonce) {
      return false;
    }
    this.byNonce.delete(nonce);
    connection.rttMs = Math.max(0, this.now() - connection.pending.sentAt);
    connection.pending = undefined;
    return true;
  }

  /** Writes `event` to the connection; false when it is gone (or its stream broke). */
  send(connectionId: string, event: JamFetchEvent): boolean {
    const connection = this.entries.get(connectionId);
    if (!connection) return false;
    try {
      connection.send(event);
      return true;
    } catch {
      return false;
    }
  }

  /** The best connection to ask for a song, if any (see the class comment for the order). */
  pick(options: PickOptions): FetchConnectionInfo | undefined {
    const ranked = [...this.entries.values()]
      .filter((connection) => !options.exclude.has(connection.userId))
      .map((connection) => ({
        connection,
        inRoom: options.inRoom(connection.userId),
        active: options.active(connection.id),
      }))
      .sort(
        (a, b) =>
          Number(b.inRoom) - Number(a.inRoom) ||
          compareRtt(a.connection.rttMs, b.connection.rttMs) ||
          a.active - b.active,
      );
    const best = ranked[0];
    return best ? info(best.connection) : undefined;
  }

  private unregister(connectionId: string): void {
    const connection = this.entries.get(connectionId);
    if (!connection) return;
    if (connection.timer) clearInterval(connection.timer);
    if (connection.pending) this.byNonce.delete(connection.pending.nonce);
    this.entries.delete(connectionId);
  }

  /** Sends a ping; one still unanswered means the round trip is unknown again. */
  private ping(connection: Connection): void {
    if (connection.pending) {
      this.byNonce.delete(connection.pending.nonce);
      connection.rttMs = null;
    }
    const nonce = this.newNonce();
    connection.pending = { nonce, sentAt: this.now() };
    this.byNonce.set(nonce, connection);
    try {
      connection.send({ type: 'jam_fetch_ping', nonce });
    } catch {
      // A broken stream closes soon and unregisters itself.
    }
  }
}
