import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyYtDlpError,
  createJamDownload,
  createYtDlpTemp,
  JAM_DOWNLOAD_MESSAGES,
  JAM_DOWNLOAD_TIMEOUT_MS,
  JamDownloadError,
  runYtDlpVersion,
  startJamDownload,
  YTDLP_VERSION_TIMEOUT_MS,
  ytDlpArgs,
  type JamDownloadOptions,
  type SpawnLike,
} from './download';

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const ID = '4D7u5KF7SP8';

/** A child process whose output and exit the test drives. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  /** Ends both streams, then emits `close` like a real process. */
  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, null));
  }

  /** Writes to stderr, then exits. */
  fail(stderr: string, code = 1): void {
    this.stderr.write(stderr);
    this.exit(code);
  }
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  // Never the real taskkill: these are fake pids.
  const killTree = vi.fn((child: ChildProcess) => {
    (child as unknown as FakeChild).exit(1);
  });
  return { spawn, killTree, children, calls };
}

/** The whole audio once complete (what callers that do not stream wait for). */
async function downloadAll(
  exePath: string,
  videoId: string,
  options: JamDownloadOptions,
): Promise<Buffer> {
  const download = startJamDownload(exePath, videoId, options);
  await download.finished;
  return download.bytes();
}

async function rejection(promise: Promise<unknown>): Promise<JamDownloadError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(JamDownloadError);
    return err as JamDownloadError;
  }
  throw new Error('expected a rejection');
}

