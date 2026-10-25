/**
 * Downloads one song's audio with yt-dlp into memory (never to disk: the user's system drive is
 * often full). The invocation is the one validated on 2026-10-24 from a home connection:
 * anonymous (never cookies, never an account), no cache, Opus in WebM (YouTube itag 251) to
 * stdout, and Electron's own Node (`ELECTRON_RUN_AS_NODE=1`) as yt-dlp's JavaScript runtime.
 * Measured on 2026-10-24 (51 runs): asked as the `visionos` client, YouTube serves that itag
 * without the 5 s preroll-ad wait the default clients get, so the first bytes come after ~1.4 s
 * instead of ~8 s; when that fails before any byte (format missing, unplayable, age gate, no
 * output…), the same song is tried once more with yt-dlp's default clients. Each download gets a
 * TEMP folder of its own, deleted afterwards.
 *
 * The bytes are usable as they arrive (`JamDownload.stream()`): the upload starts as soon as the
 * output looks like WebM, before yt-dlp is done, and every byte stays in memory so a failed upload
 * can start over from the first one.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JAM_UPLOAD_MAX_BYTES, YOUTUBE_VIDEO_ID_PATTERN } from '@concord/shared';
import { emptyDir } from '../housekeeping';
import { log } from '../log';
import { UserFacingError } from '../validation';
import { deferred } from './async';

const logger = log('jam-download');

/** One download (both attempts: ~1.5 s, or ~8 s with the default clients) gives up after this. */
export const JAM_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
/** `yt-dlp --version` (the warm-up) gives up after this long. */
export const YTDLP_VERSION_TIMEOUT_MS = 30_000;
/** Only the end of stderr matters (the ERROR lines). */
const STDERR_MAX_CHARS = 64 * 1024;
const VERSION_MAX_CHARS = 256;
const LOGGED_ERROR_MAX_CHARS = 300;

export const YTDLP_FORMAT = 'bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]';

/**
 * Which YouTube clients yt-dlp asks as: `visionos` first (itag 251 with no ad wait and no JS
 * player to solve), then yt-dlp's defaults. Never `player_skip=webpage,configs`: without cookies
 * it trips YouTube's bot check at once.
 */
export type YtDlpClients = 'visionos' | 'default';
export const YTDLP_CLIENT_ATTEMPTS: readonly YtDlpClients[] = ['visionos', 'default'];
export const YTDLP_VISIONOS_EXTRACTOR_ARGS = 'youtube:player_client=visionos;skip=hls';

/**
 * Failures of the `visionos` attempt, before any byte came, worth one more attempt with the
 * default clients: what that client may lack (a format, playability, the age gate…) or an
 * output that never came.
 */
const CLIENT_FALLBACK_REASONS: ReadonlySet<JamDownloadFailure> = new Set<JamDownloadFailure>([
  'format',
  'unavailable',
  'age_restricted',
  'outdated',
  'failed',
]);

/** yt-dlp's arguments for `videoId`, with `jsRuntimePath` (Electron's executable) as its Node. */
export function ytDlpArgs(
  videoId: string,
  jsRuntimePath: string,
  clients: YtDlpClients = 'visionos',
): string[] {
  return [
    '--ignore-config',
    '--no-cookies',
    '--no-cookies-from-browser',
    '--no-playlist',
    '--no-progress',
    '--quiet',
    '--no-cache-dir',
    '-f',
    YTDLP_FORMAT,
    '--no-js-runtimes',
    '--js-runtimes',
    `node:${jsRuntimePath}`,
    ...(clients === 'visionos' ? ['--extractor-args', YTDLP_VISIONOS_EXTRACTOR_ARGS] : []),
    '-o',
    '-',
    `https://music.youtube.com/watch?v=${videoId}`,
  ];
}

export type JamDownloadFailure =
  | 'blocked'
  | 'rate_limited'
  | 'age_restricted'
  | 'private'
  | 'region'
  | 'members_only'
  | 'live'
  | 'format'
  | 'unavailable'
  | 'no_space'
  | 'outdated'
  | 'network'
  | 'timeout'
  | 'too_large'
  | 'not_audio'
  | 'spawn'
  | 'cancelled'
  | 'failed';

