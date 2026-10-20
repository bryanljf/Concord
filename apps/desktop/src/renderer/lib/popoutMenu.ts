/**
 * Items of the right-click menu in the pop-out window. Pure so it can be unit-tested;
 * `components/popout/PopoutView.tsx` maps each action to the window's controls.
 */

export type PopoutMenuAction = 'mute' | 'unmute' | 'stats' | 'return' | 'close';

export interface PopoutMenuItem {
  action: PopoutMenuAction;
  /** pt-BR label shown in the menu. */
  label: string;
  /** Destructive look (red on hover). */
  danger?: boolean;
  /** Draws a divider above the item. */
  separatorBefore?: boolean;
}

export interface PopoutMenuOptions {
  /** The live is muted in this window. */
  muted: boolean;
  /** The live carries audio (a screen shared without sound has nothing to mute). */
  hasAudio: boolean;
}

/**
 * Silenciar / Ativar som (only with audio), the stats panel toggle, "Voltar para a janela
 * principal", and "Fechar" last, below a divider, like other destructive actions.
 */
export function popoutMenuItems({ muted, hasAudio }: PopoutMenuOptions): PopoutMenuItem[] {
  const items: PopoutMenuItem[] = [];
  if (hasAudio) {
    items.push(
      muted ? { action: 'unmute', label: 'Ativar som' } : { action: 'mute', label: 'Silenciar' },
    );
  }
  items.push(
    { action: 'stats', label: 'Estatísticas da transmissão' },
    { action: 'return', label: 'Voltar para a janela principal' },
    { action: 'close', label: 'Fechar', danger: true, separatorBefore: true },
  );
  return items;
}
