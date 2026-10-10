import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresenceSnapshot, RoomId } from '@concord/shared';
import { mergeRoomIds } from '../lib/presence';
import { concord, type PresenceConnectionStatus } from '../lib/concord';

/**
 * Rooms configured on the server (`GET /api/rooms`), merged with any room seen in presence.
 * Re-fetched whenever the presence connection (re)connects, since the first attempt may have
 * happened while the server was unreachable.
 */
export function useRooms(snapshot: PresenceSnapshot, status: PresenceConnectionStatus): RoomId[] {
  const [fetched, setFetched] = useState<RoomId[]>([]);
  const attempted = useRef(false);
  const connected = status.state === 'connected';

  useEffect(() => {
    if (!connected && attempted.current) return;
    attempted.current = true;
    let active = true;
    concord()
      .getRooms()
      .then(
        (rooms) => {
          if (active) setFetched(rooms);
        },
        () => {
          // Fall back to the rooms present in the snapshot.
        },
      );
    return () => {
      active = false;
    };
  }, [connected]);

  return useMemo(() => mergeRoomIds(fetched, snapshot), [fetched, snapshot]);
}
