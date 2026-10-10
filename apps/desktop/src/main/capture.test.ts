import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
}));

import { desktopCapturer, session, type Streams } from 'electron';
import {
  createCaptureSelectionStore,
  createCaptureService,
  filterCaptureSources,
  isOwnWindowSource,
  nativeHandleId,
  parseCaptureSelection,
  parseSourceId,
  SELECTION_TTL_MS,
  toCaptureSource,
} from './capture';
import { IpcValidationError } from './validation';
import type { WindowRegistry } from './windows';

const image = (dataUrl: string, empty = false) => ({
  isEmpty: () => empty,
  toDataURL: () => dataUrl,
});

describe('parseSourceId', () => {
  it('parses window and screen ids', () => {
    expect(parseSourceId('window:1234:0')).toEqual({ kind: 'window', handle: '1234', auraId: '0' });
    expect(parseSourceId('window:1234:3')).toEqual({ kind: 'window', handle: '1234', auraId: '3' });
    expect(parseSourceId('screen:0:0')).toEqual({ kind: 'screen', handle: '0', auraId: '0' });
  });

  it('rejects anything else', () => {
    for (const id of ['', 'tab:1:0', 'window:abc:0', 'window:1', 'screen:0:0:0', ' window:1:0']) {
      expect(parseSourceId(id)).toBeNull();
    }
  });
});

describe('isOwnWindowSource', () => {
  const own = new Set(['1234']);

  it('recognises our handles and in-process (non-zero aura id) windows', () => {
    expect(isOwnWindowSource('window:1234:0', own)).toBe(true);
    expect(isOwnWindowSource('window:9999:1', own)).toBe(true);
  });

  it('keeps other windows and every screen', () => {
    expect(isOwnWindowSource('window:9999:0', own)).toBe(false);
    expect(isOwnWindowSource('screen:1234:0', own)).toBe(false);
    expect(isOwnWindowSource('garbage', own)).toBe(false);
  });
});

describe('filterCaptureSources', () => {
  it('drops unnamed sources and our own windows', () => {
    const sources = [
      { id: 'screen:0:0', name: 'Entire Screen' },
      { id: 'window:1:0', name: '' },
      { id: 'window:2:0', name: '   ' },
      { id: 'window:1234:0', name: 'Concord' },
      { id: 'window:77:2', name: 'Concord — pop-out' },
      { id: 'window:42:0', name: 'Elden Ring' },
    ];
    expect(filterCaptureSources(sources, new Set(['1234'])).map((s) => s.id)).toEqual([
      'screen:0:0',
      'window:42:0',
    ]);
  });
});

describe('toCaptureSource', () => {
  it('maps a window with an icon', () => {
    expect(
      toCaptureSource({
        id: 'window:42:0',
        name: 'Elden Ring',
        thumbnail: image('data:image/png;base64,thumb'),
        appIcon: image('data:image/png;base64,icon'),
      }),
    ).toEqual({
      id: 'window:42:0',
      name: 'Elden Ring',
      kind: 'window',
      thumbnailDataUrl: 'data:image/png;base64,thumb',
      appIconDataUrl: 'data:image/png;base64,icon',
    });
  });

  it('maps a screen without icon and tolerates empty images', () => {
    expect(
      toCaptureSource({
        id: 'screen:1:0',
        name: 'Screen 2',
        thumbnail: image('x', true),
        appIcon: null,
      }),
    ).toEqual({
      id: 'screen:1:0',
      name: 'Screen 2',
      kind: 'screen',
      thumbnailDataUrl: '',
      appIconDataUrl: null,
    });
    expect(
      toCaptureSource({
        id: 'window:1:0',
        name: 'w',
        thumbnail: image('t'),
        appIcon: image('', true),
      }).appIconDataUrl,
    ).toBeNull();
  });
});

describe('nativeHandleId', () => {
  it('reads 64-bit and 32-bit little-endian handles as decimal', () => {
    const wide = Buffer.alloc(8);
    wide.writeBigUInt64LE(0x1234n);
    expect(nativeHandleId(wide)).toBe('4660');
    const narrow = Buffer.alloc(4);
    narrow.writeUInt32LE(0xabcd);
    expect(nativeHandleId(narrow)).toBe('43981');
    expect(nativeHandleId(Buffer.from([0xff]))).toBe('ff');
  });
});