export const JAM_DOWNLOAD_MESSAGES: Readonly<Record<JamDownloadFailure, string>> = {
  blocked: 'O YouTube bloqueou o download nesta conexão. Tente de novo mais tarde.',
  rate_limited: 'O YouTube limitou os downloads desta conexão. Tente de novo mais tarde.',
  age_restricted: 'Essa música tem restrição de idade no YouTube e não pode ser baixada sem conta.',
  private: 'Esse vídeo é privado no YouTube.',
  region: 'Essa música não está disponível no seu país.',
  members_only: 'Essa música é exclusiva para membros do canal no YouTube.',
  live: 'Transmissões ao vivo e estreias não podem entrar na Jam.',
  format: 'O YouTube não ofereceu o áudio dessa música.',
  unavailable: 'Essa música não está disponível no YouTube.',
  no_space: 'Sem espaço em disco para o yt-dlp funcionar. Libere espaço e tente de novo.',
  outdated: 'O YouTube mudou algo e o yt-dlp ainda não acompanhou. Tente de novo mais tarde.',
  network: 'Não foi possível baixar do YouTube. Verifique sua conexão.',
  timeout: 'O download do YouTube demorou demais.',
  too_large: 'O áudio dessa música é grande demais para a Jam.',
  not_audio: 'O YouTube devolveu algo diferente do áudio esperado.',
  spawn: 'Não foi possível executar o yt-dlp. Veja se o antivírus não o bloqueou.',
  cancelled: 'Download cancelado.',
  failed: 'Não foi possível baixar a música do YouTube.',
};

/** A failed download; `message` is pt-BR and safe to show. */
export class JamDownloadError extends UserFacingError {
  override readonly name = 'JamDownloadError';
  constructor(readonly reason: JamDownloadFailure) {
    super(JAM_DOWNLOAD_MESSAGES[reason]);
  }

  /** A newer yt-dlp may fix it: worth one forced update and a retry. */
  get maybeOutdated(): boolean {
    return this.reason === 'outdated' || this.reason === 'format';
  }
}

/**
 * yt-dlp's stderr → reason, first match wins (the order matters: "Requested format is not
 * available" is not an unavailable video, a 403 is usually an outdated extractor). YouTube's own
 * texts use typographic apostrophes, which arrive mangled through the console code page.
 */
const STDERR_RULES: readonly [JamDownloadFailure, RegExp][] = [
  ['age_restricted', /confirm your age|age[- ]restricted|inappropriate for some users/i],
  ['blocked', /not a bot|confirm you.{0,3}re not/i],
  ['rate_limited', /HTTP Error 429|Too Many Requests/i],
  ['private', /private video/i],
  ['region', /available in your country|blocked it in your country|geo[- ]?restrict/i],
  ['members_only', /members[- ]only|join this channel/i],
  ['live', /live event will begin|premieres? in|this live event|is a live stream/i],
  ['format', /requested format is not available/i],
  [
    'unavailable',
    /video unavailable|video is unavailable|no longer available|has been removed|has been terminated|copyright claim|not available|does not exist/i,
  ],
  [
    'no_space',
    /no space left|ENOSPC|errno 28|\[PYI-\d+:ERROR\]|could not create temporary directory/i,
  ],
  [
    'outdated',
    /unable to extract|nsig|signature (?:extraction|solving|function)|challenge solving failed|failed to extract any player response|precondition check failed|HTTP Error 403|latest version|yt-dlp -U|please report this issue/i,
  ],
  [
    'network',
    /unable to download|urlopen error|getaddrinfo|failed to resolve|name or service not known|timed out|connection (?:reset|refused|aborted)|temporary failure in name resolution|network is unreachable|SSL/i,
  ],
];

function matchRules(text: string): JamDownloadFailure | null {
  if (text === '') return null;
  for (const [reason, pattern] of STDERR_RULES) if (pattern.test(text)) return reason;
  return null;
}

/** Why yt-dlp failed, from its stderr: its ERROR lines first, then any line. */
export function classifyYtDlpError(stderr: string): JamDownloadFailure {
  const errors = stderr
    .split(/\r?\n/)
    .filter((line) => /\bERROR\b/.test(line))
    .join('\n');
  return matchRules(errors) ?? matchRules(stderr) ?? 'failed';
}

function lastErrorLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  const line = lines.filter((l) => /\bERROR\b/.test(l)).at(-1) ?? lines.at(-1) ?? '(no output)';
  return line.length > LOGGED_ERROR_MAX_CHARS
    ? `${line.slice(0, LOGGED_ERROR_MAX_CHARS - 1)}…`
    : line;
}

/** WebM starts with the EBML magic number. */
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// --- The download, as its bytes arrive ---------------------------------------------------

export type JamDownloadState = 'running' | 'complete' | 'failed';

/** One song's audio coming from yt-dlp, kept in memory. */
export interface JamDownload {
  readonly videoId: string;
  /** `running` while yt-dlp may still send bytes; then `complete` or `failed` for good. */
  readonly state: JamDownloadState;
  /** Bytes received so far. */
  readonly size: number;
  /** Why it failed, once `failed`. */
  readonly error: JamDownloadError | null;
  /**
   * Resolves once the output is known to be WebM (its first bytes), i.e. it is worth uploading;
   * rejects with the `JamDownloadError` when it fails before that.
   */
  readonly started: Promise<void>;
  /** Resolves once complete; rejects with the `JamDownloadError`. */
  readonly finished: Promise<void>;
  /** Resolves once yt-dlp is gone (exited, or never started): its process slot is free again. */
  readonly exited: Promise<void>;
  /**
   * Every byte from the first: the ones already received, then the others as they arrive; it
   * ends with the download, or errors with its `JamDownloadError`. Each call starts over from the
   * first byte; cancelling a stream leaves the download alone.
   */
  stream(): ReadableStream<Uint8Array>;
  /** The bytes received so far (all of them once `complete`). */
  bytes(): Buffer;
  /** Fails it with `reason` (default `cancelled`) and stops yt-dlp if it still runs. */
  cancel(reason?: JamDownloadFailure): void;
}

/** The producing side of a `JamDownload`: yt-dlp's process (or a test). */
export interface JamDownloadFeed {
  readonly download: JamDownload;
  /** More output (ignored once the download is over). */
  push(chunk: Uint8Array): void;
  /**
   * The producer ended well: `complete` (true) if the output looked like WebM, `failed`
   * otherwise (false, as when the download was already over).
   */
  complete(): boolean;
  fail(reason: JamDownloadFailure): void;
  /** The producer is gone (resolves `exited`). */
  gone(): void;
  /** Called once, with the reason, if the download fails while the producer still runs. */
  onStop(stop: ((reason: JamDownloadFailure) => void) | null): void;
}

const ignore = (): void => undefined;

/** A download fed by hand; `maxBytes` caps its size (`too_large` beyond). */
export function createJamDownload(
  videoId: string,
  maxBytes: number = JAM_UPLOAD_MAX_BYTES,
): JamDownloadFeed {
  const chunks: Buffer[] = [];
  let size = 0;
  /** Bytes in `chunks` (all of `size` until a failure drops them). */
  let kept = 0;
  let state: JamDownloadState = 'running';
  let error: JamDownloadError | null = null;
  let looksLikeWebm = false;
  let stop: ((reason: JamDownloadFailure) => void) | null = null;
  /** Streams waiting for more bytes or the end. */
  let waiters: (() => void)[] = [];
  const started = deferred<void>();
  const finished = deferred<void>();
  const exited = deferred<void>();
  // Nobody may be waiting on them: a failure must never be an unhandled rejection.
  started.promise.catch(ignore);
  finished.promise.catch(ignore);

  function wake(): void {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  }

  function fail(reason: JamDownloadFailure): void {
    if (state !== 'running') return;
    state = 'failed';
    error = new JamDownloadError(reason);
    chunks.length = 0;
    kept = 0;
    started.reject(error);
    finished.reject(error);
    wake();
    const current = stop;
    stop = null;
    current?.(reason);
  }

  const download: JamDownload = {
    videoId,
    get state() {
      return state;
    },
    get size() {
      return size;
    },
    get error() {
      return error;
    },
    started: started.promise,
    finished: finished.promise,
    exited: exited.promise,
    stream() {
      let index = 0;
      let cancelled = false;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            for (;;) {
              if (cancelled) return;
              if (state === 'failed') {
                controller.error(error);
                return;
              }
              const chunk = chunks[index];
              if (chunk) {
                index += 1;
                controller.enqueue(chunk);
                return;
              }
              if (state === 'complete') {
                controller.close();
                return;
              }
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
          },
          cancel() {
            cancelled = true;
          },
        },
        // Pulled only when the consumer reads: nothing is queued twice.
        { highWaterMark: 0 },
      );
    },
    bytes: () => Buffer.concat(chunks, kept),
    cancel(reason = 'cancelled') {
      fail(reason);
    },
  };

  return {
    download,
    push(chunk) {
      if (state !== 'running' || chunk.byteLength === 0) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        fail('too_large');
        return;
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      kept += chunk.byteLength;
      if (!looksLikeWebm && kept >= WEBM_MAGIC.length) {
        if (!Buffer.concat(chunks, WEBM_MAGIC.length).equals(WEBM_MAGIC)) {
          fail('not_audio');
          return;
        }
        looksLikeWebm = true;
        started.resolve();
      }
      wake();
    },
    complete() {
      if (state !== 'running') return false;
      if (!looksLikeWebm) {
        fail(size === 0 ? 'failed' : 'not_audio');
        return false;
      }
      state = 'complete';
      stop = null;
      finished.resolve();
      wake();
      return true;
    },
    fail,
    gone: () => exited.resolve(),
    onStop(next) {
      stop = next;
    },
  };
}