/** Reads a whole stream. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const EXE = 'E:\\data\\bin\\yt-dlp\\0123456789ab-01234567\\yt-dlp.exe';
const NODE = 'C:\\Program Files\\Concord\\Concord.exe';

describe('ytDlpArgs', () => {
  it('asks as visionos first, exactly as benchmarked', () => {
    expect(ytDlpArgs(ID, NODE)).toEqual([
      '--ignore-config',
      '--no-cookies',
      '--no-cookies-from-browser',
      '--no-playlist',
      '--no-progress',
      '--quiet',
      '--no-cache-dir',
      '-f',
      'bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]',
      '--no-js-runtimes',
      '--js-runtimes',
      `node:${NODE}`,
      '--extractor-args',
      'youtube:player_client=visionos;skip=hls',
      '-o',
      '-',
      `https://music.youtube.com/watch?v=${ID}`,
    ]);
  });

  it('falls back to the validated invocation with the default clients', () => {
    const visionos = ytDlpArgs(ID, NODE, 'visionos');
    const fallback = ytDlpArgs(ID, NODE, 'default');
    expect(fallback).toEqual(
      visionos.filter(
        (arg) => arg !== '--extractor-args' && arg !== 'youtube:player_client=visionos;skip=hls',
      ),
    );
  });

  it('never involves cookies, an account or skipping the player page', () => {
    for (const clients of ['visionos', 'default'] as const) {
      const args = ytDlpArgs(ID, NODE, clients);
      expect(args.some((arg) => arg === '--cookies' || arg === '--cookies-from-browser')).toBe(
        false,
      );
      expect(args.some((arg) => /username|password|netrc|player_skip/i.test(arg))).toBe(false);
    }
  });
});

describe('createJamDownload', () => {
  it('replays the bytes already here, then follows the live ones', async () => {
    const feed = createJamDownload(ID);
    const { download } = feed;
    feed.push(WEBM.subarray(0, 2));
    let started = false;
    void download.started.then(() => {
      started = true;
    });
    feed.push(WEBM.subarray(2, 6));
    await Promise.resolve();
    expect(started).toBe(true);

    const reader = download.stream().getReader();
    expect(Buffer.from((await reader.read()).value ?? [])).toEqual(WEBM.subarray(0, 2));
    expect(Buffer.from((await reader.read()).value ?? [])).toEqual(WEBM.subarray(2, 6));
    // Nothing more yet: the read waits for the producer.
    const next = reader.read();
    feed.push(WEBM.subarray(6));
    expect(Buffer.from((await next).value ?? [])).toEqual(WEBM.subarray(6));
    const end = reader.read();
    expect(feed.complete()).toBe(true);
    expect((await end).done).toBe(true);

    // Any later stream starts over from the first byte.
    expect(await readAll(download.stream())).toEqual(WEBM);
    expect(download.bytes()).toEqual(WEBM);
    expect(download.state).toBe('complete');
    await expect(download.finished).resolves.toBeUndefined();
  });

  it('errors its streams and drops its bytes when it fails', async () => {
    const feed = createJamDownload(ID);
    const { download } = feed;
    const stop = vi.fn();
    feed.onStop(stop);
    feed.push(WEBM);
    const reader = download.stream().getReader();
    await reader.read();
    const pending = reader.read();
    download.cancel();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    expect(stop).toHaveBeenCalledWith('cancelled');
    expect(download.error?.reason).toBe('cancelled');
    expect(download.bytes()).toEqual(Buffer.alloc(0));
    expect((await rejection(download.finished)).reason).toBe('cancelled');
    // Over is over.
    feed.push(WEBM);
    expect(feed.complete()).toBe(false);
    expect(download.state).toBe('failed');
  });

  it('refuses output that is not WebM as soon as its first bytes show it', async () => {
    const feed = createJamDownload(ID);
    const stop = vi.fn();
    feed.onStop(stop);
    feed.push(Buffer.from('<!doctype html>'));
    expect((await rejection(feed.download.started)).reason).toBe('not_audio');
    expect(stop).toHaveBeenCalledWith('not_audio');
  });

  it('caps the size', async () => {
    const feed = createJamDownload(ID, 10);
    feed.push(WEBM);
    feed.push(WEBM);
    expect((await rejection(feed.download.finished)).reason).toBe('too_large');
  });

  it('needs WebM to complete', async () => {
    const empty = createJamDownload(ID);
    expect(empty.complete()).toBe(false);
    expect((await rejection(empty.download.finished)).reason).toBe('failed');
    const short = createJamDownload(ID);
    short.push(WEBM.subarray(0, 3));
    expect(short.complete()).toBe(false);
    expect((await rejection(short.download.finished)).reason).toBe('not_audio');
  });

  it('never leaves an unhandled rejection behind', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      createJamDownload(ID).download.cancel();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('startJamDownload', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('spawns yt-dlp hidden, without a shell, with Electron as Node, and collects stdout', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const promise = downloadAll(EXE, ID, {
      spawn,
      killTree,
      jsRuntimePath: NODE,
      env: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: undefined },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    expect(call?.command).toBe(EXE);
    expect(call?.args).toEqual(ytDlpArgs(ID, NODE, 'visionos'));
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.shell).toBeUndefined();
    expect(call?.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(call?.options.env).toEqual({ PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' });

    const child = children[0];
    child?.stdout.write(WEBM.subarray(0, 3));
    child?.stdout.write(WEBM.subarray(3));
    child?.exit(0);
    expect(await promise).toEqual(WEBM);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('keeps the current environment by default', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const promise = downloadAll(EXE, ID, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
    expect(calls[0]?.options.env?.PATH ?? calls[0]?.options.env?.Path).toBe(
      process.env.PATH ?? process.env.Path,
    );
    expect(calls[0]?.args).toContain(`node:${process.execPath}`);
    children[0]?.stdout.write(WEBM);
    children[0]?.exit(0);
    await promise;
  });

  it('streams the bytes while yt-dlp still runs', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const download = startJamDownload(EXE, ID, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const reader = download.stream().getReader();
    children[0]?.stdout.write(WEBM);
    await download.started;
    expect(Buffer.from((await reader.read()).value ?? [])).toEqual(WEBM);
    expect(download.state).toBe('running');
    children[0]?.stdout.write(WEBM);
    expect(Buffer.from((await reader.read()).value ?? [])).toEqual(WEBM);
    children[0]?.exit(0);
    expect((await reader.read()).done).toBe(true);
    await download.exited;
    expect(download.size).toBe(16);
  });

  it('stops and kills the process tree above the size cap', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const promise = downloadAll(EXE, ID, { spawn, killTree, maxBytes: 10 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    children[0]?.stdout.write(WEBM);
    children[0]?.stdout.write(WEBM);
    const err = await rejection(promise);
    expect(err.reason).toBe('too_large');
    expect(err.message).toBe(JAM_DOWNLOAD_MESSAGES.too_large);
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it('times out and kills the process tree', async () => {
    const { spawn, killTree, calls } = fakeSpawn();
    const promise = downloadAll(EXE, ID, { spawn, killTree });
    const settled = rejection(promise);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(JAM_DOWNLOAD_TIMEOUT_MS);
    const err = await settled;
    expect(err.reason).toBe('timeout');
    expect(err.message).toBe('O download do YouTube demorou demais.');
    expect(killTree).toHaveBeenCalledTimes(1);
    // No second attempt after a timeout.
    expect(calls).toHaveLength(1);
  });

  it('kills the process tree when cancelled', async () => {
    const { spawn, killTree, calls } = fakeSpawn();
    const controller = new AbortController();
    const download = startJamDownload(EXE, ID, { spawn, killTree, signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    expect((await rejection(download.finished)).reason).toBe('cancelled');
    expect(killTree).toHaveBeenCalledTimes(1);
    await download.exited;
    expect(calls).toHaveLength(1);

    // Already aborted: never even started.
    const again = fakeSpawn();
    const before = startJamDownload(EXE, ID, {
      spawn: again.spawn,
      killTree: again.killTree,
      signal: controller.signal,
    });
    expect((await rejection(before.finished)).reason).toBe('cancelled');
    await before.exited;
    expect(again.calls).toHaveLength(0);
  });

  it('maps a failed exit through stderr', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const promise = downloadAll(EXE, ID, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    children[0]?.fail(
      `ERROR: [youtube] ${ID}: Sign in to confirm you\uFFFDre not a bot. Use --cookies-from-browser or --cookies for the authentication.\n`,
    );
    const err = await rejection(promise);
    expect(err.reason).toBe('blocked');
    expect(err.message).toBe(
      'O YouTube bloqueou o download nesta conexão. Tente de novo mais tarde.',
    );
    expect(err.maybeOutdated).toBe(false);
    // The default clients would be blocked just the same.
    expect(calls).toHaveLength(1);
  });

  it('tries the default clients once when visionos fails before any byte', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const download = startJamDownload(EXE, ID, { spawn, killTree, jsRuntimePath: NODE });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    children[0]?.fail(`ERROR: [youtube] ${ID}: Requested format is not available.\n`);
    // One process at a time: the second starts once the first is gone.
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(children[0]?.exitCode).toBe(1);
    expect(calls[1]?.args).toEqual(ytDlpArgs(ID, NODE, 'default'));
    expect(download.state).toBe('running');
    children[1]?.stdout.write(WEBM);
    children[1]?.exit(0);
    await download.finished;
    expect(download.bytes()).toEqual(WEBM);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('reports the default clients’ failure when both attempts fail', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const download = startJamDownload(EXE, ID, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // No output at all is worth the other attempt too.
    children[0]?.exit(0);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    children[1]?.fail(`ERROR: [youtube] ${ID}: Sign in to confirm your age.\n`);
    const err = await rejection(download.finished);
    expect(err.reason).toBe('age_restricted');
    await download.exited;
    expect(calls).toHaveLength(2);
  });

  it('never starts over once bytes came', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const download = startJamDownload(EXE, ID, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    children[0]?.stdout.write(WEBM);
    children[0]?.fail(`ERROR: unable to download video data: HTTP Error 403: Forbidden\n`);
    expect((await rejection(download.finished)).reason).toBe('outdated');
    await download.exited;
    expect(calls).toHaveLength(1);
  });

  it('rejects an empty or non-WebM output', async () => {
    const empty = fakeSpawn();
    const nothing = downloadAll(EXE, ID, { spawn: empty.spawn, killTree: empty.killTree });
    await vi.waitFor(() => expect(empty.calls).toHaveLength(1));
    empty.children[0]?.exit(0);
    await vi.waitFor(() => expect(empty.calls).toHaveLength(2));
    empty.children[1]?.exit(0);
    expect((await rejection(nothing)).reason).toBe('failed');

    const html = fakeSpawn();
    const page = downloadAll(EXE, ID, { spawn: html.spawn, killTree: html.killTree });
    await vi.waitFor(() => expect(html.calls).toHaveLength(1));
    html.children[0]?.stdout.write('<!doctype html>');
    expect((await rejection(page)).reason).toBe('not_audio');
    // Stopped at once, never tried again.
    expect(html.killTree).toHaveBeenCalledTimes(1);
    expect(html.calls).toHaveLength(1);
  });

  it('reports a binary that cannot run', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const promise = downloadAll(EXE, ID, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    children[0]?.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
    const err = await rejection(promise);
    expect(err.reason).toBe('spawn');
    expect(err.message).toBe(
      'Não foi possível executar o yt-dlp. Veja se o antivírus não o bloqueou.',
    );
    expect(killTree).not.toHaveBeenCalled();

    const throwing: SpawnLike = () => {
      throw new Error('ENOENT');
    };
    expect((await rejection(downloadAll(EXE, ID, { spawn: throwing }))).reason).toBe('spawn');
  });

  it('refuses anything but a video id', async () => {
    const { spawn, calls } = fakeSpawn();
    expect((await rejection(downloadAll(EXE, '--exec=calc', { spawn }))).reason).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('classifyYtDlpError', () => {
  const cases: [string, string][] = [
    ['ERROR: [youtube] x: Sign in to confirm you’re not a bot.', 'blocked'],
    [
      'ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate',
      'age_restricted',
    ],
    ["ERROR: [youtube] x: Private video. Sign in if you've been granted access", 'private'],
    [
      'ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader',
      'unavailable',
    ],
    [
      'ERROR: [youtube] x: Video unavailable. This video is not available in your country',
      'region',
    ],
    ['ERROR: [youtube] x: Join this channel to get access to members-only content', 'members_only'],
    ['ERROR: [youtube] x: This live event will begin in 3 hours.', 'live'],
    ['ERROR: [youtube] x: Requested format is not available. Use --list-formats', 'format'],
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'outdated'],
    ['ERROR: unable to download webpage: HTTP Error 429: Too Many Requests', 'rate_limited'],
    ['ERROR: [youtube] x: Unable to extract yt initial data; please report this issue', 'outdated'],
    [
      'WARNING: [youtube] x: n challenge solving failed: Some formats may be missing\nERROR: [youtube] x: Requested format is not available',
      'format',
    ],
    [
      'ERROR: [youtube] x: Unable to download API page: <urlopen error [Errno 11001] getaddrinfo failed>',
      'network',
    ],
    [
      '[PYI-1234:ERROR] Failed to extract base_library.zip: decompression resulted in return code -1!',
      'no_space',
    ],
    ['ERROR: something nobody has seen before', 'failed'],
    ['', 'failed'],
  ];

  it.each(cases)('%s → %s', (stderr, reason) => {
    expect(classifyYtDlpError(stderr)).toBe(reason);
  });

  it('flags what a newer yt-dlp may fix', () => {
    expect(new JamDownloadError('outdated').maybeOutdated).toBe(true);
    expect(new JamDownloadError('format').maybeOutdated).toBe(true);
    expect(new JamDownloadError('blocked').maybeOutdated).toBe(false);
    expect(new JamDownloadError('unavailable').maybeOutdated).toBe(false);
  });
});

describe('yt-dlp temp folders', () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'concord-ytdlp-temp-'));
    root = join(dir, 'tmp', 'yt-dlp');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Lets the async start (creating the folder) reach `spawn`. */
  async function untilSpawned(calls: unknown[], count = 1): Promise<void> {
    await vi.waitFor(() => expect(calls).toHaveLength(count));
  }

  it('gives each download its own TEMP, removed once its processes are gone', async () => {
    const temp = createYtDlpTemp(root);
    const { spawn, killTree, children, calls } = fakeSpawn();
    const env = { PATH: 'C:/Windows', temp: 'C:/Users/x/AppData/Local/Temp', Tmp: 'old' };
    // One after the other, so that children[0] is the first download's.
    const first = downloadAll(EXE, ID, { spawn, killTree, temp, env });
    await untilSpawned(calls, 1);
    const second = downloadAll(EXE, ID, { spawn, killTree, temp, env });
    await untilSpawned(calls, 2);

    const runDirs = calls.map((call) => call.options.env?.TEMP);
    expect(new Set(runDirs).size).toBe(2);
    for (const call of calls) {
      const runDir = call.options.env?.TEMP;
      expect(runDir?.startsWith(root)).toBe(true);
      expect(call.options.env).toEqual({
        PATH: 'C:/Windows',
        ELECTRON_RUN_AS_NODE: '1',
        TEMP: runDir,
        TMP: runDir,
        XDG_CACHE_HOME: runDir,
      });
      expect(existsSync(runDir ?? '')).toBe(true);
    }
    // Exactly the benchmarked arguments, whatever the environment.
    expect(calls[0]?.args).toEqual(ytDlpArgs(ID, process.execPath));

    children[0]?.stdout.write(WEBM);
    children[0]?.exit(0);
    await first;
    await vi.waitFor(() => expect(existsSync(runDirs[0] ?? '')).toBe(false));
    // The other download keeps its folder, also for its second attempt.
    expect(existsSync(runDirs[1] ?? '')).toBe(true);
    children[1]?.exit(1);
    await untilSpawned(calls, 3);
    expect(calls[2]?.options.env?.TEMP).toBe(runDirs[1]);
    expect(existsSync(runDirs[1] ?? '')).toBe(true);
    children[2]?.exit(1);
    await rejection(second);
    await vi.waitFor(() => expect(readdirSync(root)).toEqual([]));
  });

  it('keeps a killed download’s folder until its processes are gone', async () => {
    const temp = createYtDlpTemp(root);
    const { spawn, children, calls } = fakeSpawn();
    const killTree = vi.fn();
    const controller = new AbortController();
    const download = startJamDownload(EXE, ID, {
      spawn,
      killTree,
      temp,
      signal: controller.signal,
    });
    await untilSpawned(calls);
    const runDir = calls[0]?.options.env?.TEMP ?? '';
    writeFileSync(join(runDir, '_MEI1234'), 'unpacked python');
    controller.abort();
    expect((await rejection(download.finished)).reason).toBe('cancelled');
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(existsSync(runDir)).toBe(true);

    let exited = false;
    void download.exited.then(() => {
      exited = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(exited).toBe(false);
    children[0]?.exit(1);
    await download.exited;
    await vi.waitFor(() => expect(existsSync(runDir)).toBe(false));
  });

  it('cleans up when yt-dlp cannot even start', async () => {
    const temp = createYtDlpTemp(root);
    const throwing: SpawnLike = () => {
      throw new Error('ENOENT');
    };
    expect((await rejection(downloadAll(EXE, ID, { spawn: throwing, temp }))).reason).toBe('spawn');
    await vi.waitFor(() => expect(readdirSync(root)).toEqual([]));
  });

  it('wipes what earlier sessions left, but never a folder in use', async () => {
    mkdirSync(join(root, 'old-run', '_MEI999'), { recursive: true });
    writeFileSync(join(root, 'old-run', '_MEI999', 'python3.dll'), 'x');
    const temp = createYtDlpTemp(root);
    const inUse = await temp.acquire();
    await temp.wipe();
    expect(readdirSync(root)).toEqual([inUse.slice(root.length + 1)]);

    await temp.release(inUse);
    await temp.wipe();
    // Nothing left: not even the empty folders.
    expect(existsSync(join(dir, 'tmp'))).toBe(false);
  });
});

