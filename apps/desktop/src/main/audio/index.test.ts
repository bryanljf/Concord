import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NativeCapture,
  NativeCaptureOptions,
  ProcessAudioNative,
} from '@concord/process-audio';
import type { ProcessAudioTarget } from '../../preload/api';
import {
  MESSAGES,
  ProcessAudioError,
  createProcessAudioEngine,
  describeNativeFailure,
  type ProcessAudioEngineDeps,
} from './index';
import type { ProcessInfo } from './win-process';

interface FakeCapture extends NativeCapture {
  options: NativeCaptureOptions | null;
  emit(chunk: Float32Array): void;
  stopped: boolean;
}

function createFakeNative(
  options: { supported?: boolean; build?: number; startError?: Error } = {},
) {
  const captures: FakeCapture[] = [];
  const native: ProcessAudioNative = {
    isSupported: () => options.supported ?? true,
    windowsBuild: () => options.build ?? 26200,
    createCapture: () => {
      let listener: ((chunk: Float32Array) => void) | null = null;
      const capture: FakeCapture = {
        options: null,
        stopped: false,
        get running() {
          return listener !== null;
        },
        start(opts, onData) {
          if (options.startError) throw options.startError;
          capture.options = opts;
          listener = onData;
          return { sampleRate: 48000, channels: 2 };
        },
        async stop() {
          listener = null;
          capture.stopped = true;
        },
        emit(chunk) {
          listener?.(chunk);
        },
      };
      captures.push(capture);
      return capture;
    },
  };
  return { native, captures };
}

const spotify = (pid: number, ppid: number | null): ProcessInfo => ({
  pid,
  ppid,
  name: 'Spotify.exe',
});

type ListProcesses = (names: readonly string[]) => Promise<ProcessInfo[]>;

/** Spotify's tree: root 900 (parent explorer) with renderer/gpu/utility children. */
const SPOTIFY_TREE = [spotify(910, 900), spotify(900, 4), spotify(920, 900), spotify(930, 910)];

function createEngine(
  fake: ReturnType<typeof createFakeNative> | null,
  overrides: Partial<ProcessAudioEngineDeps> = {},
) {
  let nextId = 0;
  const windowOwnerPid = vi.fn(async (hwnd: number) => (hwnd === 1324 ? 4242 : 0));
  const discordRootPid = vi.fn(async () => 777 as number | null);
  const listProcesses = vi.fn<ListProcesses>(async () => SPOTIFY_TREE);
  const listProcessesQuick = vi.fn<ListProcesses>(async () => SPOTIFY_TREE);
  const engine = createProcessAudioEngine({
    platform: 'win32',
    arch: 'x64',
    loadNative: () => fake?.native ?? null,
    windowOwnerPid,
    discordRootPid,
    listProcesses,
    listProcessesQuick,
    appPollIntervalMs: 5_000,
    createCaptureId: () => `cap-${++nextId}`,
    ...overrides,
  });
  return { engine, windowOwnerPid, discordRootPid, listProcesses, listProcessesQuick };
}

const windowTarget = (hwnd: number): ProcessAudioTarget => ({
  kind: 'source',
  sourceId: `window:${hwnd}:0`,
});
const SCREEN: ProcessAudioTarget = { kind: 'source', sourceId: 'screen:0:0' };
const SPOTIFY: ProcessAudioTarget = { kind: 'app', app: 'spotify' };
const ignore = (): void => undefined;

async function expectProcessAudioError(promise: Promise<unknown>, code: string, message?: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProcessAudioError);
  const error = caught as ProcessAudioError;
  expect(error.code).toBe(code);
  if (message !== undefined) expect(error.message).toBe(message);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('support', () => {
  it('explains each unsupported situation in pt-BR', () => {
    expect(createEngine(createFakeNative(), { platform: 'linux' }).engine.support()).toEqual({
      supported: false,
      reason: MESSAGES.notWindows,
    });
    expect(createEngine(createFakeNative(), { arch: 'arm64' }).engine.support()).toEqual({
      supported: false,
      reason: MESSAGES.notX64,
    });
    expect(createEngine(null).engine.support()).toEqual({
      supported: false,
      reason: MESSAGES.moduleMissing,
    });
    expect(
      createEngine(createFakeNative({ supported: false, build: 18363 })).engine.support(),
    ).toEqual({ supported: false, reason: MESSAGES.oldWindows(18363) });
  });

  it('reports support on Windows x64 with the module present', () => {
    expect(createEngine(createFakeNative()).engine.support()).toEqual({
      supported: true,
      reason: null,
    });
  });

  it('loads the native module only once and never off Windows', () => {
    const loadNative = vi.fn(() => null);
    const linux = createEngine(null, { platform: 'linux', loadNative });
    linux.engine.support();
    expect(loadNative).not.toHaveBeenCalled();
    const windows = createEngine(null, { loadNative });
    windows.engine.support();
    windows.engine.support();
    expect(loadNative).toHaveBeenCalledTimes(1);
  });
});

