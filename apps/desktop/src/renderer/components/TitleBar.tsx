import { useEffect, useState } from 'react';
import { concord } from '../lib/concord';
import '../styles/title-bar.css';

interface TitleBarProps {
  /** The current room's label; nothing is shown outside a room. */
  title: string | null;
}

/**
 * The main window's own title bar (the native frame is hidden): a drag region with the current
 * room's label centered and the right end left to the native minimize/maximize/close buttons
 * (Electron's `titleBarOverlay`). Not shown in fullscreen, where the stage takes the whole window.
 */
export function TitleBar({ title }: TitleBarProps) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => concord().onFullscreenChanged(setFullscreen), []);
  if (fullscreen) return null;
  return (
    <div className="title-bar">{title && <span className="title-bar__text">{title}</span>}</div>
  );
}
