/** Structural subset of `KeyboardEvent` so the helpers stay testable without a DOM. */
export interface AcceleratorKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'FnLock',
  'CapsLock',
  'NumLock',
  'ScrollLock',
]);

/** True for keys that only modify other keys (`KeyboardEvent.key` values). */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/** Electron modifier tokens for the modifiers held in `event`, in a stable order. */
export function modifierTokens(event: AcceleratorKeyEvent, platform = 'win32'): string[] {
  const mac = platform === 'darwin';
  const tokens: string[] = [];
  if (event.ctrlKey) tokens.push(mac ? 'Control' : 'CommandOrControl');
  if (event.altKey) tokens.push('Alt');
  if (event.shiftKey) tokens.push('Shift');
  if (event.metaKey) tokens.push(mac ? 'CommandOrControl' : 'Super');
  return tokens;
}

/** `KeyboardEvent.code` → Electron key code, for codes that are not letters/digits/F-keys. */
const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause',
};

const PUNCTUATION = new Set([...'~!@#$%^&*()_-=[]{}\\|;:\'",.<>/?`']);

/** Electron key code for the non-modifier key of `event`, or null when it cannot be used. */
export function keyToken(event: AcceleratorKeyEvent): string | null {
  const { code, key } = event;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad?.[1]) return `num${numpad[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  const mapped = CODE_TO_KEY[code];
  if (mapped) return mapped;
  // Layout-dependent fallback for unknown codes.
  if (key.length === 1) {
    if (key === '+') return 'Plus';
    if (/^[a-z]$/i.test(key)) return key.toUpperCase();
    if (/^\d$/.test(key)) return key;
    if (PUNCTUATION.has(key)) return key;
  }
  return null;
}

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/**
 * Builds an Electron accelerator (e.g. "CommandOrControl+Shift+L") from a keydown event.
 * Returns null while only modifiers are held, for keys that cannot be bound, and for
 * chords without Ctrl/Alt/Win (function keys are the exception: "F9" alone is fine).
 */
export function keyEventToAccelerator(
  event: AcceleratorKeyEvent,
  platform = 'win32',
): string | null {
  if (isModifierKey(event.key)) return null;
  const key = keyToken(event);
  if (!key) return null;
  const hasStrongModifier = event.ctrlKey || event.altKey || event.metaKey;
  if (!hasStrongModifier && !FUNCTION_KEY.test(key)) return null;
  return [...modifierTokens(event, platform), key].join('+');
}
