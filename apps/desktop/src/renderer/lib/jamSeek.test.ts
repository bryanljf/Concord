import { describe, expect, it } from 'vitest';
import type { JamNowPlaying, JamTrack } from '@concord/shared';
import {
  JAM_SEEK_PAGE_STEP_MS,
  JAM_SEEK_STEP_MS,
  JAM_SEEK_TOLERANCE_MS,
  clampSeekPosition,
  createJamSeekSender,
  jamSeekShown,
  jamSeekStands,
  jamSeekable,
  seekFraction,
  seekKeyTarget,
  seekPositionAt,
  seekValueText,
  type JamSeekOutcome,
  type JamSeekTarget,
} from './jamSeek';

const DURATION = 210_000; // 3:30

const track: JamTrack = {
  videoId: '4D7u5KF7SP8',
  title: 'Get Lucky',
  artists: 'Daft Punk, Pharrell Williams',
  album: 'Random Access Memories',
  durationMs: DURATION,
  artworkUrl: null,
};

const nowPlaying = (overrides: Partial<JamNowPlaying> = {}): JamNowPlaying => ({
  item: { id: 'a', track, requestedBy: 'ana', addedAt: 1, status: 'ready' },
  positionMs: 10_000,
  at: 100_000,
  paused: false,
  pausedBy: null,
  ...overrides,
});

/** Chosen at server time 101_000 on `basis`: 73 s (1:13). */
const target = (basis: JamNowPlaying, overrides: Partial<JamSeekTarget> = {}): JamSeekTarget => ({
  id: 1,
  itemId: basis.item.id,
  positionMs: 73_000,
  at: 101_000,
  basis,
  settled: false,
  ...overrides,
});

describe('positions', () => {
  it('seeks only songs with a known duration', () => {
    expect(jamSeekable(DURATION)).toBe(true);
    expect(jamSeekable(0)).toBe(false);
    expect(jamSeekable(-1)).toBe(false);
    expect(jamSeekable(Number.NaN)).toBe(false);
  });

  it('sends whole milliseconds within the song', () => {
    expect(clampSeekPosition(73_000.6, DURATION)).toBe(73_001);
    expect(clampSeekPosition(-500, DURATION)).toBe(0);
    expect(clampSeekPosition(DURATION + 1, DURATION)).toBe(DURATION);
    expect(clampSeekPosition(Number.NaN, DURATION)).toBe(0);
    expect(clampSeekPosition(73_000, 0)).toBe(0);
  });

  it('reads the pointer along the bar, clamped to its ends', () => {
    expect(seekFraction(150, 100, 200)).toBe(0.25);
    expect(seekFraction(40, 100, 200)).toBe(0);
    expect(seekFraction(400, 100, 200)).toBe(1);
    // A bar not laid out yet, or a broken reading.
    expect(seekFraction(150, 100, 0)).toBe(0);
    expect(seekFraction(Number.NaN, 100, 200)).toBe(0);
  });

  it('turns the pointer into a whole position of the song', () => {
    const bar = { left: 100, width: 200 };
    expect(seekPositionAt(150, bar, DURATION)).toBe(52_500);
    expect(seekPositionAt(0, bar, DURATION)).toBe(0);
    expect(seekPositionAt(1_000, bar, DURATION)).toBe(DURATION);
    // 33/200 of 3:31.111 is 34_833.315 ms: IPC only takes whole numbers.
    const odd = seekPositionAt(133, bar, 211_111);
    expect(odd).toBe(34_833);
    expect(Number.isInteger(odd)).toBe(true);
    expect(seekPositionAt(133.7, { left: 0.3, width: 199.9 }, DURATION) % 1).toBe(0);
  });
});

describe('keyboard', () => {
  it('steps 5 s with the arrows and 30 s with Page Up / Page Down', () => {
    expect(seekKeyTarget('ArrowRight', 60_000, DURATION)).toBe(60_000 + JAM_SEEK_STEP_MS);
    expect(seekKeyTarget('ArrowUp', 60_000, DURATION)).toBe(65_000);
    expect(seekKeyTarget('ArrowLeft', 60_000, DURATION)).toBe(55_000);
    expect(seekKeyTarget('ArrowDown', 60_000, DURATION)).toBe(55_000);
    expect(seekKeyTarget('PageUp', 60_000, DURATION)).toBe(60_000 + JAM_SEEK_PAGE_STEP_MS);
    expect(seekKeyTarget('PageDown', 60_000, DURATION)).toBe(30_000);
  });

  it('goes to the start and the end, never past them', () => {
    expect(seekKeyTarget('Home', 60_000, DURATION)).toBe(0);
    expect(seekKeyTarget('End', 60_000, DURATION)).toBe(DURATION);
    expect(seekKeyTarget('ArrowLeft', 3_000, DURATION)).toBe(0);
    expect(seekKeyTarget('ArrowRight', DURATION - 2_000, DURATION)).toBe(DURATION);
    // From where the bar shows it (a fraction of a millisecond on the clock): whole numbers.
    expect(seekKeyTarget('ArrowRight', 12_345.4, DURATION)).toBe(17_345);
  });

  it('ignores other keys and songs without a duration', () => {
    expect(seekKeyTarget('Enter', 60_000, DURATION)).toBeNull();
    expect(seekKeyTarget(' ', 60_000, DURATION)).toBeNull();
    expect(seekKeyTarget('ArrowRight', 60_000, 0)).toBeNull();
  });

  it('reads the value out in pt-BR', () => {
    expect(seekValueText(73_000, DURATION)).toBe('1:13 de 3:30');
    expect(seekValueText(73_999, DURATION)).toBe('1:13 de 3:30');
    expect(seekValueText(73_000, 0)).toBe('1:13');
  });
});

