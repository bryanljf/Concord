import { app, BrowserWindow, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import type { EventChannel } from '../preload/channels';
import { log } from './log';
import type { Notifier } from './notifications';
import { resourcePath } from './resources';
import type { SettingsStore } from './settings';

const logger = log('window');

/** Delay after `did-finish-load` before queued messages are flushed, so React has subscribed. */
const RENDERER_SETTLE_MS = 500;

export interface MainWindowDeps {
  settings: SettingsStore;
  notifier: Notifier;
  /** Do not show the window when it becomes ready (`--hidden`). */
  startHidden: boolean;
  /** True once "Sair" was chosen or the app is quitting, so `close` really closes. */
  isQuitting(): boolean;
}

export interface MainWindow {
  show(): void;
  hide(): void;
  toggle(): void;
  /** Sends to the renderer, queueing until it has loaded. */
  send(channel: EventChannel, ...args: unknown[]): void;
  isTrustedSender(sender: WebContents): boolean;
  destroy(): void;
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createMainWindow(deps: MainWindowDeps): MainWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#313338',
    title: 'Concord',
    icon: resourcePath('icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const appOrigin = devUrl ? new URL(devUrl).origin : 'file://';

  let loaded = false;
  let queue: { channel: EventChannel; args: unknown[] }[] = [];

  function flushQueue(): void {
    if (!loaded || win.isDestroyed()) return;
    const pending = queue;
    queue = [];
    for (const { channel, args } of pending) win.webContents.send(channel, ...args);
  }

  win.once('ready-to-show', () => {
    if (deps.startHidden) {
      logger.info('started hidden (--hidden)');
    } else {
      win.show();
    }
  });

  win.webContents.on('did-finish-load', () => {
    loaded = true;
    setTimeout(flushQueue, RENDERER_SETTLE_MS);
  });
  win.webContents.on('did-start-loading', () => {
    loaded = false;
  });

  // Links never open new Electron windows: http(s) go to the system browser, the rest is dropped.
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

  // Closing hides to the tray; the first time, explain it.
  win.on('close', (event) => {
    if (deps.isQuitting()) return;
    event.preventDefault();
    win.hide();
    if (!deps.settings.get().trayNoticeShown) {
      deps.notifier.show({
        title: 'O Concord continua na bandeja',
        body: 'Clique no ícone perto do relógio para abrir. Para sair, use o menu da bandeja.',
      });
      deps.settings.update({ trayNoticeShown: true });
    }
  });

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  function show(): void {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  return {
    show,
    hide() {
      if (!win.isDestroyed()) win.hide();
    },
    toggle() {
      if (win.isDestroyed()) return;
      if (win.isVisible() && !win.isMinimized()) win.hide();
      else show();
    },
    send(channel, ...args) {
      if (win.isDestroyed()) return;
      if (loaded && queue.length === 0) {
        win.webContents.send(channel, ...args);
      } else {
        queue.push({ channel, args });
      }
    },
    isTrustedSender: (sender) => !win.isDestroyed() && sender === win.webContents,
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
