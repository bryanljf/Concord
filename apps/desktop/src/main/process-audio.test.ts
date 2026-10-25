import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
}));

import type { WebContents } from 'electron';
import type { ProcessAudioTarget } from '../preload/api';
import { EVENTS } from '../preload/channels';
import type { ProcessAudioDataListener, ProcessAudioEngine } from './audio';
import {
  createProcessAudioBridge,
  expectCaptureId,
  MAX_CAPTURES_PER_WINDOW,
  parseProcessAudioTarget,
} from './process-audio';
import { IpcValidationError, UserFacingError } from './validation';

interface RunningCapture {
  target: ProcessAudioTarget;
  onData: ProcessAudioDataListener;
}

function makeEngine(supported = true) {
  const running = new Map<string, RunningCapture>();
  let nextId = 0;
  const engine: ProcessAudioEngine = {
    support: () => ({ supported, reason: supported ? null : 'Sem suporte neste Windows.' }),
    start: vi.fn(async (target: ProcessAudioTarget, onData: ProcessAudioDataListener) => {
      const captureId = `cap-${++nextId}`;
      running.set(captureId, { target, onData });
      return { captureId, format: { sampleRate: 48_000, channels: 2 } };
    }),
    stop: vi.fn(async (captureId: string) => {
      running.delete(captureId);
    }),
    stopAll: vi.fn(async () => {
      running.clear();
    }),
    has: (captureId) => running.has(captureId),
    get size() {
      return running.size;
    },
    get running() {
      return running.size > 0;
    },
  };
  return {
    engine,
    running,
    push(captureId: string, chunk: Float32Array) {
      running.get(captureId)?.onData(captureId, chunk);
    },
  };
}

function makeSender() {
  const emitter = new EventEmitter();
  let destroyed = false;
  const send = vi.fn();
  const sender = Object.assign(emitter, {
    isDestroyed: () => destroyed,
    send,
  }) as unknown as WebContents;
  return {
    sender,
    send,
    emitter,
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed');
    },
  };
}

const WINDOW: ProcessAudioTarget = { kind: 'source', sourceId: 'window:42:0' };
const SCREEN: ProcessAudioTarget = { kind: 'source', sourceId: 'screen:0:0' };

describe('parseProcessAudioTarget', () => {
  it('accepts window and screen sources', () => {
    expect(parseProcessAudioTarget({ kind: 'source', sourceId: 'screen:0:0', extra: 1 })).toEqual(
      SCREEN,
    );
    expect(parseProcessAudioTarget(WINDOW)).toEqual(WINDOW);
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [
      'window:42:0',
      null,
      { kind: 'source', sourceId: 'nope' },
      { kind: 'source' },
      { kind: 'app', app: 'player' },
      { kind: 'app', sourceId: 'window:42:0' },
      { kind: 'process', pid: 4 },
    ];
    for (const raw of bad) expect(() => parseProcessAudioTarget(raw)).toThrow(IpcValidationError);
  });
});

describe('expectCaptureId', () => {
  it('accepts opaque ids and rejects the rest', () => {
    expect(expectCaptureId('0b6a1c58-3f0e-4c1e-9d7a-6c0f3f1d2e4b')).toBe(
      '0b6a1c58-3f0e-4c1e-9d7a-6c0f3f1d2e4b',
    );
    for (const raw of ['', 'a b', 'x'.repeat(65), 7, null]) {
      expect(() => expectCaptureId(raw)).toThrow(IpcValidationError);
    }
  });
});

