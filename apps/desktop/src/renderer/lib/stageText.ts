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
  /** The room's Jam has a card too; false when omitted. */
  jam?: boolean;
}

/**
 * Heading of the cards of the streams nobody chose to watch yet: "2 pessoas ao vivo em Sala 1"
 * with screen shares only, "1 câmera ligada em Sala 1" with webcams only, "2 transmissões ao
 * vivo e 1 câmera em Sala 1" with both, "Jam tocando em Sala 1" with only the Jam.
 */
export function liveCardsTitle(
  { screens, cameras, jam = false }: LiveCardCounts,
  room: RoomId,
): string {
  const label = roomLabel(room);
  if (!jam && cameras === 0) {
    return `${pluralize(screens, 'pessoa', 'pessoas')} ao vivo em ${label}`;
  }
  if (!jam && screens === 0) {
    return `${pluralize(cameras, 'câmera ligada', 'câmeras ligadas')} em ${label}`;
  }
  if (jam && screens === 0 && cameras === 0) return `Jam tocando em ${label}`;
  const parts = [
    screens > 0 ? pluralize(screens, 'transmissão ao vivo', 'transmissões ao vivo') : null,
    cameras > 0 ? pluralize(cameras, 'câmera', 'câmeras') : null,
    jam ? 'a Jam' : null,
  ].filter((part): part is string => part !== null);
  const last = parts.pop();
  return `${parts.join(', ')} e ${last} em ${label}`;
}
