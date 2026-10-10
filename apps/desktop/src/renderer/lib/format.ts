/** Human-readable label for an Electron accelerator modifier token, or null for non-modifiers. */
function modifierLabel(token: string, platform: string): string | null {
  const mac = platform === 'darwin';
  switch (token) {
    case 'CommandOrControl':
    case 'CmdOrCtrl':
      return mac ? 'Cmd' : 'Ctrl';
    case 'Command':
    case 'Cmd':
      return 'Cmd';
    case 'Control':
    case 'Ctrl':
      return 'Ctrl';
    case 'Super':
    case 'Meta':
      if (platform === 'win32') return 'Win';
      return mac ? 'Cmd' : 'Super';
    case 'Alt':
      return mac ? 'Option' : 'Alt';
    case 'Option':
    case 'AltGr':
    case 'Shift':
      return token;
    default:
      return null;
  }
}

const KEY_LABELS: Record<string, string> = {
  Plus: '+',
  Space: 'Espaço',
  Return: 'Enter',
  Enter: 'Enter',
  Escape: 'Esc',
  Esc: 'Esc',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Capslock: 'Caps Lock',
  Numlock: 'Num Lock',
  Scrolllock: 'Scroll Lock',
  PrintScreen: 'Print Screen',
  numadd: 'Num +',
  numsub: 'Num -',
  nummult: 'Num *',
  numdiv: 'Num /',
  numdec: 'Num .',
  VolumeUp: 'Volume +',
  VolumeDown: 'Volume -',
  VolumeMute: 'Mudo',
  MediaNextTrack: 'Próxima faixa',
  MediaPreviousTrack: 'Faixa anterior',
  MediaStop: 'Parar mídia',
  MediaPlayPause: 'Play/Pause',
};

function keyLabel(token: string): string {
  const numpad = /^num(\d)$/.exec(token);
  if (numpad) return `Num ${numpad[1]}`;
  return KEY_LABELS[token] ?? token;
}

/** Turns "CommandOrControl+Shift+L" into "Ctrl+Shift+L" (platform-aware). */
export function formatShortcut(accelerator: string, platform = 'win32'): string {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((token) => modifierLabel(token, platform) ?? keyLabel(token))
    .join('+');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "agora", "3 min", "2 h", "1 dia", "3 dias". */
export function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < MINUTE) return 'agora';
  if (elapsedMs < HOUR) return `${Math.floor(elapsedMs / MINUTE)} min`;
  if (elapsedMs < DAY) return `${Math.floor(elapsedMs / HOUR)} h`;
  const days = Math.floor(elapsedMs / DAY);
  return days === 1 ? '1 dia' : `${days} dias`;
}

/** "entrou agora" / "entrou há 3 min". */
export function formatJoinedAgo(joinedAt: number, now: number): string {
  const elapsed = formatElapsed(now - joinedAt);
  return elapsed === 'agora' ? 'entrou agora' : `entrou há ${elapsed}`;
}

/** Whole seconds with a 1 s floor: 4600 → "5 s". */
export function formatRetryIn(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} s`;
}

/** Up to two initials for an avatar ("Ana Beatriz" → "AB", "bryan" → "B", "" → "?"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
  const joined = letters.join('').toUpperCase();
  return joined.length > 0 ? joined : '?';
}

/** Deterministic hue (0–359) for avatar colors. */
export function hueFromString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

/** "1 pessoa" / "3 pessoas". */
export function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
