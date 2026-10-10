import type { ReactNode } from 'react';
import '../styles/app-shell.css';

interface AppShellProps {
  banner: ReactNode;
  sidebar: ReactNode;
  userPanel: ReactNode;
  header: ReactNode;
  footer: ReactNode;
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
        <main className="shell__stage">{children}</main>
        {footer}
      </div>
    </div>
  );
}
