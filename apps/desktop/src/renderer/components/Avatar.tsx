import type { CSSProperties } from 'react';
import { hueFromString, initials } from '../lib/format';
import '../styles/avatar.css';

interface AvatarProps {
  id: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

/** Initials in a colored circle; the hue is derived from the user id so it stays stable. */
export function Avatar({ id, name, size = 'md' }: AvatarProps) {
  const style = { '--avatar-hue': hueFromString(id) } as CSSProperties;
  return (
    <span className={`avatar avatar--${size}`} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
