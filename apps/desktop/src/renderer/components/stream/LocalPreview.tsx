import { useEffect, useRef } from 'react';

interface LocalPreviewProps {
  /** The raw capture track being published. */
  track: MediaStreamTrack;
  className?: string;
  onDoubleClick?(): void;
}

/** Muted preview of what this instance is broadcasting. */
export function LocalPreview({ track, className, onDoubleClick }: LocalPreviewProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = new MediaStream([track]);
    element.play().catch(() => {
      // Autoplay of a muted local stream never needs a gesture in Electron.
    });
    return () => {
      element.srcObject = null;
    };
  }, [track]);

  return (
    <video
      ref={ref}
      className={className}
      muted
      autoPlay
      playsInline
      disablePictureInPicture
      onDoubleClick={onDoubleClick}
    />
  );
}
