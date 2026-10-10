import { app, shell, type BrowserWindow, type WebContents, type WebFrameMain } from 'electron';
import { join } from 'node:path';
import { EVENTS, WINDOW_KIND_ARG, type EventChannel } from '../preload/channels';
import { log } from './log';

const logger = log('windows');

/** Delay after `did-finish-load` before queued messages are flushed, so React has subscribed. */
export const RENDERER_SETTLE_MS = 500;

export type WindowKind = 'main' | 'popout';

/** A BrowserWindow that runs our renderer and may talk to the main process over IPC. */
export interface AppWindow {
  readonly kind: WindowKind;
  readonly browserWindow: BrowserWindow;
  /** Sends to the renderer, queueing until it has loaded. */
  send(channel: EventChannel, ...args: unknown[]): void;
}

export type Sender = AppWindow['send'];

/**
 * Registry of the windows allowed to call IPC handlers (main + pop-out). Everything the main
 * process pushes to "the UI" goes through `broadcast`, so both renderers stay in sync.
 */
export interface WindowRegistry {
  /** Registers a window until it is closed; returns an early-removal function. */
  add(window: AppWindow): () => void;
  /** The registered, still-alive window owning `sender`, or null for anything else. */
  fromSender(sender: WebContents): AppWindow | null;
  isTrustedSender(sender: WebContents): boolean;
  /** True when `frame` is the main frame of a registered window (display-media requests). */
  isTrustedFrame(frame: WebFrameMain | null): boolean;
  broadcast(channel: EventChannel, ...args: unknown[]): void;
  all(): AppWindow[];
}

export function createWindowRegistry(): WindowRegistry {
  const windows = new Set<AppWindow>();

  function live(): AppWindow[] {
    return [...windows].filter((window) => !window.browserWindow.isDestroyed());
  }

  function fromSender(sender: WebContents): AppWindow | null {
    return live().find((window) => window.browserWindow.webContents === sender) ?? null;
  }

  return {
    add(window) {
      windows.add(window);
      const remove = (): void => {
        windows.delete(window);
      };
      window.browserWindow.once('closed', remove);
      return remove;
    },
    fromSender,
    isTrustedSender: (sender) => fromSender(sender) !== null,
    isTrustedFrame(frame) {
      if (frame === null) return false;
      return live().some((window) => {
        const main = window.browserWindow.webContents.mainFrame;
        return main.frameTreeNodeId === frame.frameTreeNodeId && main.processId === frame.processId;
      });
    },
    broadcast(channel, ...args) {
      for (const window of live()) window.send(channel, ...args);
    },
    all: live,
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by the main and pop-out windows
// ---------------------------------------------------------------------------

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Where the renderer comes from: the electron-vite dev server, or the built `out/renderer`. */
export interface RendererEntry {
  /** Only origins starting with this may be navigated to inside the window. */
  appOrigin: string;
  load(win: BrowserWindow): Promise<void>;
}

export function rendererEntry(): RendererEntry {
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (devUrl) {
    return { appOrigin: new URL(devUrl).origin, load: (win) => win.loadURL(devUrl) };
  }
  return {
    appOrigin: 'file://',
    load: (win) => win.loadFile(join(__dirname, '../renderer/index.html')),
  };
}

/** SPEC 5.1: isolated, sandboxed renderer; the preload learns its window kind from argv. */
export function rendererWebPreferences(kind: WindowKind): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [WINDOW_KIND_ARG + kind],
  };
}

/**
 * Links never open new Electron windows: http(s) go to the system browser, the rest is
 * dropped; navigation away from the app origin is blocked.
 */
export function hardenWebContents(win: BrowserWindow, appOrigin: string): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    if (event.url.startsWith(appOrigin)) return;
    event.preventDefault();
    logger.warn(`blocked navigation to ${event.url}`);
    if (isHttpUrl(event.url)) void shell.openExternal(event.url);
  });
}

/** Mirrors the window's fullscreen transitions to its renderer (`onFullscreenChanged`). */
export function bindFullscreenEvents(win: BrowserWindow, send: Sender): void {
  win.on('enter-full-screen', () => send(EVENTS.FULLSCREEN_CHANGED, true));
  win.on('leave-full-screen', () => send(EVENTS.FULLSCREEN_CHANGED, false));
}

/**
 * `webContents.send` that waits for the renderer: messages sent before `did-finish-load`
 * (plus a short settle delay) are queued and flushed in order once React has subscribed.
 */
export function createQueuedSender(win: BrowserWindow): Sender {
  let loaded = false;
  let queue: { channel: EventChannel; args: unknown[] }[] = [];

  function flush(): void {
    if (!loaded || win.isDestroyed()) return;
    const pending = queue;
    queue = [];
    for (const { channel, args } of pending) win.webContents.send(channel, ...args);
  }

  win.webContents.on('did-finish-load', () => {
    loaded = true;
    setTimeout(flush, RENDERER_SETTLE_MS);
  });
  win.webContents.on('did-start-loading', () => {
    loaded = false;
  });

  return (channel, ...args) => {
    if (win.isDestroyed()) return;
    if (loaded && queue.length === 0) {
      win.webContents.send(channel, ...args);
    } else {
      queue.push({ channel, args });
    }
  };
}
