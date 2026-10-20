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

/** How many unwatched streams of each kind the cards show. */
export interface LiveCardCounts {
  screens: number;
  cameras: number;
}

/**
 * Heading of the cards of the streams nobody chose to watch yet: "2 pessoas ao vivo em Sala 1"
 * with screen shares only, "1 câmera ligada em Sala 1" with webcams only, "2 transmissões ao
 * vivo e 1 câmera em Sala 1" with both.
 */
export function liveCardsTitle({ screens, cameras }: LiveCardCounts, room: RoomId): string {
  const label = roomLabel(room);
  if (cameras === 0) return `${pluralize(screens, 'pessoa', 'pessoas')} ao vivo em ${label}`;
  if (screens === 0) {
    return `${pluralize(cameras, 'câmera ligada', 'câmeras ligadas')} em ${label}`;
  }
  const lives = pluralize(screens, 'transmissão ao vivo', 'transmissões ao vivo');
  return `${lives} e ${pluralize(cameras, 'câmera', 'câmeras')} em ${label}`;
}
