import { useState, type CSSProperties } from 'react';
import { avatarImageSrc } from '../lib/avatar';
import { hueFromString, initials } from '../lib/format';
import '../styles/avatar.css';

interface AvatarProps {
  id: string;
  name: string;
  /** Discord avatar (cdn.discordapp.com); initials are shown when missing or when it fails. */
  src?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

/**
 * The Discord avatar in a circle, or the initials on a colored background (hue derived from the
 * user id so it stays stable) when there is no avatar or it cannot be loaded.
 */
export function Avatar({ id, name, src, size = 'md' }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const image = avatarImageSrc(src, failedSrc);
  const style = { '--avatar-hue': hueFromString(id) } as CSSProperties;
  return (
    <span
      className={image ? `avatar avatar--${size} avatar--image` : `avatar avatar--${size}`}
      style={style}
      aria-hidden="true"
    >
      {image ? (
        <img
          key={image}
          className="avatar__img"
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(image)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