describe('start', () => {
  it('captures the owning process tree of a window, tagging chunks with the capture id', async () => {
    const fake = createFakeNative();
    const { engine, windowOwnerPid } = createEngine(fake);
    const chunks: [string, Float32Array][] = [];
    const capture = await engine.start(windowTarget(1324), (id, chunk) => chunks.push([id, chunk]));
    expect(capture).toEqual({ captureId: 'cap-1', format: { sampleRate: 48000, channels: 2 } });
    expect(windowOwnerPid).toHaveBeenCalledWith(1324);
    expect(fake.captures[0]?.options).toEqual({ pid: 4242, mode: 'include' });
    expect(engine.running).toBe(true);
    expect(engine.has('cap-1')).toBe(true);
    const chunk = new Float32Array([0.5, -0.5]);
    fake.captures[0]?.emit(chunk);
    expect(chunks).toEqual([['cap-1', chunk]]);
  });

  it("excludes Discord's process tree for a screen", async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await engine.start(SCREEN, ignore);
    expect(fake.captures[0]?.options).toEqual({ pid: 777, mode: 'exclude' });
  });

  it('fails with discord_not_running when there is nothing to exclude', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake, { discordRootPid: async () => null });
    await expectProcessAudioError(
      engine.start(SCREEN, ignore),
      'discord_not_running',
      MESSAGES.discordNotRunning,
    );
    expect(fake.captures).toHaveLength(0);
    expect(engine.running).toBe(false);
  });

  it('fails when the window owner cannot be resolved', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await expectProcessAudioError(
      engine.start(windowTarget(99), ignore),
      'window_process_unknown',
      MESSAGES.windowProcessUnknown,
    );
  });

  it('rejects malformed source ids and unsupported setups', async () => {
    const { engine } = createEngine(createFakeNative());
    await expectProcessAudioError(
      engine.start({ kind: 'source', sourceId: 'nope' }, ignore),
      'invalid_source',
    );
    const unsupported = createEngine(null).engine;
    await expectProcessAudioError(
      unsupported.start(windowTarget(1324), ignore),
      'unsupported',
      MESSAGES.moduleMissing,
    );
  });

  it('translates native failures into pt-BR', async () => {
    const error = Object.assign(
      new Error('Failed to start loopback capture (HRESULT 0x80070057)'),
      {
        hresult: 0x80070057,
      },
    );
    const { engine } = createEngine(createFakeNative({ startError: error }));
    await expectProcessAudioError(
      engine.start(windowTarget(1324), ignore),
      'native_failure',
      'O Windows rejeitou o processo escolhido para a captura de áudio.',
    );
    expect(engine.running).toBe(false);
  });

  it('runs several captures at once, each with its own id', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    const received: string[] = [];
    const first = await engine.start(windowTarget(1324), (id) => received.push(id));
    const second = await engine.start(SPOTIFY, (id) => received.push(id));
    expect(first.captureId).not.toBe(second.captureId);
    expect(fake.captures).toHaveLength(2);
    expect(fake.captures.some((capture) => capture.stopped)).toBe(false);
    expect(engine.size).toBe(2);

    fake.captures[1]?.emit(new Float32Array([0.1]));
    fake.captures[0]?.emit(new Float32Array([0.2]));
    expect(received).toEqual([second.captureId, first.captureId]);
  });

  it('stopping one capture keeps the others', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    const first = await engine.start(SCREEN, ignore);
    const second = await engine.start(SPOTIFY, ignore);
    await engine.stop(first.captureId);
    expect(fake.captures[0]?.stopped).toBe(true);
    expect(fake.captures[1]?.stopped).toBe(false);
    expect(engine.has(first.captureId)).toBe(false);
    expect(engine.has(second.captureId)).toBe(true);
    expect(engine.running).toBe(true);
  });
});

