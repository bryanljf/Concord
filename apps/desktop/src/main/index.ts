import { app, globalShortcut } from 'electron';
import { join } from 'node:path';
import { EVENTS } from '../preload/channels';
import { createApiClient } from './api-client';
import { openDiscordLogin } from './discord-auth';
import { createProcessAudioEngine } from './audio';
import { bindAutostart } from './autostart';
import { createCaptureService } from './capture';
import { parseCliArgs } from './cli';
import { createDiscordWatcher } from './discord-watcher';
import { createFakeAutoUpdater } from './fake-updater';
import { raiseGpuPriority } from './gpu-priority';
import { registerIpc } from './ipc';
import { log } from './log';
import { createNotifier } from './notifications';
import { createNowPlaying } from './now-playing';
import { createPipManager } from './pip';
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
import { createWindowDrag } from './window-drag';
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
  // Screen capture runs in this process: keep a game from starving its GPU copies.
  raiseGpuPriority();

  const settings = createSettingsStore();
  const notifier = createNotifier();
  const api = createApiClient({
    getServerUrl: () => settings.get().serverUrl,
    getKey: () => settings.getKey(),
  });
  const session = createSessionManager({
    settings,
    createClient: createApiClient,
    openDiscordLogin,
  });
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
  const windowDrag = createWindowDrag();
  const pip = createPipManager({
    registry: windows,
    settings,
    drag: windowDrag,
    showMainWindow: () => window.show(),
  });
  const streaming = createStreamingStore();
  const capture = createCaptureService({ windows });
  const processAudio = createProcessAudioBridge(createProcessAudioEngine());
  // Second entry of the main build (electron.vite.config.ts), next to this bundle; it only
  // starts when a window first asks what a music app plays.
  const nowPlaying = createNowPlaying({ workerPath: join(__dirname, 'now-playing-worker.js') });
  // `--fake-update` (dev only): the real status machine on a simulated electron-updater.
  const fakeUpdate = app.isPackaged ? undefined : cli.fakeUpdate;
  const updater = createUpdater({
    isPackaged: app.isPackaged || fakeUpdate !== undefined,
    currentVersion: app.getVersion(),
    // `quitAndInstall` closes every window first: without this, close-to-tray would cancel it.
    onBeforeInstall: () => {
      quitting = true;
    },
    autoUpdater:
      fakeUpdate === undefined
        ? undefined
        : createFakeAutoUpdater(fakeUpdate, () => {
            app.relaunch();
            app.quit();
          }),
  });

  function requestStreamToggle(): void {
    window.show();
    window.send(EVENTS.STREAM_TOGGLE);
  }

  function installUpdate(): void {
    try {
      updater.install();
    } catch (err) {
      logger.warn('could not install the update', err);
    }
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
    onInstallUpdate: () => installUpdate(),
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
    pip,
    windowDrag,
    updater,
    processAudio,
    nowPlaying,
  });
  capture.install();
  bindAutostart(settings);
  bindGlobalShortcut(settings, requestStreamToggle);

  // Downloaded update: tray item plus one Windows notification per version.
  let notifiedVersion: string | null = null;
  updater.onStatus((status) => {
    tray.setUpdateReady(status.state === 'ready' ? status.version : null);
    if (status.state !== 'ready' || status.version === notifiedVersion) return;
    notifiedVersion = status.version;
    notifier.show({
      title: `Concord ${status.version} está pronto`,
      body: 'Clique para reiniciar e atualizar agora. Se preferir, ele instala quando você sair.',
      onClick: () => installUpdate(),
    });
  });

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
    void processAudio.stopAll();
    nowPlaying.destroy();
    windowDrag.destroy();
    popout.destroy();
    pip.destroy();
    tray.destroy();
  });

  discord.start();
  controller.start();
  void session.restore();
  // A simulated update only runs when asked for (Configurações → Sobre → Verificar atualizações).
  if (fakeUpdate === undefined) updater.start();

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
