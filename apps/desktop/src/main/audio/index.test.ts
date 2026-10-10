import { describe, expect, it, vi } from 'vitest';
import type {
  NativeCapture,
  NativeCaptureOptions,
  ProcessAudioNative,
} from '@concord/process-audio';
import {
  MESSAGES,
  ProcessAudioError,
  createProcessAudioEngine,
  describeNativeFailure,
  type ProcessAudioEngineDeps,
} from './index';

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

function createEngine(
  fake: ReturnType<typeof createFakeNative> | null,
  overrides: Partial<ProcessAudioEngineDeps> = {},
) {
  const windowOwnerPid = vi.fn(async (hwnd: number) => (hwnd === 1324 ? 4242 : 0));
  const discordRootPid = vi.fn(async () => 777 as number | null);
  const engine = createProcessAudioEngine({
    platform: 'win32',
    arch: 'x64',
    loadNative: () => fake?.native ?? null,
    windowOwnerPid,
    discordRootPid,
    ...overrides,
  });
  return { engine, windowOwnerPid, discordRootPid };
}

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
  it('captures the owning process tree of a window', async () => {
    const fake = createFakeNative();
    const { engine, windowOwnerPid } = createEngine(fake);
    const chunks: Float32Array[] = [];
    const format = await engine.start('window:1324:0', (chunk) => chunks.push(chunk));
    expect(format).toEqual({ sampleRate: 48000, channels: 2 });
    expect(windowOwnerPid).toHaveBeenCalledWith(1324);
    expect(fake.captures[0]?.options).toEqual({ pid: 4242, mode: 'include' });
    expect(engine.running).toBe(true);
    fake.captures[0]?.emit(new Float32Array([0.5, -0.5]));
    expect(chunks).toHaveLength(1);
  });

  it("excludes Discord's process tree for a screen", async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await engine.start('screen:0:0', () => undefined);
    expect(fake.captures[0]?.options).toEqual({ pid: 777, mode: 'exclude' });
  });

  it('fails with discord_not_running when there is nothing to exclude', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake, { discordRootPid: async () => null });
    await expectProcessAudioError(
      engine.start('screen:0:0', () => undefined),
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
      engine.start('window:99:0', () => undefined),
      'window_process_unknown',
      MESSAGES.windowProcessUnknown,
    );
  });

  it('rejects malformed source ids and unsupported setups', async () => {
    const { engine } = createEngine(createFakeNative());
    await expectProcessAudioError(
      engine.start('nope', () => undefined),
      'invalid_source',
    );
    const unsupported = createEngine(null).engine;
    await expectProcessAudioError(
      unsupported.start('window:1324:0', () => undefined),
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
      engine.start('window:1324:0', () => undefined),
      'native_failure',
      'O Windows rejeitou o processo escolhido para a captura de áudio.',
    );
    expect(engine.running).toBe(false);
  });

  it('replaces a running capture', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await engine.start('window:1324:0', () => undefined);
    await engine.start('screen:0:0', () => undefined);
    expect(fake.captures).toHaveLength(2);
    expect(fake.captures[0]?.stopped).toBe(true);
    expect(fake.captures[1]?.options?.mode).toBe('exclude');
    expect(engine.running).toBe(true);
  });

  it('serialises overlapping start calls', async () => {
    const fake = createFakeNative();
    let release!: () => void;
    const { engine } = createEngine(fake, {
      windowOwnerPid: () =>
        new Promise<number>((resolve) => {
          release = () => resolve(4242);
        }),
    });
    const first = engine.start('window:1324:0', () => undefined);
    const second = engine.start('screen:0:0', () => undefined);
    await Promise.resolve();
    expect(fake.captures).toHaveLength(0);
    release();
    await first;
    await second;
    expect(fake.captures).toHaveLength(2);
    expect(fake.captures[0]?.stopped).toBe(true);
  });
});

describe('stop', () => {
  it('stops the capture, is idempotent and swallows native stop errors', async () => {
    const fake = createFakeNative();
    const { engine } = createEngine(fake);
    await engine.stop();
    await engine.start('window:1324:0', () => undefined);
    const capture = fake.captures[0];
    if (!capture) throw new Error('expected a capture');
    capture.stop = async () => {
      capture.stopped = true;
      throw new Error('boom');
    };
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(capture.stopped).toBe(true);
    expect(engine.running).toBe(false);
    await expect(engine.stop()).resolves.toBeUndefined();
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