// --- yt-dlp's process ----------------------------------------------------------------------

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Kills yt-dlp with everything under it: the single-file yt-dlp.exe is a PyInstaller bootloader
 * whose Python child would survive a plain `kill()` on Windows, and any build may be running the
 * Node it solves YouTube's challenges with.
 */
export function killProcessTree(child: ChildProcess): void {
  const killSelf = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  if (process.platform === 'win32' && child.pid !== undefined) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, killSelf);
    return;
  }
  killSelf();
}

/**
 * The single-file yt-dlp.exe unpacks ~30 MB into %TEMP%\_MEI* on every run, left behind when the
 * run is killed. Each run gets its own TEMP folder under `root`, removed once its process tree
 * is gone; `wipe()` clears whatever an earlier session left.
 */
export interface YtDlpTemp {
  /** A fresh folder for one run. */
  acquire(): Promise<string>;
  /** Removes a run's folder (after its processes exited). */
  release(dir: string): Promise<void>;
  /** Removes every folder not in use, then `root` and its parent when empty (start-up). */
  wipe(): Promise<void>;
}

export function createYtDlpTemp(root: string): YtDlpTemp {
  const active = new Set<string>();
  return {
    async acquire() {
      const dir = join(root, randomUUID());
      await mkdir(dir, { recursive: true });
      active.add(dir);
      return dir;
    },
    async release(dir) {
      active.delete(dir);
      // Killed processes may hold their files for a moment.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
    async wipe() {
      await emptyDir(root, active);
      await rmdir(dirname(root)).catch(() => undefined);
    },
  };
}

/** `base` without any spelling of the overridden names (Windows ignores their case), plus them. */
function childEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const replaced = new Set(Object.keys(overrides).map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!replaced.has(name.toUpperCase())) env[name] = value;
  }
  return { ...env, ...overrides };
}

