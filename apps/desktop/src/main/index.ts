import { app, globalShortcut } from 'electron';
import { EVENTS } from '../preload/channels';
import { createApiClient } from './api-client';
import { createProcessAudioEngine } from './audio';
import { bindAutostart } from './autostart';
import { createCaptureService } from './capture';
import { parseCliArgs } from './cli';
import { createDiscordWatcher } from './discord-watcher';
import { registerIpc } from './ipc';
import { log } from './log';
import { createNotifier } from './notifications';
import { createPopoutManager } from './popout';
import { PresenceClient } from './presence-client';
import { PresenceController } from './presence-controller';
import { createProcessAudioBridge } from './process-audio';
import { createSessionManager } from './session';
import { createSettingsStore } from './settings';
import { bindGlobalShortcut } from './shortcuts';
import { createStreamingStore } from './streaming';
import { createTray } from './tray';
import { createUpdater } from './updater';
import { createMainWindow } from './window';
import { createWindowRegistry } from './windows';

const logger = log('app');

/**
 * Must match `appId` in electron-builder.yml so Windows attributes notifications to the
 * installed app. In development the executable path is used, as Electron recommends.
 */
const APP_USER_MODEL_ID = 'com.concord.desktop';

/** Delay between a `--server/--key` dev login and the `--room` navigation (see applyDevFlags). */
const DEV_NAVIGATE_DELAY_MS = 1500;

const cli = parseCliArgs(process.argv.slice(1));
let quitting = false;

// `userData` must be set before `ready` and before the single-instance lock, which is per
// userData directory: that is what allows two instances side by side for testing.
if (cli.userDataDir) {
  app.setPath('userData', cli.userDataDir);
  app.setPath('sessionData', cli.userDataDir);
}

if (!app.requestSingleInstanceLock()) {
  logger.info('another instance is running; exiting');
  app.quit();
} else {
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // The tray owns the lifecycle: closing (hiding) the window never quits.
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(bootstrap);
}

function bootstrap(): void {
  logger.info(
    `starting (version ${app.getVersion()}, packaged=${app.isPackaged}, userData=${app.getPath('userData')})`,
  );

  const settings = createSettingsStore();
  const notifier = createNotifier();
  const api = createApiClient({
    getServerUrl: () => settings.get().serverUrl,
    getKey: () => settings.getKey(),
  });
  const session = createSessionManager({ settings, createClient: createApiClient });
  const discord = createDiscordWatcher();
  const presence = new PresenceClient({
    getServerUrl: () => settings.get().serverUrl,
    getKey: () => settings.getKey(),
  });
  const controller = new PresenceController({
    settings,
    session,
    discord,
    client: presence,
    notifier,
  });

  const windows = createWindowRegistry();
  const window = createMainWindow({
    settings,
    notifier,
    registry: windows,
    startHidden: cli.hidden,
    isQuitting: () => quitting,
  });
  const popout = createPopoutManager({ registry: windows });
  const streaming = createStreamingStore();
  const capture = createCaptureService({ windows });
  const processAudio = createProcessAudioBridge(createProcessAudioEngine());
  const updater = createUpdater({
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    // `quitAndInstall` closes every window first: without this, close-to-tray would cancel it.
    onBeforeInstall: () => {
      quitting = true;
    },
  });

  function requestStreamToggle(): void {
    window.show();
    window.send(EVENTS.STREAM_TOGGLE);
  }

  function quit(): void {
    quitting = true;
    app.quit();
  }

  const tray = createTray({
    settings,
    onOpen: () => window.show(),
    onToggle: () => window.toggle(),
    onStreamToggle: requestStreamToggle,
    onOpenSettings: () => {
      window.show();
      window.send(EVENTS.OPEN_SETTINGS);
    },
    onQuit: quit,
  });

  registerIpc({
    settings,
    session,
    api,
    presence,
    windows,
    mainWindow: window,
    capture,
    streaming,
    popout,
    updater,
    processAudio,
  });
  capture.install();
  bindAutostart(settings);
  bindGlobalShortcut(settings, requestStreamToggle);

  controller.onTrayStatus((status) => tray.setPresenceStatus(status));
  streaming.onChange((state) => tray.setStreamingState(state));
  controller.onNavigate((target) => {
    window.show();
    window.send(EVENTS.NAVIGATE, target);
  });

  app.on('second-instance', () => {
    logger.info('second instance launched; focusing the window');
    window.show();
  });
  app.on('will-quit', () => {
    updater.stop();
    controller.stop();
    discord.stop();
    presence.disconnect('no_session');
    void processAudio.stop();
    popout.destroy();
    tray.destroy();
  });

  discord.start();
  controller.start();
  void session.restore();
  updater.start();

  if (!app.isPackaged) applyDevFlags();

  function applyDevFlags(): void {
    const navigate = (): void => {
      if (!cli.room) return;
      logger.info(`dev navigation to #${cli.room} (--room)`);
      window.send(EVENTS.NAVIGATE, { room: cli.room });
    };
    if (cli.server && cli.key) {
      logger.info(`dev login on ${cli.server} (--server/--key)`);
      session
        .login(cli.server, cli.key)
        // The renderer only listens for navigation once the workspace is mounted, which
        // happens after it learns about the session: give it a moment.
        .then(() => setTimeout(navigate, DEV_NAVIGATE_DELAY_MS))
        .catch((err: unknown) => logger.warn('dev login failed', err));
    } else {
      navigate();
    }
  }
}
