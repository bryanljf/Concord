import { pluralize } from '../../lib/format';
import { HeadphonesIcon } from '../icons';
import { Equalizer } from './Equalizer';
import '../../styles/music.css';

interface MusicButtonProps {
  /** Music broadcasts in this room (presence), yours included. */
  count: number;
  /** How many of them you are listening to. */
  listening: number;
  open: boolean;
  onToggle(): void;
}

/**
 * In a room's row, left of its people count: opens and closes the music drawer. Only rendered for
 * a room where someone broadcasts music; a small equalizer bounces while you listen to it.
 */
export function MusicButton({ count, listening, open, onToggle }: MusicButtonProps) {
  const summary = `Música: ${pluralize(count, 'transmissão', 'transmissões')}${
    listening > 0 ? `, ouvindo ${listening}` : ''
  }`;
  const className = [
    'music-button',
    open ? 'music-button--open' : '',
    listening > 0 ? 'music-button--listening' : '',
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
      {listening > 0 && <Equalizer />}
      <span className="music-button__count" aria-hidden="true">
        {count}
      </span>
    </button>
  );
}