/** yt-dlp's environment: Electron runs as Node for it, and the run's folder is its TEMP. */
function runEnv(base: NodeJS.ProcessEnv, runDir: string | null): NodeJS.ProcessEnv {
  const overrides: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  if (runDir !== null) {
    overrides.TEMP = runDir;
    overrides.TMP = runDir;
    overrides.XDG_CACHE_HOME = runDir;
  }
  return childEnv(base, overrides);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** A run's own TEMP folder (null without `temp`), released once with `release`. */
interface RunFolder {
  dir: string | null;
  release(): void;
}

async function acquireRunFolder(temp: YtDlpTemp | undefined): Promise<RunFolder> {
  if (!temp) return { dir: null, release: ignore };
  const dir = await temp.acquire();
  let released = false;
  return {
    dir,
    release() {
      if (released) return;
      released = true;
      temp.release(dir).catch((err: unknown) => {
        logger.warn('could not remove the yt-dlp temp folder', err);
      });
    },
  };
}

export interface JamDownloadOptions {
  /** Cancels the download (as `cancel()` does). */
  signal?: AbortSignal;
  spawn?: SpawnLike;
  killTree?: (child: ChildProcess) => void;
  /** yt-dlp's JavaScript runtime: Electron's own executable, run as Node. */
  jsRuntimePath?: string;
  /** Base environment (default `process.env`); `ELECTRON_RUN_AS_NODE=1` is always added. */
  env?: NodeJS.ProcessEnv;
  /** The download's own folder: TEMP, TMP and XDG_CACHE_HOME point there. Default: untouched. */
  temp?: YtDlpTemp;
  /** For both attempts together. */
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Starts downloading the WebM/Opus audio of `videoId`; its bytes are available as they arrive.
 * Never throws: every failure (a `JamDownloadError`) shows on the returned download.
 */
export function startJamDownload(
  exePath: string,
  videoId: string,
  options: JamDownloadOptions = {},
): JamDownload {
  const feed = createJamDownload(videoId, options.maxBytes);
  const { download } = feed;
  // The id ends up in a URL, never as an option, but only real ids get that far.
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    feed.fail('failed');
    feed.gone();
    return download;
  }
  const { signal } = options;
  if (signal) {
    const onAbort = (): void => download.cancel();
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      const detach = (): void => signal.removeEventListener('abort', onAbort);
      download.finished.then(detach, detach);
    }
  }
  void runYtDlp(feed, exePath, videoId, options);
  return download;
}

interface AttemptContext {
  feed: JamDownloadFeed;
  exePath: string;
  videoId: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  spawn: SpawnLike;
  killTree: (child: ChildProcess) => void;
  /** When the download (not this attempt) started. */
  startedAt: number;
  label: YtDlpClients;
}

interface Attempt {
  /**
   * Why this process failed without the download being over (the caller decides: another
   * attempt, or the failure); null when the download is over (complete, cancelled, too large…).
   */
  outcome: Promise<JamDownloadFailure | null>;
  /** The process is gone (exited, or never started). */
  gone: Promise<void>;
}

/** One yt-dlp process feeding `ctx.feed`. */
function startAttempt(ctx: AttemptContext): Attempt {
  const { feed, videoId } = ctx;
  const { download } = feed;
  const outcome = deferred<JamDownloadFailure | null>();
  const gone = deferred<void>();
  let child: ChildProcess;
  try {
    child = ctx.spawn(ctx.exePath, ctx.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ctx.env,
    });
  } catch (err) {
    logger.warn('could not start yt-dlp', err);
    outcome.resolve('spawn');
    gone.resolve();
    return { outcome: outcome.promise, gone: gone.promise };
  }

  const spawnedAt = Date.now();
  let firstBytesAt: number | null = null;
  let stderr = '';
  feed.onStop((reason) => {
    logger.warn(`stopping yt-dlp for ${videoId}: ${reason}`);
    ctx.killTree(child);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    firstBytesAt ??= Date.now();
    feed.push(chunk);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    stderr = (stderr + text).slice(-STDERR_MAX_CHARS);
  });
  child.on('error', (err) => {
    logger.warn('could not run yt-dlp', err);
    // Nothing to kill: it never ran, or is gone already.
    feed.onStop(null);
    outcome.resolve('spawn');
    // A process that failed to start never emits `close`.
    if (child.pid === undefined) gone.resolve();
  });
  // `close` comes after the process exited and stdout ended: every byte has been seen.
  child.on('close', (code, exitSignal) => {
    feed.onStop(null);
    gone.resolve();
    if (download.state !== 'running') {
      outcome.resolve(null);
      return;
    }
    if (code === 0 && download.size > 0) {
      if (feed.complete()) {
        const now = Date.now();
        logger.info(
          `downloaded ${videoId} (${ctx.label}): ${download.size} bytes in ${now - ctx.startedAt} ms, first bytes ${(firstBytesAt ?? now) - spawnedAt} ms after yt-dlp started`,
        );
      } else {
        logger.warn(`yt-dlp output for ${videoId} is not WebM`);
      }
      outcome.resolve(null);
      return;
    }
    const reason = classifyYtDlpError(stderr);
    logger.warn(
      `yt-dlp (${ctx.label}) failed for ${videoId} (${code ?? exitSignal}, ${reason}): ${lastErrorLine(stderr)}`,
    );
    outcome.resolve(reason);
  });
  return { outcome: outcome.promise, gone: gone.promise };
}

