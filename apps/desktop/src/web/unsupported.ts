/**
 * What the web client cannot do: everything that needs Electron or Windows (screen share,
 * process audio, tray, shortcut, pop-out, PiP window, updates, yt-dlp). The renderer hides those
 * features through `capabilities`; should it still call one, the rejection carries this envelope
 * so `toErrorMessage` / `errorCode` show something sensible.
 */
export const UNSUPPORTED_MESSAGE = 'Indisponível na versão web.';

export class UnsupportedError extends Error {
  override readonly name = 'UnsupportedError';
  readonly code = 'unsupported';
  constructor(message = UNSUPPORTED_MESSAGE) {
    super(message);
  }
}

/** A bridge method the web does not implement: always rejects (any signature). */
export function unsupported(): Promise<never> {
  return Promise.reject(new UnsupportedError());
}

/** An event the web never emits: the subscription is a no-op with a no-op unsubscribe. */
export function noSubscription(): () => void {
  return () => undefined;
}
