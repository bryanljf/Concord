import { roomLabel, type RoomId } from '@concord/shared';
import { pluralize } from './format';

/** pt-BR titles of the stage states, with the room's display name ("sala-1" → "Sala 1"). */
export function stageTitles(room: RoomId): {
  joining: string;
  failed: string;
  nobodyLive: string;
} {
  const label = roomLabel(room);
  return {
    joining: `Entrando em ${label}…`,
    failed: `Não foi possível entrar em ${label}`,
    nobodyLive: `Ninguém está transmitindo em ${label}`,
  };
}

/** Heading of the grid of lives nobody chose to watch yet, e.g. "2 pessoas ao vivo em Sala 1". */
export function liveCardsTitle(count: number, room: RoomId): string {
  return `${pluralize(count, 'pessoa', 'pessoas')} ao vivo em ${roomLabel(room)}`;
}