describe('runYtDlpVersion', () => {
  afterEach(() => vi.useRealTimers());

  it('runs --version hidden and resolves with the version', async () => {
    const { spawn, killTree, children, calls } = fakeSpawn();
    const promise = runYtDlpVersion(EXE, { spawn, killTree });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.command).toBe(EXE);
    expect(calls[0]?.args).toEqual(['--ignore-config', '--version']);
    expect(calls[0]?.options.windowsHide).toBe(true);
    children[0]?.stdout.write('2026.10.21\r\n');
    children[0]?.exit(0);
    expect(await promise).toBe('2026.10.21');
    expect(killTree).not.toHaveBeenCalled();
  });

  it('resolves with null when it fails, hangs or is stopped', async () => {
    const failing = fakeSpawn();
    const failed = runYtDlpVersion(EXE, { spawn: failing.spawn, killTree: failing.killTree });
    await vi.waitFor(() => expect(failing.calls).toHaveLength(1));
    failing.children[0]?.exit(1);
    expect(await failed).toBeNull();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hanging = fakeSpawn();
    const hung = runYtDlpVersion(EXE, { spawn: hanging.spawn, killTree: hanging.killTree });
    await vi.waitFor(() => expect(hanging.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(YTDLP_VERSION_TIMEOUT_MS);
    expect(await hung).toBeNull();
    expect(hanging.killTree).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    const stopping = fakeSpawn();
    const controller = new AbortController();
    const stopped = runYtDlpVersion(EXE, {
      spawn: stopping.spawn,
      killTree: stopping.killTree,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(stopping.calls).toHaveLength(1));
    stopping.children[0]?.stdout.write('2026.10.21\n');
    controller.abort();
    expect(await stopped).toBeNull();
    expect(stopping.killTree).toHaveBeenCalledTimes(1);

    const throwing: SpawnLike = () => {
      throw new Error('ENOENT');
    };
    expect(await runYtDlpVersion(EXE, { spawn: throwing })).toBeNull();
  });

  it('runs in a temp folder of its own, removed afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-ytdlp-version-'));
    try {
      const root = join(dir, 'tmp', 'yt-dlp');
      const temp = createYtDlpTemp(root);
      const { spawn, killTree, children, calls } = fakeSpawn();
      const promise = runYtDlpVersion(EXE, { spawn, killTree, temp });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const runDir = calls[0]?.options.env?.TEMP ?? '';
      expect(runDir.startsWith(root)).toBe(true);
      children[0]?.stdout.write('2026.10.21\n');
      children[0]?.exit(0);
      expect(await promise).toBe('2026.10.21');
      await vi.waitFor(() => expect(readdirSync(root)).toEqual([]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
