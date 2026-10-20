import { useState, type CSSProperties, type ReactNode } from 'react';
import type { MusicAppId, NowPlaying } from '../../../preload/api';
import { MUSIC_APP_LABELS } from '../../lib/music';
import {
  MAX_VOLUME,
  MIN_VOLUME,
  VOLUME_STEP,
  volumeIconLevel,
  volumeLabel,
  type VolumeSetting,
} from '../../lib/volume';
import { Avatar } from '../Avatar';
import { MusicIcon, VolumeHighIcon, VolumeLowIcon, VolumeMutedIcon } from '../icons';
import { Marquee } from './Marquee';
import { Equalizer } from './Equalizer';
import { MusicProgress } from './MusicProgress';
import '../../styles/music.css';

interface MusicCoverProps {
  artUrl: string | null;
  /** Equalizer over the cover: you are listening and it plays. */
  playing: boolean;
  listening: boolean;
}

/** Rounded cover thumbnail; a note on the theme's background until (or unless) it arrives. */
function MusicCover({ artUrl, playing, listening }: MusicCoverProps) {
  // A cover that fails to decode falls back to the placeholder.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = artUrl && artUrl !== failedUrl ? artUrl : null;
  return (
    <span className="music-cover" aria-hidden="true">
      {url ? (
        <img
          key={url}
          className="music-cover__img"
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <MusicIcon size={22} />
      )}
      {listening && (
        <span className="music-cover__eq">
          <Equalizer paused={!playing} />
        </span>
      )}
    </span>
  );
}

interface MusicVolumeProps {
  setting: VolumeSetting;
  /** Whose music, for the accessible labels. */
  who: string;
  onVolume(volume: number): void;
  onToggleMute(): void;
}

function volumeIcon(setting: VolumeSetting): ReactNode {
  switch (volumeIconLevel(setting)) {
    case 'muted':
      return <VolumeMutedIcon size={16} />;
    case 'low':
      return <VolumeLowIcon size={16} />;
    default:
      return <VolumeHighIcon size={16} />;
  }
}

/** 0–100 % in steps of 1 with the value shown, plus mute (the slider shows 0 while muted). */
function MusicVolume({ setting, who, onVolume, onToggleMute }: MusicVolumeProps) {
  const label = volumeLabel(setting);
  const value = setting.muted ? 0 : setting.volume;
  const style = { '--music-volume': `${value}%` } as CSSProperties;
  const muteLabel = setting.muted
    ? `Ativar o som da música de ${who}`
    : `Silenciar a música de ${who}`;
  return (
    <div className="music-volume">
      <button
        type="button"
        className="icon-btn music-volume__mute"
        aria-label={muteLabel}
        aria-pressed={setting.muted}
        title={setting.muted ? 'Ativar som' : 'Silenciar'}
        onClick={onToggleMute}
      >
        {volumeIcon(setting)}
      </button>
      <input
        type="range"
        className="range music-volume__range"
        min={MIN_VOLUME}
        max={MAX_VOLUME}
        step={VOLUME_STEP}
        value={value}
        style={style}
        aria-label={`Volume da música de ${who}`}
        aria-valuetext={label}
        title={label}
        onChange={(event) => onVolume(Number(event.target.value))}
      />
      <span className="music-volume__value" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

export interface MusicPlayerBarProps {
  /** The broadcaster ("Ana", or "Você" for your own music). */
  who: string;
  /** For the avatar next to the name. */
  personId: string;
  avatarUrl: string | null;
  app: MusicAppId;
  nowPlaying: NowPlaying | null;
  artUrl: string | null;
  /** You are listening: highlighted, equalizer on the cover and the volume row. */
  listening?: boolean;
  /** Shown instead of the title while there is nothing to show yet ("Iniciando…"). */
  placeholder?: string;
  /** Right side: "Ouvir" / "Parar de ouvir" / "Parar música". */
  actions: ReactNode;
  /** Present while listening (remote music only). */
  volume?: Omit<MusicVolumeProps, 'who'> | null;
  /** Extra line under the bar ("Ouvindo: 2" for your own music). */
  footer?: ReactNode;
}

/**
 * One music broadcast, Spotify style in Concord's colors: cover thumbnail, title (bold) and
 * artist (muted), who broadcasts it from which app, the animated progress bar and, while you
 * listen, the volume.
 */
export function MusicPlayerBar({
  who,
  personId,
  avatarUrl,
  app,
  nowPlaying,
  artUrl,
  listening = false,
  placeholder,
  actions,
  volume = null,
  footer,
}: MusicPlayerBarProps) {
  const appLabel = MUSIC_APP_LABELS[app];
  let title: string;
  let artist: string;
  if (!nowPlaying) {
    title = placeholder ?? 'Nada tocando';
    artist = placeholder ? '' : `Aguardando o ${appLabel}`;
  } else if (nowPlaying.ad) {
    title = 'Anúncio';
    artist = appLabel;
  } else {
    title = nowPlaying.title || 'Sem título';
    artist = nowPlaying.artist || nowPlaying.album;
  }
  const paused = nowPlaying !== null && nowPlaying.state !== 'playing';
  const playing = nowPlaying?.state === 'playing';
  return (
    <article
      className={listening ? 'music-player music-player--listening' : 'music-player'}
      aria-label={`Música de ${who}`}
    >
      <div className="music-player__main">
        <MusicCover artUrl={artUrl} playing={playing} listening={listening} />
        <div className="music-player__text">
          <Marquee as="p" className="music-player__title" text={title} />
          {artist && <Marquee as="p" className="music-player__artist" text={artist} />}
          <p className="music-player__source">
            <Avatar id={personId} name={who} src={avatarUrl} size="xs" />
            <span className="music-player__who">{who}</span>
            <span aria-hidden="true">·</span>
            <span>{appLabel}</span>
            {paused && <span className="music-player__paused">Pausado</span>}
          </p>
        </div>
        <div className="music-player__actions">{actions}</div>
      </div>
      {nowPlaying && <MusicProgress nowPlaying={nowPlaying} />}
      {volume && <MusicVolume who={who} {...volume} />}
      {footer}
    </article>
  );
}
