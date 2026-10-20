/**
 * Every video someone publishes has a stream key: the screen share keeps the bare participant id
 * (what v0.1.7 clients publish in `concord.watching`, what the pop-out and presence use), the
 * webcam is `<id>#camera`. User ids never contain `#` (`^[a-z0-9][a-z0-9_-]{1,31}$`).
 */

export type StreamKind = 'screen' | 'camera';

export const CAMERA_KEY_SUFFIX = '#camera';

export function streamKey(participantId: string, kind: StreamKind): string {
  return kind === 'camera' ? `${participantId}${CAMERA_KEY_SUFFIX}` : participantId;
}

export function cameraKey(participantId: string): string {
  return streamKey(participantId, 'camera');
}

export function isCameraKey(key: string): boolean {
  return key.endsWith(CAMERA_KEY_SUFFIX);
}

export function parseStreamKey(key: string): { participantId: string; kind: StreamKind } {
  return isCameraKey(key)
    ? { participantId: key.slice(0, -CAMERA_KEY_SUFFIX.length), kind: 'camera' }
    : { participantId: key, kind: 'screen' };
}
