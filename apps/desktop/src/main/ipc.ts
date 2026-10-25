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
import type { JamService } from './jam';
import { log } from './log';
import type { PipManager } from './pip';
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
  expectJamItemId,
  expectJamQuery,
  expectNickname,
  expectOptionalTokenPurpose,
  expectPipResizeCorner,
  expectRoomId,
  expectString,
  expectYouTubeVideoId,
  expectYouTubeVideoIds,
  IpcValidationError,
  parsePipTarget,
  UserFacingError,
} from './validation';
import type { MainWindow } from './window';
import type { WindowDrag } from './window-drag';
import { isHttpUrl, type AppWindow, type WindowKind, type WindowRegistry } from './windows';

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
  pip: PipManager;
  windowDrag: WindowDrag;
  updater: Updater;
  processAudio: ProcessAudioBridge;
  jam: JamService;
}

/** Who is calling: always a registered window (anything else is denied before the handler). */
export interface IpcContext {
  sender: WebContents;
  window: AppWindow;
}

/** Rejects calls from a window that has no business making them (e.g. PiP-only methods). */
function requireKind(context: IpcContext, ...kinds: WindowKind[]): void {
  if (!kinds.includes(context.window.kind)) throw new UserFacingError('Acesso negado.');
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
  const { capture, streaming, popout, pip, windowDrag, updater, processAudio } = deps;
  const { jam } = deps;
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
  handle(IPC.SET_NICKNAME, (_ctx, nickname) => session.setNickname(expectNickname(nickname)));
  handle(IPC.GET_SETTINGS, () => settings.get());
  // `settings.update` validates every field of the patch and throws on anything unexpected.
  handle(IPC.UPDATE_SETTINGS, (_ctx, patch) => settings.update(patch as Partial<Settings>));
  handle(IPC.GET_ROOMS, () => api.rooms());
  handle(IPC.GET_SERVER_INFO, () => api.server());
  handle(IPC.PING_SERVER, () => api.ping());
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
    const on = expectBoolean(enabled, 'enabled');
    // Native fullscreen would activate the non-focusable PiP; it has its own.
    if (ctx.window.kind === 'pip') pip.setFullscreen(on);
    else ctx.window.browserWindow.setFullScreen(on);
  });
  handle(IPC.START_WINDOW_DRAG, (ctx) => {
    requireKind(ctx, 'popout', 'pip');
    if (ctx.window.kind === 'pip') pip.startDrag();
    else windowDrag.start(ctx.window.browserWindow, { mode: 'reachable' });
  });
  handle(IPC.END_WINDOW_DRAG, (ctx) => {
    requireKind(ctx, 'popout', 'pip');
    windowDrag.end(ctx.window.browserWindow);
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
  handle(IPC.GET_ALWAYS_ON_TOP, () => popout.getAlwaysOnTop());
  handle(IPC.GET_POPOUT_STATE, () => popout.getState());
  handle(IPC.FOCUS_POPOUT, () => popout.focus());

  // --- Cameras' picture-in-picture ---------------------------------------------------------
  handle(IPC.OPEN_PIP, (ctx, target) => {
    requireKind(ctx, 'main');
    pip.open(parsePipTarget(target));
  });
  handle(IPC.UPDATE_PIP, (ctx, target) => {
    requireKind(ctx, 'main');
    pip.update(parsePipTarget(target));
  });
  handle(IPC.CLOSE_PIP, (ctx) => {
    requireKind(ctx, 'main', 'pip');
    pip.close();
  });
  handle(IPC.GET_PIP_STATE, (ctx) => {
    requireKind(ctx, 'main');
    return pip.getState();
  });
  handle(IPC.GET_PIP_TARGET, (ctx) => (ctx.window.kind === 'pip' ? pip.getTarget() : null));
  handle(IPC.SHOW_PIP_MENU, (ctx) => {
    requireKind(ctx, 'pip');
    pip.showMenu();
  });
  handle(IPC.START_PIP_RESIZE, (ctx, corner) => {
    requireKind(ctx, 'pip');
    pip.startResize(expectPipResizeCorner(corner));
  });
  handle(IPC.END_PIP_RESIZE, (ctx) => {
    requireKind(ctx, 'pip');
    pip.endResize();
  });
  handle(IPC.SET_PIP_FULLSCREEN, (ctx, enabled) => {
    requireKind(ctx, 'pip');
    pip.setFullscreen(expectBoolean(enabled, 'enabled'));
  });

  // --- Updates --------------------------------------------------------------------------
  handle(IPC.GET_UPDATE_STATUS, () => updater.getStatus());
  handle(IPC.CHECK_FOR_UPDATES, () => updater.check());
  handle(IPC.INSTALL_UPDATE, () => updater.install());

  // --- Process audio --------------------------------------------------------------------
  handle(IPC.PROCESS_AUDIO_SUPPORT, () => processAudio.support());
  handle(IPC.PROCESS_AUDIO_START, (ctx, target) => processAudio.start(ctx.sender, target));
  handle(IPC.PROCESS_AUDIO_STOP, (ctx, captureId) => processAudio.stop(ctx.sender, captureId));

  // --- Jam (reads from any window, changes from the main window only) -----------------------
  handle(IPC.GET_JAM, () => jam.getState());
  handle(IPC.GET_JAM_UPLOADS, () => jam.getUploads());
  handle(IPC.SEARCH_JAM, (ctx, query) => {
    requireKind(ctx, 'main');
    return jam.search(expectJamQuery(query));
  });
  // Fire and forget: the downloads go on in the background.
  handle(IPC.PREFETCH_JAM, (ctx, videoIds) => {
    requireKind(ctx, 'main');
    jam.prefetch(expectYouTubeVideoIds(videoIds));
  });
  handle(IPC.ADD_TO_JAM, (ctx, room, videoId) => {
    requireKind(ctx, 'main');
    return jam.add(expectRoomId(room), expectYouTubeVideoId(videoId));
  });
  handle(IPC.REMOVE_FROM_JAM, (ctx, room, itemId) => {
    requireKind(ctx, 'main');
    return jam.remove(expectRoomId(room), expectJamItemId(itemId));
  });
  handle(IPC.SKIP_JAM, (ctx, room, itemId) => {
    requireKind(ctx, 'main');
    return jam.skip(expectRoomId(room), expectJamItemId(itemId));
  });
  handle(IPC.PAUSE_JAM, (ctx, room) => {
    requireKind(ctx, 'main');
    return jam.pause(expectRoomId(room));
  });
  handle(IPC.RESUME_JAM, (ctx, room) => {
    requireKind(ctx, 'main');
    return jam.resume(expectRoomId(room));
  });

  // --- Fire-and-forget --------------------------------------------------------------------
  const onHide = (event: IpcMainEvent): void => {
    const window = windows.fromSender(event.sender);
    if (!window) return;
    if (window.kind === 'popout') popout.close();
    else if (window.kind === 'pip') pip.close();
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
    jam.onEvent((event) => windows.broadcast(EVENTS.JAM_EVENT, event)),
    jam.onUploadStatus((status) => windows.broadcast(EVENTS.JAM_UPLOAD_STATUS, status)),
  ];
  logger.info(`registered ${registered.length + 1} channels`);

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
    ipcMain.removeListener(IPC.HIDE_TO_TRAY, onHide);
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}
