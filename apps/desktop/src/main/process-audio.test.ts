import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
}));

import type { WebContents } from 'electron';
import { EVENTS } from '../preload/channels';
import type { ProcessAudioDataListener, ProcessAudioEngine } from './audio';
import { createProcessAudioBridge } from './process-audio';
import { IpcValidationError, UserFacingError } from './validation';

function makeEngine(supported = true) {
  let onData: ProcessAudioDataListener | null = null;
  let running = false;
  const engine: ProcessAudioEngine = {
    support: () => ({ supported, reason: supported ? null : 'Sem suporte neste Windows.' }),
    start: vi.fn(async (_sourceId: string, listener: ProcessAudioDataListener) => {
      onData = listener;
      running = true;
      return { sampleRate: 48_000, channels: 2 };
    }),
    stop: vi.fn(async () => {
      running = false;
      onData = null;
    }),
    get running() {
      return running;
    },
  };
  return { engine, push: (chunk: Float32Array) => onData?.(chunk) };
}

function makeSender() {
  let destroyed = false;
  let onDestroyed: (() => void) | null = null;
  const raw = {
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: vi.fn((_event: string, listener: () => void) => {
      onDestroyed = listener;
    }),
    removeListener: vi.fn(),
  };
  return {
    sender: raw as unknown as WebContents,
    raw,
    destroy: () => {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

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
    await expect(bridge.start(makeSender().sender, 'window:42:0')).rejects.toThrow(UserFacingError);
    await expect(bridge.start(makeSender().sender, 'window:42:0')).rejects.toThrow(
      'Sem suporte neste Windows.',
    );
    expect(engine.start).not.toHaveBeenCalled();
  });

  it('validates the source id', async () => {
    const bridge = createProcessAudioBridge(makeEngine().engine);
    await expect(bridge.start(makeSender().sender, 'nope')).rejects.toThrow(IpcValidationError);
    await expect(bridge.start(makeSender().sender, 42)).rejects.toThrow(IpcValidationError);
  });

  it('forwards PCM chunks to the requesting window until stopped', async () => {
    const { engine, push } = makeEngine();
    const bridge = createProcessAudioBridge(engine);
    const { sender, raw } = makeSender();

    await expect(bridge.start(sender, 'window:42:0')).resolves.toEqual({
      sampleRate: 48_000,
      channels: 2,
    });
    expect(engine.start).toHaveBeenCalledWith('window:42:0', expect.any(Function));

    const chunk = new Float32Array([0.1, -0.1]);
    push(chunk);
    expect(raw.send).toHaveBeenCalledWith(EVENTS.PROCESS_AUDIO_DATA, chunk);

    await bridge.stop();
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(raw.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
    push(chunk);
    expect(raw.send).toHaveBeenCalledTimes(1);
  });

  it('stops when the owning window is destroyed', async () => {
    const { engine } = makeEngine();
    const bridge = createProcessAudioBridge(engine);
    const owner = makeSender();
    await bridge.start(owner.sender, 'screen:0:0');
    owner.destroy();
    await vi.waitFor(() => expect(engine.stop).toHaveBeenCalledTimes(1));
  });

  it('restarting replaces the previous capture', async () => {
    const { engine } = makeEngine();
    const bridge = createProcessAudioBridge(engine);
    await bridge.start(makeSender().sender, 'window:1:0');
    await bridge.start(makeSender().sender, 'window:2:0');
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(engine.start).toHaveBeenCalledTimes(2);
  });

  it('stop() is a no-op when nothing runs', async () => {
    const { engine } = makeEngine();
    await createProcessAudioBridge(engine).stop();
    expect(engine.stop).not.toHaveBeenCalled();
  });
});
