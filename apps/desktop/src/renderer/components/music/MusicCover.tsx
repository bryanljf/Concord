import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  MAX_VOLUME,
  MIN_VOLUME,
  VOLUME_STEP,
  volumeIconLevel,
  volumeLabel,
  type VolumeSetting,
} from '../../lib/volume';
import { MusicIcon, VolumeHighIcon, VolumeLowIcon, VolumeMutedIcon } from '../icons';
import { Equalizer } from './Equalizer';
import '../../styles/music.css';

export interface MusicCoverProps {
  artUrl: string | null;
  /** Equalizer over the cover: you are listening and it plays. */
  playing: boolean;
  listening: boolean;
  /** `md`: 56 px (players); `sm`: 40 px (search results, queue); `xs`: 32 px (compact rows). */
  size?: 'md' | 'sm' | 'xs';
  /** A link to another site (the Jam's covers): loaded lazily, without a referrer. */
  remote?: boolean;
}

const COVER_CLASSES = {
  md: 'music-cover',
  sm: 'music-cover music-cover--sm',
  xs: 'music-cover music-cover--xs',
} as const;

const COVER_ICON_SIZES = { md: 22, sm: 18, xs: 14 } as const;

/** Rounded cover thumbnail; a note on the theme's background until (or unless) it arrives. */
export function MusicCover({
  artUrl,
  playing,
  listening,
  size = 'md',
  remote = false,
}: MusicCoverProps) {
  // A cover that fails to decode falls back to the placeholder.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = artUrl && artUrl !== failedUrl ? artUrl : null;
  return (
    <span className={COVER_CLASSES[size]} aria-hidden="true">
      {url ? (
        <img
          key={url}
          className="music-cover__img"
          src={url}
          alt=""
          draggable={false}
          loading={remote ? 'lazy' : undefined}
          decoding={remote ? 'async' : undefined}
          referrerPolicy={remote ? 'no-referrer' : undefined}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <MusicIcon size={COVER_ICON_SIZES[size]} />
      )}
      {listening && (
        <span className="music-cover__eq">
          <Equalizer paused={!playing} />
        </span>
      )}
    </span>
  );
}

export interface MusicVolumeProps {
  setting: VolumeSetting;
  /** Whose music, for the accessible labels ("de Ana", "da Jam"). */
  who: string;
  /** "de" (a person's music, the default) or "da" (a música da Jam). */
  of?: 'de' | 'da';
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
export function MusicVolume({ setting, who, of = 'de', onVolume, onToggleMute }: MusicVolumeProps) {
  const label = volumeLabel(setting);
  const value = setting.muted ? 0 : setting.volume;
  const style = { '--music-volume': `${value}%` } as CSSProperties;
  const muteLabel = setting.muted
    ? `Ativar o som da música ${of} ${who}`
    : `Silenciar a música ${of} ${who}`;
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
        aria-label={`Volume da música ${of} ${who}`}
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
