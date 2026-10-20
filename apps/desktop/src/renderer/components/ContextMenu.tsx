import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition, nextMenuIndex, type Point } from '../lib/contextMenu';
import { CheckIcon } from './icons';
import '../styles/context-menu.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Destructive look (red on hover/focus). */
  danger?: boolean;
  /** Draws a divider above the item. */
  separatorBefore?: boolean;
  /** Radio-style item (e.g. the chosen camera): shows a check mark when true. */
  checked?: boolean;
  onSelect(): void;
}

interface ContextMenuProps {
  /** Viewport coordinates it opens at; moved as needed to stay inside the window. */
  point: Point;
  /** Accessible name of the menu (pt-BR), e.g. "Opções da transmissão de Ana". */
  label: string;
  items: readonly ContextMenuItem[];
  /** Esc, Tab, click outside, window blur/resize, or after an item was chosen. */
  onClose(): void;
}

/**
 * Discord-style context menu rendered in a portal (never the native one): opens at `point`
 * clamped to the viewport, focuses its first item, arrow keys/Home/End move between items,
 * Enter/Space activate, Esc/Tab/outside click close. Focus return is up to the owner
 * (`useContextMenu` gives it back to the element that opened the menu).
 */
const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"]';

export function ContextMenu({ point, label, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Point | null>(null);
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  }, [onClose]);

  // Measure once rendered (hidden), then place it inside the viewport.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition(
      clampMenuPosition(
        point,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [point]);

  // First item gets the focus as soon as the menu is visible.
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    ref.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const close = (): void => latestClose.current();
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Keys inside the menu belong to it (window hotkeys skip prevented events).
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    const menuItems = Array.from(ref.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []);
    const current = menuItems.findIndex((item) => item === document.activeElement);
    if (event.key === 'Enter' || event.key === ' ') {
      // Activate here rather than relying on the button's native keyboard click.
      event.preventDefault();
      menuItems[current]?.click();
      return;
    }
    const next = nextMenuIndex(current, menuItems.length, event.key);
    if (next !== null) {
      event.preventDefault();
      menuItems[next]?.focus();
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      style={{
        left: position?.x ?? point.x,
        top: position?.y ?? point.y,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.separatorBefore && <div className="context-menu__separator" role="separator" />}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            tabIndex={-1}
            className={
              item.danger ? 'context-menu__item context-menu__item--danger' : 'context-menu__item'
            }
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="context-menu__label">{item.label}</span>
            {item.checked ? (
              <span className="context-menu__icon" aria-hidden="true">
                <CheckIcon size={16} />
              </span>
            ) : (
              item.icon && (
                <span className="context-menu__icon" aria-hidden="true">
                  {item.icon}
                </span>
              )
            )}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
