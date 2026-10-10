/**
 * `desktopCapturer` source ids look like `window:<id>:<other>` or `screen:<n>:0`. On Windows the
 * window id is the HWND in decimal (Electron docs: "XX is the windowID/handle"; `HWND` on Windows).
 */
export type CaptureSourceRef =
  { kind: 'window'; handle: number } | { kind: 'screen'; index: number };

const SOURCE_ID_PATTERN = /^(window|screen):(\d{1,16}):(\d{1,16})$/;

export function parseCaptureSourceId(id: string): CaptureSourceRef | null {
  const match = SOURCE_ID_PATTERN.exec(id);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isSafeInteger(value)) return null;
  if (match[1] === 'window') return value > 0 ? { kind: 'window', handle: value } : null;
  return { kind: 'screen', index: value };
}
