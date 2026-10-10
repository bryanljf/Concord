import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { ROOM_ID_PATTERN } from '@telao/shared';
import type { Settings } from '../preload/api';
import { EVENTS, IPC, type IpcChannel, type IpcResult } from '../preload/channels';
import type { ApiClient } from './api-client';
import { ApiClientError } from './api-client';
import { log } from './log';
import type { PresenceClient } from './presence-client';
import type { SessionManager } from './session';
import { SettingsValidationError, type SettingsStore } from './settings';
import { isHttpUrl, type MainWindow } from './window';

const logger = log('ipc');

export interface IpcDeps {
  settings: SettingsStore;
  session: SessionManager;
  api: ApiClient;
  presence: PresenceClient;
  window: MainWindow;
}

/** Input from the renderer that fails shape validation. */
export class IpcValidationError extends Error {
  override readonly name = 'IpcValidationError';
  constructor(parameter: string) {
    super(`Parâmetro inválido: ${parameter}.`);
  }
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new IpcValidationError(name);
  return value;
}

function expectRoomId(value: unknown): string {
  const room = expectString(value, 'room');
  if (!ROOM_ID_PATTERN.test(room)) throw new IpcValidationError('room');
  return room;
}

/** Turns any thrown value into a message that is safe to show in the UI. */
function userMessage(err: unknown): string {
  if (
    err instanceof ApiClientError ||
    err instanceof SettingsValidationError ||
    err instanceof IpcValidationError
  ) {
    return err.message;
  }
  logger.error('unexpected error in IPC handler', err);
  return 'Erro inesperado. Veja o log do aplicativo.';
}

type Handler<T> = (...args: unknown[]) => Promise<T> | T;

export function registerIpc(deps: IpcDeps): () => void {
  const { settings, session, api, presence, window } = deps;
  const registered: IpcChannel[] = [];

  function handle<T>(channel: IpcChannel, handler: Handler<T>): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!window.isTrustedSender(event.sender)) {
        const denied: IpcResult<T> = { ok: false, message: 'Acesso negado.' };
        return denied;
      }
      try {
        const result: IpcResult<T> = { ok: true, value: await handler(...args) };
        return result;
      } catch (err) {
        const failure: IpcResult<T> = { ok: false, message: userMessage(err) };
        return failure;
      }
    });
    registered.push(channel);
  }

  handle(IPC.GET_SESSION, () => session.get());
  handle(IPC.LOGIN, (serverUrl, key) =>
    session.login(expectString(serverUrl, 'serverUrl'), expectString(key, 'key')),
  );
  handle(IPC.LOGOUT, () => session.logout());
  handle(IPC.GET_SETTINGS, () => settings.get());
  // `settings.update` validates every field of the patch and throws on anything unexpected.
  handle(IPC.UPDATE_SETTINGS, (patch) => settings.update(patch as Partial<Settings>));
  handle(IPC.GET_ROOMS, () => api.rooms());
  handle(IPC.REQUEST_TOKEN, (room) => api.token(expectRoomId(room)));
  handle(IPC.GET_PRESENCE, () => presence.getState());
  handle(IPC.OPEN_EXTERNAL, async (url) => {
    const target = expectString(url, 'url');
    if (!isHttpUrl(target)) throw new IpcValidationError('url');
    await shell.openExternal(target);
  });

  const onHide = (event: IpcMainEvent): void => {
    if (window.isTrustedSender(event.sender)) window.hide();
  };
  ipcMain.on(IPC.HIDE_TO_TRAY, onHide);

  const unsubscribeEvent = presence.onEvent((event) => window.send(EVENTS.PRESENCE_EVENT, event));
  const unsubscribeStatus = presence.onStatus((status) =>
    window.send(EVENTS.PRESENCE_STATUS, status),
  );
  const unsubscribeSession = session.onChange((current) =>
    window.send(EVENTS.SESSION_CHANGED, current),
  );
  const unsubscribeSettings = settings.onChange((next) =>
    window.send(EVENTS.SETTINGS_CHANGED, next),
  );
  logger.info(`registered ${registered.length + 1} channels`);

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
    ipcMain.removeListener(IPC.HIDE_TO_TRAY, onHide);
    unsubscribeEvent();
    unsubscribeStatus();
    unsubscribeSession();
    unsubscribeSettings();
  };
}