/**
 * yt-dlp feeding `feed`: as `visionos`, then once more with the default clients if that failed
 * before any byte for a reason they may not share. One process at a time; `feed.gone()` once the
 * last one is gone.
 */
async function runYtDlp(
  feed: JamDownloadFeed,
  exePath: string,
  videoId: string,
  options: JamDownloadOptions,
): Promise<void> {
  const { download } = feed;
  const {
    spawn: spawnImpl = spawn,
    killTree = killProcessTree,
    jsRuntimePath = process.execPath,
    timeoutMs = JAM_DOWNLOAD_TIMEOUT_MS,
  } = options;
  if (download.state !== 'running') {
    feed.gone();
    return;
  }

  let folder: RunFolder;
  try {
    folder = await acquireRunFolder(options.temp);
  } catch (err) {
    logger.warn('could not create the yt-dlp temp folder', err);
    feed.fail(errorCode(err) === 'ENOSPC' ? 'no_space' : 'failed');
    feed.gone();
    return;
  }
  const onGone = (): void => {
    folder.release();
    feed.gone();
  };
  // Cancelled while the folder was being created.
  if (download.state !== 'running') {
    onGone();
    return;
  }

  const env = runEnv(options.env ?? process.env, folder.dir);
  const startedAt = Date.now();
  const timer = setTimeout(() => download.cancel('timeout'), timeoutMs);
  const clearTimer = (): void => clearTimeout(timer);
  download.finished.then(clearTimer, clearTimer);
  let gone: Promise<void> = Promise.resolve();
  try {
    for (const clients of YTDLP_CLIENT_ATTEMPTS) {
      if (download.state !== 'running') return;
      const attempt = startAttempt({
        feed,
        exePath,
        videoId,
        args: ytDlpArgs(videoId, jsRuntimePath, clients),
        env,
        spawn: spawnImpl,
        killTree,
        startedAt,
        label: clients,
      });
      gone = attempt.gone;
      const reason = await attempt.outcome;
      if (reason === null) return;
      const last = clients === YTDLP_CLIENT_ATTEMPTS.at(-1);
      if (!last && download.size === 0 && CLIENT_FALLBACK_REASONS.has(reason)) {
        await gone;
        logger.info(`trying ${videoId} again with yt-dlp's default clients`);
        continue;
      }
      feed.fail(reason);
      return;
    }
  } finally {
    clearTimer();
    void gone.then(onGone);
  }
}

// --- Warm-up -------------------------------------------------------------------------------

export interface YtDlpVersionOptions {
  signal?: AbortSignal;
  spawn?: SpawnLike;
  killTree?: (child: ChildProcess) => void;
  env?: NodeJS.ProcessEnv;
  temp?: YtDlpTemp;
  timeoutMs?: number;
}

/**
 * Runs `yt-dlp --version` once: the binary and its libraries get read from disk (and past the
 * antivirus) so the first real download starts warm. Resolves with the version, or null when it
 * did not work (only logged); never rejects.
 */
export async function runYtDlpVersion(
  exePath: string,
  options: YtDlpVersionOptions = {},
): Promise<string | null> {
  const {
    signal,
    spawn: spawnImpl = spawn,
    killTree = killProcessTree,
    timeoutMs = YTDLP_VERSION_TIMEOUT_MS,
  } = options;
  if (signal?.aborted) return null;
  let folder: RunFolder;
  try {
    folder = await acquireRunFolder(options.temp);
  } catch (err) {
    logger.warn('could not create the yt-dlp temp folder', err);
    return null;
  }
  if (signal?.aborted) {
    folder.release();
    return null;
  }
  return new Promise<string | null>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(exePath, ['--ignore-config', '--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runEnv(options.env ?? process.env, folder.dir),
      });
    } catch (err) {
      logger.warn('could not start yt-dlp --version', err);
      folder.release();
      resolve(null);
      return;
    }
    let stdout = '';
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      killTree(child);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const done = (version: string | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      folder.release();
      resolve(version);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      stdout = (stdout + text).slice(0, VERSION_MAX_CHARS);
    });
    child.stderr?.resume();
    child.on('error', (err) => {
      logger.warn('could not run yt-dlp --version', err);
      if (child.pid === undefined) done(null);
    });
    child.on('close', (code) => {
      done(code === 0 && !stopped ? stdout.trim() || null : null);
    });
  });
}
