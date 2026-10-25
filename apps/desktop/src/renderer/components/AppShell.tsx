import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useViewport } from '../hooks/useViewport';
import { CloseIcon } from './icons';
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

const DRAWER_ID = 'shell-drawer';
const OPEN_MENU_LABEL = 'Abrir o menu de salas';
const CLOSE_MENU_LABEL = 'Fechar o menu';

/**
 * Taps on these inside the drawer close it: a room or a live picked (`data-navitem`), a room's
 * music button (the music panel opens over the stage), the user panel's buttons (Settings opens
 * over everything).
 */
const CLOSES_DRAWER = '[data-navitem], .music-button, .user-panel button';

/** Three lines: the drawer's button on phones (`icons.tsx` has no hamburger). */
function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/**
 * Discord-like frame: 240 px sidebar (76 px when collapsed) with the user panel at the bottom;
 * header/stage/bottom bar. On a phone the sidebar (brand row and user panel included) is a drawer
 * over the stage, opened by the button at the header's left end and closed by its ×, the backdrop,
 * Esc or picking a room.
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
  const { phone } = useViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Back on a wide window the sidebar is a column again: nothing stays "open".
  if (!phone && drawerOpen) setDrawerOpen(false);
  const drawer = phone && drawerOpen && !immersive;
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const openDrawer = (): void => setDrawerOpen(true);
  const closeDrawer = (): void => setDrawerOpen(false);

  // Esc closes it (and only it: the window's Esc chain skips a handled event).
  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [drawer]);

  // The focus follows the drawer: its × when it opens, the menu button when it closes while the
  // focus was inside (the room just picked is inert now).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (drawer) {
      closeButton.current?.focus({ preventScroll: true });
    } else if (wasOpen.current) {
      const active = document.activeElement;
      const inside = active instanceof Node && document.getElementById(DRAWER_ID)?.contains(active);
      if (inside || !active || active === document.body) {
        menuButton.current?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = drawer;
  }, [drawer]);

  const onDrawerClick = (event: MouseEvent<HTMLElement>): void => {
    const target = event.target;
    if (target instanceof Element && target.closest(CLOSES_DRAWER)) closeDrawer();
  };

  const className = [
    'shell',
    sidebarCollapsed ? 'shell--sidebar-collapsed' : '',
    animated ? 'shell--sidebar-animated' : '',
    immersive ? 'shell--immersive' : '',
    phone ? 'shell--phone' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const sidebarClass = drawer ? 'shell__sidebar shell__sidebar--open' : 'shell__sidebar';

  return (
    <div className={className}>
      <div className="shell__banner">{banner}</div>
      {!phone && <div className="shell__brand">{brand}</div>}
      <aside
        id={DRAWER_ID}
        className={sidebarClass}
        aria-hidden={phone ? !drawer : undefined}
        inert={phone && !drawer}
        onClick={phone ? onDrawerClick : undefined}
      >
        {phone && (
          <div className="shell__brand shell__drawer-head">
            {brand}
            <button
              ref={closeButton}
              type="button"
              className="icon-btn shell__drawer-close"
              aria-label={CLOSE_MENU_LABEL}
              onClick={closeDrawer}
            >
              <CloseIcon size={20} />
            </button>
          </div>
        )}
        <div className="shell__sidebar-body">{sidebar}</div>
        {userPanel}
      </aside>
      <div className="shell__header">
        {phone && (
          <button
            ref={menuButton}
            type="button"
            className="icon-btn shell__menu"
            aria-label={OPEN_MENU_LABEL}
            aria-expanded={drawer}
            aria-controls={DRAWER_ID}
            onClick={openDrawer}
          >
            <MenuIcon />
          </button>
        )}
        {header}
      </div>
      <div className="shell__main">
        <main className="shell__stage">
          {children}
          {stageOverlay}
        </main>
        {footer}
      </div>
      {drawer && <div className="shell__backdrop" aria-hidden="true" onClick={closeDrawer} />}
    </div>
  );
}
