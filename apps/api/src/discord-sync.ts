import type { UserStore } from './auth';
import type { Logger } from './logger';
import { discordProfileData, parseDiscordUser, type ProfileStore } from './profiles';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';
/** Discord asks bots to identify themselves as `DiscordBot ($url, $version)`. */
const USER_AGENT = 'DiscordBot (https://github.com/bryanljf/Concord, 1.0)';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordSyncOptions {
  users: UserStore;
  profiles: ProfileStore;
  botToken: string;
  log: Logger;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Delay before the first run (default 5 s). */
  initialDelayMs?: number;
  /** Time between runs (default 6 h). */
  intervalMs?: number;
  /** Pause between two users of the same run (default 1 s). */
  requestDelayMs?: number;
  /** Attempts per user when Discord answers 429 (default 3). */
  maxAttempts?: number;
}

export interface DiscordSyncSummary {
  users: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface DiscordSync {
  /** Runs again as soon as possible (after the current run, if one is in progress). */
  trigger(): void;
  stop(): void;
}

/** Longest 429 wait honoured; anything longer is treated as a failure for this run. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Seconds to wait from a 429: the JSON `retry_after`, else the Retry-After header, else 1 s. */
async function retryAfterMs(response: Response): Promise<number> {
  try {
    const body = (await response.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number' && body.retry_after >= 0) {
      return Math.ceil(body.retry_after * 1000);
    }
  } catch {
    // fall through to the header
  }
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header >= 0 ? Math.ceil(header * 1000) : 1000;
}

class InvalidBotTokenError extends Error {
  override name = 'InvalidBotTokenError';
}

/**
 * Periodically refreshes Discord names and avatars with a bot token (`GET /users/{id}` needs no
 * shared server or privileged intent). Sequential and slow on purpose; never throws.
 */
export function startDiscordSync(options: DiscordSyncOptions): DiscordSync {
  const {
    users,
    profiles,
    botToken,
    log,
    fetch: fetchImpl = (input, init) => fetch(input, init),
    initialDelayMs = 5000,
    intervalMs = 6 * 60 * 60_000,
    requestDelayMs = 1000,
    maxAttempts = 3,
  } = options;
  const controller = new AbortController();
  const { signal } = controller;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;

  async function fetchDiscordUser(discordUserId: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(`${DISCORD_API_BASE}/users/${discordUserId}`, {
        headers: { authorization: `Bot ${botToken}`, 'user-agent': USER_AGENT },
        signal,
      });
      if (response.ok) return response.json();
      if (response.status === 401) throw new InvalidBotTokenError('Discord rejected the bot token');
      if (response.status !== 429) throw new Error(`Discord answered ${response.status}`);
      const waitMs = await retryAfterMs(response);
      if (attempt >= maxAttempts || waitMs > MAX_RETRY_AFTER_MS) {
        throw new Error(`still rate limited after ${attempt} attempts`);
      }
      log.warn({ discordUserId, waitMs }, 'Discord rate limit hit, waiting');
      await sleep(waitMs, signal);
      if (signal.aborted) throw new Error('stopped');
    }
  }

  async function runOnce(): Promise<DiscordSyncSummary> {
    const targets = users.all().filter((user) => user.discordUserId !== undefined);
    const summary: DiscordSyncSummary = {
      users: targets.length,
      updated: 0,
      unchanged: 0,
      failed: 0,
    };
    for (const [index, user] of targets.entries()) {
      if (signal.aborted) break;
      if (index > 0) await sleep(requestDelayMs, signal);
      if (signal.aborted) break;
      const discordUserId = user.discordUserId as string;
      try {
        const discordUser = parseDiscordUser(await fetchDiscordUser(discordUserId));
        if (!discordUser) throw new Error('invalid Discord user payload');
        const before = profiles.get(user.id);
        const data = discordProfileData(discordUser);
        await profiles.setDiscord(user.id, data);
        if (before?.discordName === data.discordName && before.avatarUrl === data.avatarUrl) {
          summary.unchanged += 1;
        } else {
          summary.updated += 1;
        }
      } catch (err) {
        if (signal.aborted) break;
        summary.failed += 1;
        if (err instanceof InvalidBotTokenError) {
          log.error({ err }, 'DISCORD_BOT_TOKEN is invalid; Discord profile sync skipped');
          break;
        }
        log.warn({ err, userId: user.id, discordUserId }, 'Discord profile sync failed for user');
      }
    }
    return summary;
  }

  function schedule(delayMs: number): void {
    if (timer) clearTimeout(timer);
    if (!signal.aborted) timer = setTimeout(() => void run(), delayMs);
  }

  async function run(): Promise<void> {
    timer = undefined;
    if (running || signal.aborted) return;
    running = true;
    pending = false;
    try {
      const summary = await runOnce();
      if (!signal.aborted) log.info({ ...summary }, 'Discord profile sync finished');
    } catch (err) {
      if (!signal.aborted) log.error({ err }, 'Discord profile sync crashed');
    } finally {
      running = false;
    }
    schedule(pending ? 0 : intervalMs);
  }

  schedule(initialDelayMs);
  return {
    trigger(): void {
      if (signal.aborted) return;
      if (running) pending = true;
      else schedule(0);
    },
    stop(): void {
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
