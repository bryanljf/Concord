import { describe, expect, it, vi } from 'vitest';
import {
  FORMAT,
  hresultFromMessage,
  load,
  pcm16ToFloat32,
  windowsBuildFromRelease,
  type NativeCaptureError,
} from '../index';

type ChunkListener = (chunk: Buffer) => void;

/** Minimal stand-in for the `loopback-capture` addon class. */
function createFakeAddon(options: { startError?: string; stopError?: string } = {}) {
  const instances: FakeCapture[] = [];
  class FakeCapture {
    started: { pid: number; includeTree: boolean } | null = null;
    stopped = false;
    listener: ChunkListener | null = null;
    constructor() {
      instances.push(this);
    }
    start(pid: number, includeTree: boolean, cb: ChunkListener): void {
      if (options.startError) throw new Error(options.startError);
      this.started = { pid, includeTree };
      this.listener = cb;
    }
    stop(): void {
      if (options.stopError) throw new Error(options.stopError);
      this.stopped = true;
    }
  }
  return { addon: { LoopbackCapture: FakeCapture }, instances };
}

function int16Buffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

describe('windowsBuildFromRelease', () => {
  it('extracts the build number', () => {
    expect(windowsBuildFromRelease('10.0.26200')).toBe(26200);
    expect(windowsBuildFromRelease('10.0.19041')).toBe(19041);
  });

  it('returns 0 for unknown formats', () => {
    expect(windowsBuildFromRelease('')).toBe(0);
    expect(windowsBuildFromRelease('6.3')).toBe(0);
  });
});

describe('hresultFromMessage', () => {
  it('parses the addon error format', () => {
    expect(hresultFromMessage('Failed to start loopback capture (HRESULT 0x80070057)')).toBe(
      0x80070057,
    );
  });

  it('returns null when there is no HRESULT', () => {
    expect(hresultFromMessage('something else')).toBeNull();
  });
});

describe('pcm16ToFloat32', () => {
  it('scales samples to [-1, 1)', () => {
    const out = pcm16ToFloat32(int16Buffer([0, 32767, -32768, 16384]));
    expect(Array.from(out)).toEqual([0, 32767 / 32768, -1, 0.5]);
  });

  it('handles views that are not 2-byte aligned', () => {
    const backing = Buffer.alloc(5);
    backing.writeInt16LE(-16384, 1);
    backing.writeInt16LE(8192, 3);
    const unaligned = backing.subarray(1, 5);
    expect(unaligned.byteOffset % 2).toBe(1);
    expect(Array.from(pcm16ToFloat32(unaligned))).toEqual([-0.5, 0.25]);
  });
});

describe('load', () => {
  it('returns null outside win32 x64 without touching the addon', () => {
    const requireAddon = vi.fn();
    expect(load({ platform: 'linux', arch: 'x64', requireAddon })).toBeNull();
    expect(load({ platform: 'win32', arch: 'arm64', requireAddon })).toBeNull();
    expect(requireAddon).not.toHaveBeenCalled();
  });

  it('returns null when the addon cannot be required or has no class', () => {
    expect(
      load({
        platform: 'win32',
        arch: 'x64',
        requireAddon: () => {
          throw new Error('Cannot find module');
        },
      }),
    ).toBeNull();
    expect(load({ platform: 'win32', arch: 'x64', requireAddon: () => ({}) })).toBeNull();
  });

  it('reports support from the Windows build number', () => {
    const { addon } = createFakeAddon();
    const old = load({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.18363',
      requireAddon: () => addon,
    });
    const recent = load({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26200',
      requireAddon: () => addon,
    });
    expect(old?.isSupported()).toBe(false);
    expect(old?.windowsBuild()).toBe(18363);
    expect(recent?.isSupported()).toBe(true);
  });
});

describe('createCapture', () => {
  function loadWith(fake: ReturnType<typeof createFakeAddon>) {
    const native = load({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26200',
      requireAddon: () => fake.addon,
    });
    if (!native) throw new Error('expected native module');
    return native;
  }

  it('maps include/exclude to the addon flag and converts chunks', () => {
    const fake = createFakeAddon();
    const capture = loadWith(fake).createCapture();
    const chunks: Float32Array[] = [];
    const format = capture.start({ pid: 4242, mode: 'exclude' }, (chunk) => chunks.push(chunk));
    expect(format).toEqual(FORMAT);
    expect(capture.running).toBe(true);
    const instance = fake.instances[0];
    expect(instance?.started).toEqual({ pid: 4242, includeTree: false });
    instance?.listener?.(int16Buffer([32767, -32768]));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0] ?? [])).toEqual([32767 / 32768, -1]);
  });

  it('uses include mode for the include option', () => {
    const fake = createFakeAddon();
    loadWith(fake)
      .createCapture()
      .start({ pid: 7, mode: 'include' }, () => undefined);
    expect(fake.instances[0]?.started).toEqual({ pid: 7, includeTree: true });
  });

  it('rejects invalid options before touching the addon', () => {
    const fake = createFakeAddon();
    const capture = loadWith(fake).createCapture();
    expect(() => capture.start({ pid: 0, mode: 'include' }, () => undefined)).toThrow(RangeError);
    expect(() => capture.start({ pid: 1.5, mode: 'include' }, () => undefined)).toThrow(RangeError);
    expect(() => capture.start({ pid: 1, mode: 'both' as 'include' }, () => undefined)).toThrow(
      RangeError,
    );
    expect(fake.instances).toHaveLength(0);
    expect(capture.running).toBe(false);
  });

  it('wraps addon failures with the parsed HRESULT', () => {
    const fake = createFakeAddon({
      startError: 'Failed to start loopback capture (HRESULT 0x80070057)',
    });
    const capture = loadWith(fake).createCapture();
    let caught: NativeCaptureError | null = null;
    try {
      capture.start({ pid: 1, mode: 'include' }, () => undefined);
    } catch (err) {
      caught = err as NativeCaptureError;
    }
    expect(caught?.name).toBe('NativeCaptureError');
    expect(caught?.hresult).toBe(0x80070057);
    expect(capture.running).toBe(false);
  });

  it('stops after the minimum run time and drops late chunks', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeAddon();
      const capture = loadWith(fake).createCapture();
      const chunks: Float32Array[] = [];
      capture.start({ pid: 1, mode: 'include' }, (chunk) => chunks.push(chunk));
      const stopping = capture.stop();
      expect(capture.running).toBe(false);
      const instance = fake.instances[0];
      expect(instance?.stopped).toBe(false);
      instance?.listener?.(int16Buffer([1000]));
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
      expect(instance?.stopped).toBe(true);
      expect(chunks).toHaveLength(0);
      await expect(capture.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a second start while running', () => {
    const fake = createFakeAddon();
    const capture = loadWith(fake).createCapture();
    capture.start({ pid: 1, mode: 'include' }, () => undefined);
    expect(() => capture.start({ pid: 2, mode: 'include' }, () => undefined)).toThrow(
      /already running/,
    );
  });
});
