import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserStore, type User } from '../src/auth';
import { DISCORD_API_BASE, startDiscordSync, type FetchLike } from '../src/discord-sync';
import { ProfileStore } from '../src/profiles';
import { ALICE, BOB, fakeLogger } from './helpers';

const ANA_ID = '222222222222222222';
const BOB_ID = '333333333333333333';
const CAROL: User = { id: 'carol', displayName: 'Carol', key: 'carol-key-0123456789abcdef' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function discordUser(id: string, globalName: string | null, avatar: string | null = null) {
  return { id, username: `u${id.slice(0, 3)}`, global_name: globalName, avatar };
}

function setup(fetchImpl: FetchLike, users: User[] = []) {
  const store = new UserStore(
    users.length
      ? users
      : [
          { ...ALICE, discordUserId: ANA_ID },
          { ...BOB, discordUserId: BOB_ID },
          CAROL, // no Discord id: never fetched
        ],
  );
  const profiles = new ProfileStore();
  const log = fakeLogger();
  const fetchMock = vi.fn(fetchImpl);
  const sync = startDiscordSync({
    users: store,
    profiles,
    botToken: 'bot-token',
    log,
    fetch: fetchMock,
    requestDelayMs: 100,
  });
  return { users: store, profiles, log, fetchMock, sync };
}

describe('startDiscordSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 5 s, then fetches every linked user sequentially with the bot token', async () => {
    const { profiles, log, fetchMock, sync } = setup(async (url) =>
      url.endsWith(ANA_ID)
        ? json(discordUser(ANA_ID, 'Ana Clara', 'abcdef0123456789abcdef0123456789'))
        : json(discordUser(BOB_ID, null)),
    );

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${DISCORD_API_BASE}/users/${ANA_ID}`);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bot bot-token');
    expect(headers['user-agent']).toMatch(/^DiscordBot \(/);

    await vi.advanceTimersByTimeAsync(100); // small pause between users
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(profiles.get('alice')).toMatchObject({
      discordName: 'Ana Clara',
      avatarUrl: `https://cdn.discordapp.com/avatars/${ANA_ID}/abcdef0123456789abcdef0123456789.png?size=128`,
    });
    expect(profiles.get('bob')).toMatchObject({
      discordName: `u${BOB_ID.slice(0, 3)}`,
      avatarUrl: 'https://cdn.discordapp.com/embed/avatars/4.png',
    });
    expect(profiles.get('carol')).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      { users: 2, updated: 2, unchanged: 0, failed: 0 },
      expect.any(String),
    );
    sync.stop();
  });

  it('runs again every 6 h and reports unchanged profiles', async () => {
    const { log, fetchMock, sync } = setup(async (url) =>
      json(discordUser(url.slice(-18), 'Same')),
    );
    await vi.advanceTimersByTimeAsync(5000 + 100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1 + 100);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(log.info).toHaveBeenLastCalledWith(
      { users: 2, updated: 0, unchanged: 2, failed: 0 },
      expect.any(String),
    );
    sync.stop();
  });

  it('honours 429 retry_after and retries the same user', async () => {
    let calls = 0;
    const { profiles, log, fetchMock, sync } = setup(async () => {
      calls += 1;
      if (calls === 1) {
        return json(
          { message: 'You are being rate limited.', retry_after: 2.5, global: false },
          429,
        );
      }
      return json(discordUser(ANA_ID, 'Ana'));
    }, [{ ...ALICE, discordUserId: ANA_ID }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { discordUserId: ANA_ID, waitMs: 2500 },
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(2499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(profiles.get('alice')?.discordName).toBe('Ana');
    expect(log.info).toHaveBeenCalledWith(
      { users: 1, updated: 1, unchanged: 0, failed: 0 },
      expect.any(String),
    );
    sync.stop();
  });

  it('falls back to the Retry-After header and gives up after 3 attempts', async () => {
    const { profiles, log, fetchMock, sync } = setup(
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      [{ ...ALICE, discordUserId: ANA_ID }],
    );
    await vi.advanceTimersByTimeAsync(5000 + 1000 + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(profiles.get('alice')).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      { users: 1, updated: 0, unchanged: 0, failed: 1 },
      expect.any(String),
    );
    sync.stop();
  });

  it('keeps going after per-user failures and never throws', async () => {
    const { profiles, log, sync } = setup(async (url) => {
      if (url.endsWith(ANA_ID)) throw new TypeError('fetch failed');
      return json(discordUser(BOB_ID, 'Bob D.'));
    });
    await vi.advanceTimersByTimeAsync(5000 + 100);
    expect(profiles.get('bob')?.discordName).toBe('Bob D.');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'alice', discordUserId: ANA_ID }),
      expect.any(String),
    );
    expect(log.info).toHaveBeenCalledWith(
      { users: 2, updated: 1, unchanged: 0, failed: 1 },
      expect.any(String),
    );
    sync.stop();
  });

  it('stops the run on an invalid bot token (401)', async () => {
    const { log, fetchMock, sync } = setup(async () => json({ message: '401: Unauthorized' }, 401));
    await vi.advanceTimersByTimeAsync(5000 + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { users: 2, updated: 0, unchanged: 0, failed: 1 },
      expect.any(String),
    );
    sync.stop();
  });

  it('trigger() runs right away, and again after an in-progress run', async () => {
    const { fetchMock, sync } = setup(async (url) => json(discordUser(url.slice(-18), 'X')));
    sync.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // first user of the triggered run
    sync.trigger(); // during the run: queued
    await vi.advanceTimersByTimeAsync(100); // second user, then the run ends
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // the queued run starts at once
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4); // the initial 5 s timer was replaced
    sync.stop();
  });

  it('stop() cancels pending waits and future runs', async () => {
    const { fetchMock, log, sync } = setup(async () =>
      json({ message: 'rate limited', retry_after: 30 }, 429),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    sync.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    sync.trigger(); // no-op after stop
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
