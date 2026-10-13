import { BrowserWindow } from 'electron';
import { log } from './log';

const logger = log('discord-auth');

/** Runs the OAuth flow in an isolated, non-persistent Electron window. */
export function openDiscordLogin(serverUrl: string): Promise<string> {
  const auth = new BrowserWindow({
    width: 500,
    height: 720,
    title: 'Entrar com Discord — Concord',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // No "persist:" prefix: an in-memory session, so every login starts clean and nothing
      // (Discord cookies included) is left on disk.
      partition: `concord-oauth-${Date.now()}`,
    },
  });
  auth.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const callbackPath = '/api/auth/discord/callback';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, token?: string): void => {
      if (settled) return;
      settled = true;
      if (!auth.isDestroyed()) auth.destroy();
      if (error) reject(error);
      else if (token) resolve(token);
      else reject(new Error('Resposta inválida do login com Discord.'));
    };
    const timer = setTimeout(
      () => finish(new Error('O login com Discord demorou demais.')),
      5 * 60_000,
    );
    auth.webContents.on('did-finish-load', () => {
      if (!auth.webContents.getURL().includes(callbackPath)) return;
      void auth.webContents
        .executeJavaScript('document.body ? document.body.innerText : ""', true)
        .then((text: unknown) => {
          clearTimeout(timer);
          let value: unknown;
          try {
            value = JSON.parse(typeof text === 'string' ? text : '');
          } catch {
            finish(new Error('Resposta inválida do login com Discord.'));
            return;
          }
          if (!value || typeof value !== 'object') {
            finish(new Error('Resposta inválida do login com Discord.'));
            return;
          }
          const response = value as { token?: unknown; message?: unknown };
          if (typeof response.token !== 'string' || response.token.length < 20) {
            finish(
              new Error(
                typeof response.message === 'string'
                  ? response.message
                  : 'Não foi possível entrar com Discord.',
              ),
            );
            return;
          }
          finish(undefined, response.token);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          logger.warn('could not read OAuth callback', error);
          finish(new Error('Não foi possível concluir o login com Discord.'));
        });
    });
    auth.on('closed', () => {
      clearTimeout(timer);
      finish(new Error('Login com Discord cancelado.'));
    });
    void auth.loadURL(`${serverUrl}/api/auth/discord/login`).catch((error: unknown) => {
      clearTimeout(timer);
      finish(new Error('Não foi possível abrir o login com Discord.'));
      logger.warn('could not open OAuth login', error);
    });
  });
}
