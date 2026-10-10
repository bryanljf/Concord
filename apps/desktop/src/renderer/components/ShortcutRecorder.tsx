import { useState, type KeyboardEvent } from 'react';
import { isModifierKey, keyEventToAccelerator, modifierTokens } from '../lib/accelerator';
import { DEFAULT_SHORTCUT } from '../lib/constants';
import { formatShortcut } from '../lib/format';
import '../styles/shortcut-recorder.css';

interface ShortcutRecorderProps {
  id?: string;
  value: string;
  platform: string;
  onChange(accelerator: string): void;
}

/**
 * A focusable box that records the next key chord and reports it as an Electron accelerator.
 * Click (or Enter/Space) starts recording; Esc or blur cancels.
 */
export function ShortcutRecorder({ id, value, platform, onChange }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [heldModifiers, setHeldModifiers] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  function start() {
    setRecording(true);
    setHeldModifiers(null);
    setHint(null);
  }

  function stop() {
    setRecording(false);
    setHeldModifiers(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!recording) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        start();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      stop();
      return;
    }
    if (isModifierKey(event.key)) {
      setHeldModifiers(formatShortcut(modifierTokens(event, platform).join('+'), platform));
      return;
    }
    const accelerator = keyEventToAccelerator(event, platform);
    if (!accelerator) {
      setHint('Combine a tecla com Ctrl, Alt ou Win (teclas F podem ficar sozinhas).');
      return;
    }
    onChange(accelerator);
    stop();
  }

  function handleKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (!recording) return;
    event.preventDefault();
    const tokens = modifierTokens(event, platform);
    setHeldModifiers(tokens.length > 0 ? formatShortcut(tokens.join('+'), platform) : null);
  }

  const display = recording
    ? heldModifiers
      ? `${heldModifiers}+…`
      : 'Pressione a combinação…'
    : formatShortcut(value, platform);

  return (
    <div className="recorder">
      <div className="recorder__row">
        <button
          type="button"
          id={id}
          className={recording ? 'recorder__box recorder__box--recording' : 'recorder__box'}
          aria-pressed={recording}
          aria-label={
            recording
              ? 'Gravando atalho — Esc cancela'
              : `Atalho atual: ${display}. Clique para alterar`
          }
          onClick={recording ? undefined : start}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={stop}
        >
          <span className="recorder__value">{display}</span>
          <span className="recorder__tip">{recording ? 'Esc cancela' : 'Clique para alterar'}</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={value === DEFAULT_SHORTCUT}
          onClick={() => onChange(DEFAULT_SHORTCUT)}
        >
          Restaurar padrão
        </button>
      </div>
      {hint && (
        <p className="recorder__hint" role="alert">
          {hint}
        </p>
      )}
    </div>
  );
}
