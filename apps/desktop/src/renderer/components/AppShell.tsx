import { useState, type ReactNode } from 'react';
import '../styles/app-shell.css';

interface AppShellProps {
  banner: ReactNode;
  /** The row above the sidebar ("CONCORD", or the logo when collapsed, and the toggle). */
  brand: ReactNode;
  sidebar: ReactNode;
  userPanel: ReactNode;
  header: ReactNode;
  footer: ReactNode;
  /**
   * Drawn over the stage whatever it shows (the music drawer): positioned against the stage's
   * top-left corner and clipped by it, so it can slide out from under the sidebar.
   */
  stageOverlay?: ReactNode;
  /**
   * The sidebar, brand row included, is a narrow column (the logo, room icons), and the stage
   * takes the room it leaves. Undefined while the setting loads (drawn expanded); only later
   * changes animate, not the saved value arriving.
   */
  sidebarCollapsed?: boolean;
  /** Fullscreen: only the stage stays visible (the chrome is hidden, not unmounted). */
  immersive?: boolean;
  children: ReactNode;
}

/**
 * Discord-like frame: 240 px sidebar (76 px when collapsed) with the user panel at the bottom;
 * header/stage/bottom bar.
 */
export function AppShell({
  banner,
  brand,
  sidebar,
  userPanel,
  header,
  footer,
  stageOverlay,
  sidebarCollapsed,
  immersive = false,
  children,
}: AppShellProps) {
  const [knownCollapsed, setKnownCollapsed] = useState(sidebarCollapsed);
  const [animated, setAnimated] = useState(false);
  if (knownCollapsed !== sidebarCollapsed) {
    setKnownCollapsed(sidebarCollapsed);
    if (knownCollapsed !== undefined) setAnimated(true);
  }
  const className = [
    'shell',
    sidebarCollapsed ? 'shell--sidebar-collapsed' : '',
    animated ? 'shell--sidebar-animated' : '',
    immersive ? 'shell--immersive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <div className="shell__banner">{banner}</div>
      <div className="shell__brand">{brand}</div>
      <aside className="shell__sidebar">
        <div className="shell__sidebar-body">{sidebar}</div>
        {userPanel}
      </aside>
      <div className="shell__header">{header}</div>
      <div className="shell__main">
        <main className="shell__stage">
          {children}
          {stageOverlay}
        </main>
        {footer}
      </div>
    </div>
  );
}