describe('music app captures', () => {
  it("includes the app's root process (the one whose parent is not the app)", async () => {
    const fake = createFakeNative();
    const { engine, listProcesses } = createEngine(fake);
    await engine.start(SPOTIFY, ignore);
    expect(listProcesses).toHaveBeenCalledWith(['Spotify.exe']);
    expect(fake.captures[0]?.options).toEqual({ pid: 900, mode: 'include' });
  });

  it('fails with app_not_running when the app is closed', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake, { listProcesses: async () => [] });
    await expectProcessAudioError(
      engine.start(SPOTIFY, ignore),
      'app_not_running',
      'O Spotify não está aberto.',
    );
    expect(fake.captures).toHaveLength(0);
  });

  it('fails with app_process_unknown when the process list cannot be read', async () => {
    const { engine } = createEngine(createFakeNative(), {
      listProcesses: async () => {
        throw new Error('powershell and tasklist failed');
      },
    });
    await expectProcessAudioError(
      engine.start(SPOTIFY, ignore),
      'app_process_unknown',
      MESSAGES.appProcessUnknown('Spotify'),
    );
  });

  it('ends the capture when the app closes, and only then', async () => {
    vi.useFakeTimers();
    const fake = createFakeNative();
    const listProcessesQuick = vi.fn<ListProcesses>(async () => SPOTIFY_TREE);
    const { engine } = createEngine(fake, { listProcessesQuick });
    const onEnded = vi.fn();
    const screen = await engine.start(SCREEN, ignore);
    const music = await engine.start(SPOTIFY, ignore, onEnded);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listProcessesQuick).toHaveBeenCalledWith(['Spotify.exe']);
    expect(onEnded).not.toHaveBeenCalled();
    expect(engine.has(music.captureId)).toBe(true);

    // Spotify closed: only children of another tree remain (none here).
    listProcessesQuick.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onEnded).toHaveBeenCalledExactlyOnceWith(music.captureId, 'app_closed');
    expect(fake.captures[1]?.stopped).toBe(true);
    expect(engine.has(music.captureId)).toBe(false);
    // The screen's capture is not affected, and the dead capture stops polling.
    expect(engine.has(screen.captureId)).toBe(true);
    const calls = listProcessesQuick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listProcessesQuick.mock.calls.length).toBe(calls);
  });

  it('treats a restarted app (new root pid) as closed', async () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { engine } = createEngine(createFakeNative(), {
      listProcessesQuick: async () => [spotify(1500, 4), spotify(1510, 1500)],
    });
    const music = await engine.start(SPOTIFY, ignore, onEnded);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onEnded).toHaveBeenCalledWith(music.captureId, 'app_closed');
  });

  it('keeps capturing when the check itself fails (fail-open)', async () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { engine } = createEngine(createFakeNative(), {
      listProcessesQuick: async () => {
        throw new Error('tasklist failed');
      },
    });
    const music = await engine.start(SPOTIFY, ignore, onEnded);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onEnded).not.toHaveBeenCalled();
    expect(engine.has(music.captureId)).toBe(true);
  });

  it('stops polling once the capture is stopped on request', async () => {
    vi.useFakeTimers();
    const listProcessesQuick = vi.fn<ListProcesses>(async () => []);
    const onEnded = vi.fn();
    const { engine } = createEngine(createFakeNative(), { listProcessesQuick });
    const music = await engine.start(SPOTIFY, ignore, onEnded);
    await engine.stop(music.captureId);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listProcessesQuick).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe('stop', () => {
  it('stops the capture, is idempotent and swallows native stop errors', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await engine.stop('unknown');
    const { captureId } = await engine.start(windowTarget(1324), ignore);
    const capture = fake.captures[0];
    if (!capture) throw new Error('expected a capture');
    capture.stop = async () => {
      capture.stopped = true;
      throw new Error('boom');
    };
    await expect(engine.stop(captureId)).resolves.toBeUndefined();
    expect(capture.stopped).toBe(true);
    expect(engine.running).toBe(false);
    await expect(engine.stop(captureId)).resolves.toBeUndefined();
  });

  it('stopAll stops every capture', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await engine.start(SCREEN, ignore);
    await engine.start(SPOTIFY, ignore);
    await engine.stopAll();
    expect(fake.captures.every((capture) => capture.stopped)).toBe(true);
    expect(engine.size).toBe(0);
  });
});

describe('describeNativeFailure', () => {
  it('maps known HRESULTs and falls back to the raw code or message', () => {
    expect(describeNativeFailure({ hresult: 0x88890010 })).toBe(
      'O serviço de áudio do Windows não está em execução.',
    );
    expect(describeNativeFailure({ hresult: 0x8889000a })).toBe(
      'Falha ao iniciar a captura de áudio por processo (HRESULT 0x8889000a).',
    );
    expect(describeNativeFailure(new Error('weird'))).toBe(
      'Falha ao iniciar a captura de áudio por processo: weird',
    );
  });
});
