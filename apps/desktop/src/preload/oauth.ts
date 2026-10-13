/**
 * Preload of the Discord login window only (src/main/discord-auth.ts).
 *
 * Discord's login page offers passkeys through WebAuthn. On Windows Electron hands every
 * `navigator.credentials` request to the OS, which pops the "Segurança do Windows — insira sua
 * chave de segurança" dialog over the login. Concord only needs Discord's regular login (e-mail,
 * password, QR code, authenticator codes), so WebAuthn is switched off in this window before any
 * page script runs: feature detection then reports passkeys as unavailable.
 */
import { contextBridge } from 'electron';

contextBridge.executeInMainWorld({
  func: () => {
    const unavailable = (): Promise<never> =>
      Promise.reject(new DOMException('Passkeys are disabled in this window.', 'NotAllowedError'));
    // Typed locally: this tsconfig targets Node and has no DOM lib.
    const scope = globalThis as unknown as {
      PublicKeyCredential?: unknown;
      navigator?: { credentials?: object };
    };
    try {
      delete scope.PublicKeyCredential;
    } catch {
      scope.PublicKeyCredential = undefined;
    }
    const credentials = scope.navigator?.credentials;
    if (credentials) {
      for (const method of ['get', 'create'] as const) {
        Object.defineProperty(credentials, method, { value: unavailable, configurable: true });
      }
    }
  },
});
