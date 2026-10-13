import { useEffect, useRef } from 'react';

export interface Hotkeys {
  /** F11 */
  onToggleFullscreen?(): void;
  /** Esc */
  onEscape?(): void;
  /** M */
  onToggleMute?(): void;
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Keys pressed while typing in a field belong to the field. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return EDITABLE.has(target.tagName) || target.isContentEditable;
}

/** Window-level shortcuts for the stage (F11 fullscreen, Esc leaves it, M mutes). */
export function useHotkeys(hotkeys: Hotkeys, enabled = true): void {
  const latest = useRef(hotkeys);
  useEffect(() => {
    latest.current = hotkeys;
  }, [hotkeys]);

  useEffect(() => {
    if (!enabled) return;
    function handle(event: KeyboardEvent): void {
      if (event.repeat || event.defaultPrevented) return;
      if (event.key === 'F11') {
        event.preventDefault();
        latest.current.onToggleFullscreen?.();
        return;
      }
      if (event.key === 'Escape') {
        latest.current.onEscape?.();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'm' || event.key === 'M') {
        latest.current.onToggleMute?.();
      }
    }
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [enabled]);
}
