import { desktopCapturer, session, type Streams } from 'electron';
import type { CaptureSelection, CaptureSource } from '../preload/api';
import { log } from './log';
import { expectBoolean, expectString, IpcValidationError, isRecord } from './validation';
import type { WindowRegistry } from './windows';

const logger = log('capture');

/** A selection older than this (or already consumed) no longer answers `getDisplayMedia`. */
export const SELECTION_TTL_MS = 60_000;
export const THUMBNAIL_SIZE = { width: 320, height: 180 } as const;

// ---------------------------------------------------------------------------
// Source ids
// ---------------------------------------------------------------------------

export interface ParsedSourceId {
  kind: CaptureSource['kind'];
  /** Native window handle (HWND as decimal) or screen index. */
  handle: string;
  /**
   * Chromium's "aura id": `0` for windows of other processes; our own windows get a non-zero
   * id because Chromium registers them for in-process capture.
   */
  auraId: string;
}

const SOURCE_ID_PATTERN = /^(window|screen):(\d+):(\d+)$/;

/** Parses `window:<hwnd>:<n>` / `screen:<n>:0`; null for anything else. */
export function parseSourceId(id: string): ParsedSourceId | null {
  const match = SOURCE_ID_PATTERN.exec(id);
  if (!match) return null;
  const [, kind, handle, auraId] = match;
  if (kind === undefined || handle === undefined || auraId === undefined) return null;
  return { kind: kind === 'window' ? 'window' : 'screen', handle, auraId };
}

export function expectSourceId(value: unknown, name = 'sourceId'): string {
  const id = expectString(value, name);
  if (parseSourceId(id) === null) throw new IpcValidationError(name);
  return id;
}

/** Decimal form of a `BrowserWindow.getNativeWindowHandle()` buffer (HWND on Windows). */
export function nativeHandleId(handle: Buffer): string {
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString();
  if (handle.length >= 4) return handle.readUInt32LE(0).toString();
  return handle.toString('hex');
}

/** True for Concord's own windows: in-process aura id, or a handle we own. */
export function isOwnWindowSource(id: string, ownHandles: ReadonlySet<string>): boolean {
  const parsed = parseSourceId(id);
  if (!parsed || parsed.kind !== 'window') return false;
  return parsed.auraId !== '0' || ownHandles.has(parsed.handle);
}

// ---------------------------------------------------------------------------
// Source mapping
// ---------------------------------------------------------------------------

interface ImageLike {
  isEmpty(): boolean;
  toDataURL(): string;
}

/** The subset of `DesktopCapturerSource` the mapping needs (easier to fake in tests). */
export interface CapturerSourceLike {
  id: string;
  name: string;
  thumbnail: ImageLike;
  /** Documented as null for screens and when icons were not requested. */
  appIcon: ImageLike | null;
}

/** Drops unnamed sources (background/helper windows) and Concord's own windows. */
export function filterCaptureSources<T extends { id: string; name: string }>(
  sources: readonly T[],
  ownHandles: ReadonlySet<string>,
): T[] {
  return sources.filter(
    (source) => source.name.trim() !== '' && !isOwnWindowSource(source.id, ownHandles),
  );
}

export function toCaptureSource(source: CapturerSourceLike): CaptureSource {
  const kind =
    parseSourceId(source.id)?.kind ?? (source.id.startsWith('screen') ? 'screen' : 'window');
  const icon = source.appIcon;
  return {
    id: source.id,
    name: source.name,
    kind,
    thumbnailDataUrl: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    appIconDataUrl: icon && !icon.isEmpty() ? icon.toDataURL() : null,
  };
}

// ---------------------------------------------------------------------------
// Selection store
// ---------------------------------------------------------------------------

export function parseCaptureSelection(raw: unknown): CaptureSelection {
  if (!isRecord(raw)) throw new IpcValidationError('selection');
  return {
    sourceId: expectSourceId(raw.sourceId),
    systemAudio: expectBoolean(raw.systemAudio, 'systemAudio'),
  };
}

export interface CaptureSelectionStore {
  select(selection: CaptureSelection): void;
  /** The pending selection if it is fresh; consuming it so one choice answers one request. */
  consume(): CaptureSelection | null;
  clear(): void;
}

export interface CaptureSelectionStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createCaptureSelectionStore(
  options: CaptureSelectionStoreOptions = {},
): CaptureSelectionStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SELECTION_TTL_MS;
  let pending: { selection: CaptureSelection; at: number } | null = null;
  return {
    select(selection) {
      pending = { selection, at: now() };
    },
    consume() {
      if (!pending) return null;
      const { selection, at } = pending;
      pending = null;
      return now() - at <= ttlMs ? selection : null;
    },
    clear() {
      pending = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CaptureServiceDeps {
  windows: WindowRegistry;
  store?: CaptureSelectionStore;
}

export interface CaptureService {
  getSources(): Promise<CaptureSource[]>;
  select(selection: CaptureSelection): void;
  /** Installs the `getDisplayMedia` handler on the default session. */
  install(): void;
  uninstall(): void;
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const store = deps.store ?? createCaptureSelectionStore();

  function ownHandles(): Set<string> {
    const handles = new Set<string>();
    for (const window of deps.windows.all()) {
      try {
        handles.add(nativeHandleId(window.browserWindow.getNativeWindowHandle()));
      } catch (err) {
        logger.warn('could not read a native window handle', err);
      }
    }
    return handles;
  }

  async function findSource(selection: CaptureSelection): Promise<Streams | null> {
    const kind = parseSourceId(selection.sourceId)?.kind;
    if (!kind) return null;
    const sources = await desktopCapturer.getSources({
      types: [kind],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const source = sources.find((candidate) => candidate.id === selection.sourceId);
    if (!source) return null;
    const streams: Streams = { video: source };
    if (selection.systemAudio) streams.audio = 'loopback';
    return streams;
  }

  return {
    async getSources() {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: THUMBNAIL_SIZE,
        fetchWindowIcons: true,
      });
      const visible = filterCaptureSources(sources, ownHandles());
      return visible.map(toCaptureSource);
    },
    select(selection) {
      store.select(selection);
      logger.info(
        `selected ${selection.sourceId} (system audio: ${selection.systemAudio ? 'on' : 'off'})`,
      );
    },
    install() {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        if (!deps.windows.isTrustedFrame(request.frame)) {
          logger.warn(`display-media request from ${request.securityOrigin} denied`);
          callback({});
          return;
        }
        const selection = store.consume();
        if (!selection) {
          logger.warn('display-media request without a fresh selection; denied');
          callback({});
          return;
        }
        findSource(selection)
          .then((streams) => {
            if (!streams) {
              logger.warn(`selected source ${selection.sourceId} is gone; denied`);
              callback({});
              return;
            }
            logger.info(
              `granting ${selection.sourceId}${streams.audio ? ' + loopback audio' : ''}`,
            );
            callback(streams);
          })
          .catch((err: unknown) => {
            logger.error('could not resolve the selected source', err);
            callback({});
          });
      });
      logger.info('display-media handler installed');
    },
    uninstall() {
      session.defaultSession.setDisplayMediaRequestHandler(null);
      store.clear();
    },
  };
}