describe('optimistic position', () => {
  it('moves on from the chosen position while playing, frozen while paused', () => {
    const basis = nowPlaying();
    expect(jamSeekShown(basis, target(basis))).toMatchObject({ positionMs: 73_000, at: 101_000 });
    const shown = jamSeekShown(basis, target(basis));
    expect(shown.item).toBe(basis.item);
    expect(shown.paused).toBe(false);
    const paused = nowPlaying({ paused: true, pausedBy: 'ana' });
    expect(jamSeekShown(paused, target(paused)).paused).toBe(true);
  });

  it('stands while the server has nothing new', () => {
    const basis = nowPlaying();
    expect(jamSeekStands(target(basis), basis, 105_000)).toBe(true);
    // The same state again (a snapshot replayed): still nothing new.
    expect(jamSeekStands(target(basis), { ...basis }, 105_000)).toBe(true);
    expect(jamSeekStands(target(basis, { settled: true }), { ...basis }, 105_000)).toBe(true);
  });

  it('gives way to another song', () => {
    const basis = nowPlaying();
    const next = nowPlaying({ item: { ...basis.item, id: 'b' }, positionMs: 0, at: 102_000 });
    expect(jamSeekStands(target(basis), next, 105_000)).toBe(false);
  });

  it('gives way to the state that shows the seek, even before the answer', () => {
    const basis = nowPlaying();
    // The server moved it there at 101_200 (the request's trip): 200 ms behind the target.
    const seeked = nowPlaying({ positionMs: 73_000, at: 101_200 });
    expect(jamSeekStands(target(basis), seeked, 105_000)).toBe(false);
    // The bot reports where it really started, a little off.
    const reported = nowPlaying({ positionMs: 73_400, at: 101_000 + JAM_SEEK_TOLERANCE_MS });
    expect(jamSeekStands(target(basis), reported, 105_000)).toBe(false);
    // Paused, the seek keeps it paused at the new position.
    const paused = nowPlaying({ paused: true, pausedBy: 'ana' });
    const seekedPaused = nowPlaying({ positionMs: 73_000, at: 101_300, paused: true });
    expect(jamSeekStands(target(paused), seekedPaused, 109_000)).toBe(false);
  });

  it('outlasts an older change while the request is on its way, not after the answer', () => {
    const basis = nowPlaying();
    // Someone added a song before the server saw the seek: the same playback, re-sent.
    const older = nowPlaying({ positionMs: 10_900, at: 100_900 });
    expect(jamSeekStands(target(basis), older, 105_000)).toBe(true);
    // The server answered: whatever it says now (clamped, someone else seeked…) wins.
    expect(jamSeekStands(target(basis, { settled: true }), older, 105_000)).toBe(false);
  });

  it('follows a pause or a resume that also shows the seek', () => {
    const basis = nowPlaying();
    // Someone paused right after the seek: 73 s + 300 ms of playing.
    const pausedThere = nowPlaying({ positionMs: 73_300, at: 101_300, paused: true });
    expect(jamSeekStands(target(basis), pausedThere, 101_500)).toBe(false);
  });
});

function deferred(): { promise: Promise<void>; resolve(): void; reject(err: unknown): void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createJamSeekSender', () => {
  function setup() {
    const calls: { request: number; answer: ReturnType<typeof deferred> }[] = [];
    const errors: unknown[] = [];
    const sender = createJamSeekSender<number>(
      (request) => {
        const answer = deferred();
        calls.push({ request, answer });
        return answer.promise;
      },
      (err) => errors.push(err),
    );
    return { calls, errors, sender };
  }

  it('sends right away when nothing is on its way', async () => {
    const { calls, sender } = setup();
    const outcome = sender.send(10_000);
    await flush();
    expect(calls.map((call) => call.request)).toEqual([10_000]);
    calls[0]?.answer.resolve();
    await expect(outcome).resolves.toBe('done');
  });

  it('sends one at a time, the latest winning', async () => {
    const { calls, sender } = setup();
    const outcomes: Promise<JamSeekOutcome>[] = [
      sender.send(10_000),
      sender.send(20_000),
      sender.send(30_000),
    ];
    await flush();
    // The second never goes out: the third replaced it while the first was on its way.
    expect(calls.map((call) => call.request)).toEqual([10_000]);
    await expect(outcomes[1]).resolves.toBe('replaced');
    calls[0]?.answer.resolve();
    await expect(outcomes[0]).resolves.toBe('done');
    await flush();
    expect(calls.map((call) => call.request)).toEqual([10_000, 30_000]);
    calls[1]?.answer.resolve();
    await expect(outcomes[2]).resolves.toBe('done');
  });

  it('reports a refusal and goes on with the next one', async () => {
    const { calls, errors, sender } = setup();
    const first = sender.send(10_000);
    const second = sender.send(20_000);
    await flush();
    const refusal = new Error('Você não está nesta sala.');
    calls[0]?.answer.reject(refusal);
    await expect(first).resolves.toBe('failed');
    expect(errors).toEqual([refusal]);
    await flush();
    expect(calls.map((call) => call.request)).toEqual([10_000, 20_000]);
    calls[1]?.answer.resolve();
    await expect(second).resolves.toBe('done');
  });

  it('turns a missing bridge (a synchronous throw) into a refusal', async () => {
    const errors: unknown[] = [];
    const sender = createJamSeekSender<number>(
      () => {
        throw new Error('A ponte com o aplicativo não está disponível.');
      },
      (err) => errors.push(err),
    );
    await expect(sender.send(10_000)).resolves.toBe('failed');
    expect(errors).toHaveLength(1);
    // Never stuck: the next one is tried too.
    await expect(sender.send(20_000)).resolves.toBe('failed');
    expect(errors).toHaveLength(2);
  });
});
