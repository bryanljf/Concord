import { roomLabel, type RoomId } from '@concord/shared';

/** First character of a word (a whole code point, so accents and emoji stay intact). */
function initial(word: string | undefined): string {
  return word === undefined ? '' : ([...word][0] ?? '');
}

/**
 * The text on a room's icon in the collapsed sidebar, from its label (`roomLabel`): a trailing
 * number follows the first letter ("sala-1" → "S1", "sala12" → "S12"); without one, the initials
 * of the first two words ("jogos_fds" → "JF") or the first two letters of a single word
 * ("lobby" → "LO"). Always upper case; "?" when nothing is left.
 */
export function roomShortLabel(room: RoomId): string {
  const label = roomLabel(room).trim();
  const number = /\d+$/.exec(label)?.[0] ?? '';
  const words = label
    .slice(0, label.length - number.length)
    .split(/\s+/)
    .filter(Boolean);
  let short: string;
  if (number !== '') short = initial(words[0]) + number;
  else if (words.length > 1) short = initial(words[0]) + initial(words[1]);
  else short = [...(words[0] ?? '')].slice(0, 2).join('');
  return short === '' ? '?' : short.toLocaleUpperCase('pt-BR');
}
