import type { ReactNode } from 'react';
import '../styles/app-shell.css';

interface AppShellProps {
  banner: ReactNode;
  sidebar: ReactNode;
  userPanel: ReactNode;
  header: ReactNode;
  footer: ReactNode;
  /**
   * Drawn over the stage whatever it shows (the music drawer): positioned against the stage's
   * top-left corner and clipped by it, so it can slide out from under the sidebar.
   */
  stageOverlay?: ReactNode;
  /** Fullscreen: only the stage stays visible (the chrome is hidden, not unmounted). */
  immersive?: boolean;
  children: ReactNode;
}

/** Discord-like frame: 240 px sidebar with the user panel at the bottom; header/stage/bottom bar. */
export function AppShell({
  banner,
  sidebar,
  userPanel,
  header,
  footer,
  stageOverlay,
  immersive = false,
  children,
}: AppShellProps) {
  return (
    <div className={immersive ? 'shell shell--immersive' : 'shell'}>
      <div className="shell__banner">{banner}</div>
      <aside className="shell__sidebar">
        <div className="shell__sidebar-body">{sidebar}</div>
        {userPanel}
      </aside>
      <div className="shell__main">
        {header}
        <main className="shell__stage">
          {children}
          {stageOverlay}
        </main>
        {footer}
      </div>
    </div>
  );
}
