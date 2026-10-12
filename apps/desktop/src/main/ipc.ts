import {
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import type { Settings } from '../preload/api';
import { EVENTS, IPC, type IpcChannel, type IpcResult } from '../preload/channels';
import type { ApiClient } from './api-client';
import { ApiClientError } from './api-client';
import { parseCaptureSelection, type CaptureService } from './capture';
import { log } from './log';
import { parsePopoutTarget, type PopoutManager } from './popout';
import type { PresenceClient } from './presence-client';
import { ProcessAudioError } from './audio';
import type { ProcessAudioBridge } from './process-audio';
import type { SessionManager } from './session';
import { SettingsValidationError, type SettingsStore } from './settings';
import { parseStreamingState, type StreamingStore } from './streaming';
import type { Updater } from './updater';
import {
  expectBoolean,
  expectOptionalTokenPurpose,
  expectRoomId,
  expectString,
  IpcValidationError,
  UserFacingError,
} from './validation';
import type { MainWindow } from './window';
import { isHttpUrl, type AppWindow, type WindowRegistry } from './windows';

export { IpcValidationError } from './validation';

const logger = log('ipc');

export interface IpcDeps {
  settings: SettingsStore;
  session: SessionManager;
  api: ApiClient;
  presence: PresenceClient;
  windows: WindowRegistry;
  mainWindow: MainWindow;
  capture: CaptureService;
  streaming: StreamingStore;
  popout: PopoutManager;
  updater: Updater;
  processAudio: ProcessAudioBridge;
}

/** Who is calling: always a registered window (anything else is denied before the handler). */
export interface IpcContext {
  sender: WebContents;
  window: AppWindow;
}

/** Turns any thrown value into a message that is safe to show in the UI. */
function userMessage(err: unknown): string {
  if (
    err instanceof UserFacingError ||
    err instanceof ApiClientError ||
    err instanceof SettingsValidationError ||
    err instanceof ProcessAudioError
  ) {
    return err.message;
  }
  logger.error('unexpected error in IPC handler', err);
  return 'Erro inesperado. Veja o log do aplicativo.';
}

type Handler<T> = (context: IpcContext, ...args: unknown[]) => Promise<T> | T;

export function registerIpc(deps: IpcDeps): () => void {
  const { settings, session, api, presence, windows, mainWindow } = deps;
  const { capture, streaming, popout, updater, processAudio } = deps;
  const registered: IpcChannel[] = [];

  function handle<T>(channel: IpcChannel, handler: Handler<T>): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const window = windows.fromSender(event.sender);
      if (!window) {
        const denied: IpcResult<T> = { ok: false, message: 'Acesso negado.' };
        return denied;
      }
      try {
        const value = await handler({ sender: event.sender, window }, ...args);
        const result: IpcResult<T> = { ok: true, value };
        return result;
      } catch (err) {
        const failure: IpcResult<T> = { ok: false, message: userMessage(err) };
        if (err instanceof ProcessAudioError) failure.code = err.code;
        return failure;
      }
    });
    registered.push(channel);
  }

  // --- Session / settings / api ---------------------------------------------------
  handle(IPC.GET_SESSION, () => session.get());
  handle(IPC.LOGIN, (_ctx, serverUrl, key) =>
    session.login(expectString(serverUrl, 'serverUrl'), expectString(key, 'key')),
  );
  handle(IPC.LOGIN_DISCORD, (_ctx, serverUrl) =>
    session.loginWithDiscord(expectString(serverUrl, 'serverUrl')),
  );
  handle(IPC.LOGOUT, () => session.logout());
  handle(IPC.GET_SETTINGS, () => settings.get());
  // `settings.update` validates every field of the patch and throws on anything unexpected.
  handle(IPC.UPDATE_SETTINGS, (_ctx, patch) => settings.update(patch as Partial<Settings>));
  handle(IPC.GET_ROOMS, () => api.rooms());
  handle(IPC.REQUEST_TOKEN, (_ctx, room, purpose) =>
    api.token(expectRoomId(room), expectOptionalTokenPurpose(purpose)),
  );
  handle(IPC.GET_PRESENCE, () => presence.getState());

  // --- Window -----------------------------------------------------------------------
  handle(IPC.OPEN_EXTERNAL, async (_ctx, url) => {
    const target = expectString(url, 'url');
    if (!isHttpUrl(target)) throw new IpcValidationError('url');
    await shell.openExternal(target);
  });
  handle(IPC.SET_FULLSCREEN, (ctx, enabled) => {
    ctx.window.browserWindow.setFullScreen(expectBoolean(enabled, 'enabled'));
  });

  // --- Capture / streaming ------------------------------------------------------------
  handle(IPC.GET_CAPTURE_SOURCES, () => capture.getSources());
  handle(IPC.SELECT_CAPTURE_SOURCE, (_ctx, selection) => {
    capture.select(parseCaptureSelection(selection));
  });
  handle(IPC.SET_STREAMING_STATE, (_ctx, state) => {
    streaming.set(parseStreamingState(state));
  });
  handle(IPC.GET_STREAMING_STATE, () => streaming.get());

  // --- Pop-out ------------------------------------------------------------------------
  handle(IPC.OPEN_POPOUT, (_ctx, target) => popout.open(parsePopoutTarget(target)));
  handle(IPC.CLOSE_POPOUT, () => popout.close());
  handle(IPC.GET_POPOUT_TARGET, (ctx) =>
    ctx.window.kind === 'popout' ? popout.getTarget() : null,
  );
  handle(IPC.SET_ALWAYS_ON_TOP, (_ctx, enabled) => {
    popout.setAlwaysOnTop(expectBoolean(enabled, 'enabled'));
  });

  // --- Updates --------------------------------------------------------------------------
  handle(IPC.GET_UPDATE_STATUS, () => updater.getStatus());
  handle(IPC.CHECK_FOR_UPDATES, () => updater.check());
  handle(IPC.INSTALL_UPDATE, () => updater.install());

  // --- Process audio --------------------------------------------------------------------
  handle(IPC.PROCESS_AUDIO_SUPPORT, () => processAudio.support());
  handle(IPC.PROCESS_AUDIO_START, (ctx, sourceId) => processAudio.start(ctx.sender, sourceId));
  handle(IPC.PROCESS_AUDIO_STOP, () => processAudio.stop());

  // --- Fire-and-forget --------------------------------------------------------------------
  const onHide = (event: IpcMainEvent): void => {
    const window = windows.fromSender(event.sender);
    if (!window) return;
    if (window.kind === 'popout') popout.close();
    else mainWindow.hide();
  };
  ipcMain.on(IPC.HIDE_TO_TRAY, onHide);

  // --- Pushes to every window ---------------------------------------------------------------
  const subscriptions = [
    presence.onEvent((event) => windows.broadcast(EVENTS.PRESENCE_EVENT, event)),
    presence.onStatus((status) => windows.broadcast(EVENTS.PRESENCE_STATUS, status)),
    session.onChange((current) => windows.broadcast(EVENTS.SESSION_CHANGED, current)),
    settings.onChange((next) => windows.broadcast(EVENTS.SETTINGS_CHANGED, next)),
    streaming.onChange((state) => windows.broadcast(EVENTS.STREAMING_STATE, state)),
    updater.onStatus((status) => windows.broadcast(EVENTS.UPDATE_STATUS, status)),
  ];
  logger.info(`registered ${registered.length + 1} channels`);

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
    ipcMain.removeListener(IPC.HIDE_TO_TRAY, onHide);
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}
