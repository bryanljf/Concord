/**
 * What the client running this renderer can do (`window.concord.capabilities`): the desktop app
 * has everything Electron/Windows offers, the web client (`src/web`) only what a browser on a
 * phone can. The UI hides what is missing instead of calling it. Without the bridge (unit tests)
 * everything answers as the desktop app does, so the existing tests keep their meaning.
 */
import { identityFor, type TokenPurpose } from '@concord/shared';
import type { ClientCapabilities, ClientKind, ConcordApi } from '../../preload/api';

/** The desktop app's capabilities (`jamDownload` is only true on Windows there). */
export const DESKTOP_CAPABILITIES: ClientCapabilities = {
  screenShare: true,
  processAudio: true,
  camera: true,
  popout: true,
  pip: true,
  nativeVideoPip: false,
  tray: true,
  shortcut: true,
  updates: true,
  jamDownload: true,
  serverChoice: true,
  keyLogin: true,
};

/** The web client's capabilities (what the browser can do on its own). */
export const WEB_CAPABILITIES: ClientCapabilities = {
  screenShare: false,
  processAudio: false,
  camera: true,
  popout: false,
  pip: false,
  nativeVideoPip: true,
  tray: false,
  shortcut: false,
  updates: false,
  jamDownload: false,
  serverChoice: false,
  keyLogin: false,
};

function bridge(): ConcordApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.concord;
}

/** Which implementation backs the bridge ('desktop' without one, e.g. in tests). */
export function clientKind(): ClientKind {
  return bridge()?.client ?? 'desktop';
}

export function isWeb(): boolean {
  return clientKind() === 'web';
}

/** The bridge's capabilities, or the desktop's without a bridge. */
export function capabilities(): ClientCapabilities {
  return bridge()?.capabilities ?? DESKTOP_CAPABILITIES;
}

/** Purpose of the token the main window joins rooms with (`main` without a bridge). */
export function joinPurpose(): Extract<TokenPurpose, 'main' | 'web'> {
  return bridge()?.joinPurpose ?? 'main';
}

/**
 * The LiveKit identity this window joins with: the user id on the desktop, `<userId>~web` in
 * the browser. Use it wherever `user.id` is compared with participant identities, stream keys or
 * viewers; the user id itself stays for profile things (name, avatar, "pedida por você").
 */
export function selfIdentity(userId: string): string {
  return identityFor(userId, joinPurpose());
}

/**
 * Whether the output device of the streams' audio can be chosen here: the browser must support
 * `setSinkId` (Chromium and Firefox do; Safari on iOS does not, the phone decides).
 */
export function audioOutputSelectable(): boolean {
  if (typeof AudioContext === 'undefined') return false;
  // Not in every lib.dom yet; checked by hand.
  const prototype = AudioContext.prototype as unknown as { setSinkId?: unknown };
  return typeof prototype.setSinkId === 'function';
}
