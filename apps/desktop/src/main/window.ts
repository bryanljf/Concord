import { BrowserWindow } from 'electron';
import { log } from './log';
import type { Notifier } from './notifications';
import { resourcePath } from './resources';
import type { SettingsStore } from './settings';
import {
  bindFullscreenEvents,
  createQueuedSender,
  hardenWebContents,
  rendererEntry,
  rendererWebPreferences,
  type AppWindow,
  type WindowRegistry,
} from './windows';

export { isHttpUrl } from './windows';

const logger = log('window');

// Keep in sync with `--bg-tertiary`, `--text-muted` and `--titlebar-height` (renderer/theme.css).
const TITLE_BAR_COLOR = '#1e1f22';
const TITLE_BAR_SYMBOL_COLOR = '#949ba4';
const TITLE_BAR_HEIGHT = 32;

export interface MainWindowDeps {
  settings: SettingsStore;
  notifier: Notifier;
  registry: WindowRegistry;
  /** Do not show the window when it becomes ready (`--hidden`). */
  startHidden: boolean;
  /** True once "Sair" was chosen or the app is quitting, so `close` really closes. */
  isQuitting(): boolean;
}

export interface MainWindow extends AppWindow {
  readonly kind: 'main';
  show(): void;
  hide(): void;
  toggle(): void;
  destroy(): void;
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
    // Custom title bar drawn by the renderer (`TitleBar`); Windows keeps drawing the native
    // minimize/maximize/close buttons (Snap Layouts included) over its right end.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLE_BAR_COLOR,
      symbolColor: TITLE_BAR_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: rendererWebPreferences('main'),
  });
  const entry = rendererEntry();
  const send = createQueuedSender(win);

  win.once('ready-to-show', () => {
    if (deps.startHidden) {
      logger.info('started hidden (--hidden)');
    } else {
      win.show();
    }
  });

  hardenWebContents(win, entry.appOrigin);
  bindFullscreenEvents(win, send);

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

  void entry.load(win);

  function show(): void {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  const window: MainWindow = {
    kind: 'main',
    browserWindow: win,
    send,
    show,
    hide() {
      if (!win.isDestroyed()) win.hide();
    },
    toggle() {
      if (win.isDestroyed()) return;
      if (win.isVisible() && !win.isMinimized()) win.hide();
      else show();
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
  deps.registry.add(window);
  return window;
}
