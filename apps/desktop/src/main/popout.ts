import { BrowserWindow, type WebContents } from 'electron';
import { EVENTS } from '../preload/channels';
import type { PopoutTarget } from '../preload/api';
import { log } from './log';
import { resourcePath } from './resources';
import { expectRoomId, expectString, IpcValidationError, isRecord } from './validation';
import {
  bindFullscreenEvents,
  createQueuedSender,
  hardenWebContents,
  rendererEntry,
  rendererWebPreferences,
  type AppWindow,
  type WindowRegistry,
} from './windows';

const logger = log('popout');

export const POPOUT_DEFAULT_SIZE = { width: 960, height: 540 } as const;
export const POPOUT_MIN_SIZE = { width: 320, height: 180 } as const;
/** LiveKit identities are user ids (plus `~popout` style suffixes); keep them short. */
export const MAX_PARTICIPANT_ID_LENGTH = 128;

/** Validates an `openPopout` argument coming from the renderer. */
export function parsePopoutTarget(raw: unknown): PopoutTarget {
  if (!isRecord(raw)) throw new IpcValidationError('target');
  const room = expectRoomId(raw.room);
  const participantId = expectString(raw.participantId, 'participantId');
  if (participantId === '' || participantId.length > MAX_PARTICIPANT_ID_LENGTH) {
    throw new IpcValidationError('participantId');
  }
  return { room, participantId };
}

export interface PopoutDeps {
  registry: WindowRegistry;
}

export interface PopoutManager {
  /** Creates the pop-out on `target`, or re-targets the existing one and focuses it. */
  open(target: PopoutTarget): void;
  close(): void;
  /** What the pop-out is showing; null when it is closed. */
  getTarget(): PopoutTarget | null;
  setAlwaysOnTop(enabled: boolean): void;
  isPopoutSender(sender: WebContents): boolean;
  /** Closes without ceremony (app quit). */
  destroy(): void;
}

/**
 * One frameless window that shows a single participant's stream (SPEC 5.5). It loads the same
 * renderer as the main window; the preload tells it `windowKind === 'popout'` and it asks for
 * its target with `getPopoutTarget()`, then follows `NAVIGATE` pushes for re-targeting.
 */
export function createPopoutManager(deps: PopoutDeps): PopoutManager {
  let current: AppWindow | null = null;
  let target: PopoutTarget | null = null;
  /** Remembered for the session so reopening keeps the user's choice. */
  let alwaysOnTop = false;

  function alive(): AppWindow | null {
    return current && !current.browserWindow.isDestroyed() ? current : null;
  }

  function create(): AppWindow {
    const win = new BrowserWindow({
      width: POPOUT_DEFAULT_SIZE.width,
      height: POPOUT_DEFAULT_SIZE.height,
      minWidth: POPOUT_MIN_SIZE.width,
      minHeight: POPOUT_MIN_SIZE.height,
      frame: false,
      backgroundColor: '#1e1f22',
      title: 'Concord — pop-out',
      icon: resourcePath('icon.png'),
      show: false,
      autoHideMenuBar: true,
      alwaysOnTop,
      webPreferences: rendererWebPreferences('popout'),
    });
    const entry = rendererEntry();
    const send = createQueuedSender(win);
    const window: AppWindow = { kind: 'popout', browserWindow: win, send };

    win.once('ready-to-show', () => win.show());
    hardenWebContents(win, entry.appOrigin);
    bindFullscreenEvents(win, send);
    win.on('closed', () => {
      if (current === window) {
        current = null;
        target = null;
        logger.info('closed');
      }
    });
    deps.registry.add(window);
    void entry.load(win);
    logger.info('created');
    return window;
  }

  return {
    open(next) {
      target = next;
      let window = alive();
      if (!window) {
        window = create();
        current = window;
      }
      // Queued until the renderer has loaded, so this also covers a freshly created window.
      window.send(EVENTS.NAVIGATE, next);
      const win = window.browserWindow;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      logger.info(`showing ${next.participantId} in #${next.room}`);
    },
    close() {
      alive()?.browserWindow.close();
    },
    getTarget: () => (alive() ? target : null),
    setAlwaysOnTop(enabled) {
      alwaysOnTop = enabled;
      alive()?.browserWindow.setAlwaysOnTop(enabled);
      logger.info(`always on top: ${enabled}`);
    },
    isPopoutSender: (sender) => alive()?.browserWindow.webContents === sender,
    destroy() {
      alive()?.browserWindow.destroy();
      current = null;
      target = null;
    },
  };
}
