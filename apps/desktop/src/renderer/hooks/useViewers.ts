import { useEffect, useState } from 'react';
import { isAuxiliaryIdentity } from '@concord/shared';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';
import {
  collectViewers,
  encodeWatching,
  NO_VIEWERS,
  WATCHING_ATTRIBUTE,
  type ViewersByLive,
  type WatchingParticipant,
} from '../lib/viewers';

const VIEWER_EVENTS = [
  RoomEvent.ConnectionStateChanged,
  RoomEvent.Connected,
  RoomEvent.Reconnected,
  RoomEvent.Disconnected,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantAttributesChanged,
] as const;

function snapshot(room: Room): ViewersByLive {
  const participants: WatchingParticipant[] = [];
  for (const participant of room.remoteParticipants.values()) {
    if (!isAuxiliaryIdentity(participant.identity)) participants.push(participant);
  }
  participants.push(room.localParticipant);
  return collectViewers(participants);
}

/**
 * Who watches each live in `room`, from everyone's `WATCHING_ATTRIBUTE` (yours included).
 * Empty while disconnected.
 */
export function useViewers(room: Room): ViewersByLive {
  const [viewers, setViewers] = useState<ViewersByLive>(NO_VIEWERS);

  useEffect(() => {
    const refresh = (): void => {
      // Your own attribute outlives a disconnect on the local object; nobody watches then.
      setViewers(room.state === ConnectionState.Disconnected ? NO_VIEWERS : snapshot(room));
    };
    for (const event of VIEWER_EVENTS) room.on(event, refresh);
    const catchUp = window.setTimeout(refresh, 0);
    return () => {
      window.clearTimeout(catchUp);
      for (const event of VIEWER_EVENTS) room.off(event, refresh);
    };
  }, [room]);

  return viewers;
}

/**
 * Publishes the lives this window watches so the others can list you as a viewer. Re-sent after
 * every (re)connection. A server that does not grant `canUpdateOwnMetadata` yet only means the
 * list stays empty: the failure is ignored and retried on the next change.
 */
export function usePublishWatching(
  room: Room,
  connected: boolean,
  watchedIds: readonly string[],
): void {
  useEffect(() => {
    if (!connected) return;
    const value = encodeWatching(watchedIds);
    if (room.localParticipant.attributes[WATCHING_ATTRIBUTE] === value) return;
    room.localParticipant.setAttributes({ [WATCHING_ATTRIBUTE]: value }).catch(() => undefined);
  }, [room, connected, watchedIds]);
}
