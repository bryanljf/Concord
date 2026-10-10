import { app, globalShortcut } from 'electron';
import { EVENTS } from '../preload/channels';
import { createApiClient } from './api-client';
import { bindAutostart } from './autostart';
import { parseCliArgs } from './cli';
import { createDiscordWatcher } from './discord-watcher';
import { registerIpc } from './ipc';
import { log } from './log';
import { createNotifier } from './notifications';
import { PresenceClient } from './presence-client';
import { PresenceController } from './presence-controller';
import { createSessionManager } from './session';
import { createSettingsStore } from './settings';
import { bindGlobalShortcut } from './shortcuts';
import { createTray } from './tray';
import { createMainWindow } from './window';

const logger = log('app');

/**
 * Must match `appId` in electron-builder.yml (Phase 6) so Windows attributes notifications to
 * the installed app. In development the executable path is used, as Electron recommends.
 */
const APP_USER_MODEL_ID = 'com.telao.desktop';

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

  const window = createMainWindow({
    settings,
    notifier,
    startHidden: cli.hidden,
    isQuitting: () => quitting,
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
    // No settings route exists in the contract yet: showing the window is the best we can do.
    onOpenSettings: () => window.show(),
    onQuit: quit,
  });

  registerIpc({ settings, session, api, presence, window });
  bindAutostart(settings);
  bindGlobalShortcut(settings, requestStreamToggle);

  controller.onTrayStatus((status) => tray.setStatus(status));
  controller.onNavigate((target) => {
    window.show();
    window.send(EVENTS.NAVIGATE, target);
  });

  app.on('second-instance', () => {
    logger.info('second instance launched; focusing the window');
    window.show();
  });
  app.on('will-quit', () => {
    controller.stop();
    discord.stop();
    presence.disconnect('no_session');
    tray.destroy();
  });

  discord.start();
  controller.start();
  void session.restore();

  if (!app.isPackaged) applyDevFlags();

  function applyDevFlags(): void {
    if (cli.server && cli.key) {
      logger.info(`dev login on ${cli.server} (--server/--key)`);
      session
        .login(cli.server, cli.key)
        .catch((err: unknown) => logger.warn('dev login failed', err));
    }
    if (cli.room) {
      logger.info(`dev navigation to #${cli.room} (--room)`);
      window.send(EVENTS.NAVIGATE, { room: cli.room });
    }
  }
}