describe('createProcessAudioBridge', () => {
  it('reports the engine support', () => {
    const { engine } = makeEngine(false);
    expect(createProcessAudioBridge(engine).support()).toEqual({
      supported: false,
      reason: 'Sem suporte neste Windows.',
    });
  });

  it('refuses to start when unsupported, with the engine reason', async () => {
    const { engine } = makeEngine(false);
    const bridge = createProcessAudioBridge(engine);
    await expect(bridge.start(makeSender().sender, WINDOW)).rejects.toThrow(UserFacingError);
    await expect(bridge.start(makeSender().sender, WINDOW)).rejects.toThrow(
      'Sem suporte neste Windows.',
    );
    expect(engine.start).not.toHaveBeenCalled();
  });

  it('validates the target', async () => {
    const bridge = createProcessAudioBridge(makeEngine().engine);
    await expect(bridge.start(makeSender().sender, 'window:42:0')).rejects.toThrow(
      IpcValidationError,
    );
    await expect(bridge.start(makeSender().sender, { kind: 'app', app: 'player' })).rejects.toThrow(
      IpcValidationError,
    );
  });

  it('forwards tagged PCM chunks to the requesting window until stopped', async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);
    const { sender, send } = makeSender();

    await expect(bridge.start(sender, WINDOW)).resolves.toEqual({
      captureId: 'cap-1',
      format: { sampleRate: 48_000, channels: 2 },
    });
    expect(fake.engine.start).toHaveBeenCalledWith(WINDOW, expect.any(Function));

    const chunk = new Float32Array([0.1, -0.1]);
    fake.push('cap-1', chunk);
    expect(send).toHaveBeenCalledWith(EVENTS.PROCESS_AUDIO_DATA, 'cap-1', chunk);

    await bridge.stop(sender, 'cap-1');
    expect(fake.engine.stop).toHaveBeenCalledWith('cap-1');
    fake.push('cap-1', chunk);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('runs several captures at once; stopping one keeps the other', async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);
    const { sender, send } = makeSender();
    const first = await bridge.start(sender, WINDOW);
    const second = await bridge.start(sender, SCREEN);
    expect(fake.engine.stop).not.toHaveBeenCalled();

    await bridge.stop(sender, first.captureId);
    expect(fake.engine.stop).toHaveBeenCalledExactlyOnceWith(first.captureId);
    const chunk = new Float32Array([0.3]);
    fake.push(second.captureId, chunk);
    expect(send).toHaveBeenLastCalledWith(EVENTS.PROCESS_AUDIO_DATA, second.captureId, chunk);
  });

  it('only lets the owning window stop a capture; unknown ids are a no-op', async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);
    const owner = makeSender();
    const other = makeSender();
    const { captureId } = await bridge.start(owner.sender, SCREEN);
    await bridge.stop(other.sender, captureId);
    await bridge.stop(owner.sender, 'cap-404');
    expect(fake.engine.stop).not.toHaveBeenCalled();
    await expect(bridge.stop(owner.sender, 42)).rejects.toThrow(IpcValidationError);
  });

  it("stops a window's captures when it is destroyed, reloaded or crashes", async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);

    const closed = makeSender();
    await bridge.start(closed.sender, WINDOW);
    await bridge.start(closed.sender, SCREEN);
    closed.destroy();
    await vi.waitFor(() => expect(fake.engine.stop).toHaveBeenCalledTimes(2));

    const reloaded = makeSender();
    const kept = makeSender();
    await bridge.start(reloaded.sender, SCREEN);
    const other = await bridge.start(kept.sender, WINDOW);
    reloaded.emitter.emit('did-navigate');
    await vi.waitFor(() => expect(fake.engine.stop).toHaveBeenCalledTimes(3));
    expect(fake.running.has(other.captureId)).toBe(true);

    kept.emitter.emit('render-process-gone');
    await vi.waitFor(() => expect(fake.engine.stop).toHaveBeenCalledTimes(4));
  });

  it('detaches its window listeners once the last capture stops', async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);
    const { sender, emitter } = makeSender();
    const first = await bridge.start(sender, WINDOW);
    const second = await bridge.start(sender, SCREEN);
    expect(emitter.listenerCount('destroyed')).toBe(1);
    await bridge.stop(sender, first.captureId);
    expect(emitter.listenerCount('destroyed')).toBe(1);
    await bridge.stop(sender, second.captureId);
    expect(emitter.listenerCount('destroyed')).toBe(0);
    expect(emitter.listenerCount('did-navigate')).toBe(0);
    expect(emitter.listenerCount('render-process-gone')).toBe(0);
  });

  it('stops a capture whose window closed while it was starting', async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);
    const owner = makeSender();
    vi.mocked(fake.engine.start).mockImplementationOnce(async (target, onData) => {
      owner.destroy();
      fake.running.set('cap-late', { target, onData });
      return { captureId: 'cap-late', format: { sampleRate: 48_000, channels: 2 } };
    });
    await expect(bridge.start(owner.sender, WINDOW)).rejects.toThrow(UserFacingError);
    expect(fake.engine.stop).toHaveBeenCalledWith('cap-late');
  });

  it('caps the captures per window', async () => {
    const bridge = createProcessAudioBridge(makeEngine().engine);
    const { sender } = makeSender();
    for (let i = 0; i < MAX_CAPTURES_PER_WINDOW; i += 1) await bridge.start(sender, WINDOW);
    await expect(bridge.start(sender, WINDOW)).rejects.toThrow(UserFacingError);
  });

  it('stopAll stops everything', async () => {
    const fake = makeEngine();
    const bridge = createProcessAudioBridge(fake.engine);
    await bridge.start(makeSender().sender, WINDOW);
    await bridge.start(makeSender().sender, SCREEN);
    await bridge.stopAll();
    expect(fake.engine.stopAll).toHaveBeenCalledTimes(1);
    expect(fake.running.size).toBe(0);
  });
});