describe('parseCaptureSelection', () => {
  it('accepts a well-formed selection', () => {
    expect(parseCaptureSelection({ sourceId: 'screen:0:0', systemAudio: true })).toEqual({
      sourceId: 'screen:0:0',
      systemAudio: true,
    });
  });

  it('rejects bad shapes', () => {
    expect(() => parseCaptureSelection(null)).toThrow(IpcValidationError);
    expect(() => parseCaptureSelection({ sourceId: 'nope', systemAudio: false })).toThrow(
      IpcValidationError,
    );
    expect(() => parseCaptureSelection({ sourceId: 'screen:0:0', systemAudio: 'yes' })).toThrow(
      IpcValidationError,
    );
  });
});

describe('createCaptureSelectionStore', () => {
  const selection = { sourceId: 'window:42:0', systemAudio: false };

  it('hands out a fresh selection exactly once', () => {
    let now = 1_000;
    const store = createCaptureSelectionStore({ now: () => now });
    expect(store.consume()).toBeNull();
    store.select(selection);
    now += SELECTION_TTL_MS;
    expect(store.consume()).toEqual(selection);
    expect(store.consume()).toBeNull();
  });

  it('expires a selection older than the TTL', () => {
    let now = 1_000;
    const store = createCaptureSelectionStore({ now: () => now });
    store.select(selection);
    now += SELECTION_TTL_MS + 1;
    expect(store.consume()).toBeNull();
  });

  it('replaces the pending selection and can be cleared', () => {
    const store = createCaptureSelectionStore({ now: () => 0, ttlMs: 10 });
    store.select(selection);
    store.select({ ...selection, systemAudio: true });
    expect(store.consume()?.systemAudio).toBe(true);
    store.select(selection);
    store.clear();
    expect(store.consume()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

type DisplayMediaHandler = (
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Streams | null) => void,
) => void;

function makeService(trusted = true) {
  const windows = {
    all: () => [],
    isTrustedFrame: vi.fn(() => trusted),
  } as unknown as WindowRegistry;
  const store = createCaptureSelectionStore({ now: () => 0 });
  const service = createCaptureService({ windows, store });
  service.install();
  const calls = vi.mocked(session.defaultSession.setDisplayMediaRequestHandler).mock.calls;
  const handler = calls[calls.length - 1]?.[0] as DisplayMediaHandler;
  return { service, store, handler };
}

function request(): Electron.DisplayMediaRequestHandlerHandlerRequest {
  return {
    frame: null,
    securityOrigin: 'file://',
    videoRequested: true,
    audioRequested: true,
    userGesture: true,
  };
}

function answer(handler: DisplayMediaHandler): Promise<Streams | null> {
  return new Promise((resolve) => handler(request(), resolve));
}

describe('display-media handler', () => {
  it('denies requests without a fresh selection', async () => {
    const { handler } = makeService();
    expect(await answer(handler)).toEqual({});
  });

  it('denies requests from frames that are not ours', async () => {
    const { service, handler } = makeService(false);
    service.select({ sourceId: 'screen:0:0', systemAudio: false });
    expect(await answer(handler)).toEqual({});
  });

  it('grants the selected source, adding loopback audio when asked', async () => {
    const screen = { id: 'screen:0:0', name: 'Entire Screen' };
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      screen as Electron.DesktopCapturerSource,
    ]);
    const { service, handler } = makeService();

    service.select({ sourceId: 'screen:0:0', systemAudio: true });
    expect(await answer(handler)).toEqual({ video: screen, audio: 'loopback' });
    expect(vi.mocked(desktopCapturer.getSources).mock.lastCall?.[0]).toMatchObject({
      types: ['screen'],
    });

    service.select({ sourceId: 'screen:0:0', systemAudio: false });
    expect(await answer(handler)).toEqual({ video: screen });

    // Consumed: the next request has nothing to answer with.
    expect(await answer(handler)).toEqual({});
  });

  it('denies when the selected source disappeared', async () => {
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([]);
    const { service, handler } = makeService();
    service.select({ sourceId: 'window:42:0', systemAudio: false });
    expect(await answer(handler)).toEqual({});
  });
});
