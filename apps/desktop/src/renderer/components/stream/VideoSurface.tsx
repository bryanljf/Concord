import { useEffect, useRef } from 'react';
import type { RemoteVideoTrack } from 'livekit-client';
import { capabilities } from '../../lib/capabilities';

interface VideoSurfaceProps {
  track: RemoteVideoTrack | null;
  className?: string;
  onDoubleClick?(): void;
}

/**
 * The <video> a remote screen share plays in. `track.attach()` is required (not just
 * `srcObject`): with adaptive stream livekit watches this element's size and visibility to
 * pick the simulcast layer and to pause the subscription while it is hidden. The browser's own
 * picture-in-picture stays off except where it is the client's PiP (`lib/nativePip.ts`).
 */
export function VideoSurface({ track, className, onDoubleClick }: VideoSurfaceProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return (
    <video
      ref={ref}
      className={className}
      muted
      autoPlay
      playsInline
      disablePictureInPicture={!capabilities().nativeVideoPip}
      onDoubleClick={onDoubleClick}
    />
  );
}
