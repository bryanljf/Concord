import { jamIndicatorSummary } from '../../lib/jam';
import { HeadphonesIcon } from '../icons';
import { Equalizer } from './Equalizer';
import '../../styles/music.css';

interface MusicButtonProps {
  /** The room's Jam ("Jam: Get Lucky — Daft Punk"). */
  jamLabel: string;
  /** A song is playing (not paused): the bars bounce; frozen otherwise. */
  playing: boolean;
  /** You listen to it. */
  listening: boolean;
  open: boolean;
  onToggle(): void;
}

/**
 * In a room's row, left of its people count, while the room has a Jam: the headphones with the
 * playing bars (no counter), opening and closing the music drawer.
 */
export function MusicButton({ jamLabel, playing, listening, open, onToggle }: MusicButtonProps) {
  const summary = jamIndicatorSummary(jamLabel, listening);
  const className = [
    'music-button',
    open ? 'music-button--open' : '',
    listening ? 'music-button--listening' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={className}
      aria-expanded={open}
      aria-controls="music-drawer"
      aria-label={open ? `${summary}. Fechar o painel de música` : `${summary}. Abrir o painel`}
      title={summary}
      onClick={onToggle}
    >
      <HeadphonesIcon size={16} />
      <Equalizer paused={!playing} />
    </button>
  );
}
