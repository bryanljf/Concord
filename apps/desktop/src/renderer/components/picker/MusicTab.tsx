import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  MusicAppId,
  MusicAppStatus,
  NowPlaying,
  ProcessAudioSupport,
} from '../../../preload/api';
import type { MusicBroadcastState } from '../../hooks/useMusicBroadcast';
import { concord } from '../../lib/concord';
import { MUSIC_APP_LABELS } from '../../lib/music';
import { musicDuplicationWarning } from '../../lib/musicWarnings';
import { Marquee } from '../music/Marquee';
import { Spinner } from '../Spinner';
import { InfoIcon, MusicIcon, RefreshIcon, WarningIcon } from '../icons';

/** How long "Tentar de novo" shows that it is checking (main answers almost at once). */
const RETRY_FEEDBACK_MS = 800;

const STATE_LABELS: Record<NowPlaying['state'], string> = {
  playing: 'Tocando',
  paused: 'Pausado',
  stopped: 'Parado',
};

interface MusicTabProps {
  app: MusicAppId;
  /** Main's status of the app; null while asking. */
  status: MusicAppStatus | null;
  /** Per-process capture support (the music track needs it); null while asking. */
  support: ProcessAudioSupport | null;
  music: MusicBroadcastState;
  /** The screen share being broadcast also carries the app in its audio. */
  duplicates: boolean;
  /** "Tentar de novo": ask main again whether the app runs. */
  onRetry(): void;
}

/** Cover art of `artId` as a data URL (the previous one stays until the next arrives). */
function useMusicArt(artId: string | null): string | null {
  const [art, setArt] = useState<string | null>(null);
  useEffect(() => {
    if (!artId) return;
    let active = true;
    concord()
      .getMusicArt(artId)
      .then(
        (url) => {
          if (active) setArt(url);
        },
        () => {
          if (active) setArt(null);
        },
      );
    return () => {
      active = false;
    };
  }, [artId]);
  return artId ? art : null;
}

/**
 * "Música" tab of the source picker: the music app's card (cover, track, artist and state, or why
 * it cannot be broadcast). The action itself is the picker's footer button.
 */
export function MusicTab({ app, status, support, music, duplicates, onRetry }: MusicTabProps) {
  const label = MUSIC_APP_LABELS[app];
  const nowPlaying = status?.running ? status.nowPlaying : null;
  const art = useMusicArt(nowPlaying?.artId ?? null);
  const live = music.status === 'live' && music.app === app;

  const [checking, setChecking] = useState(false);
  const checkingTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const timer = checkingTimer;
    return () => window.clearTimeout(timer.current);
  }, []);
  function retry(): void {
    setChecking(true);
    onRetry();
    window.clearTimeout(checkingTimer.current);
    checkingTimer.current = window.setTimeout(() => setChecking(false), RETRY_FEEDBACK_MS);
  }

  let body: ReactNode;
  if (status === null) {
    body = (
      <span className="music-card__message" role="status">
        Procurando o {label}…
      </span>
    );
  } else if (!status.running) {
    body = (
      <div className="music-card__missing" role="alert">
        <span className="music-card__missing-text">
          <WarningIcon size={16} />
          Abra o {label} para transmitir música.
        </span>
        <button type="button" className="btn btn--sm" disabled={checking} onClick={retry}>
          {checking ? <Spinner size="sm" label="Verificando" /> : <RefreshIcon size={16} />}
          {checking ? 'Verificando…' : 'Tentar de novo'}
        </button>
      </div>
    );
  } else if (nowPlaying) {
    const title = nowPlaying.ad ? 'Anúncio' : nowPlaying.title || label;
    const artist = nowPlaying.ad ? '' : nowPlaying.artist;
    body = (
      <>
        <Marquee as="strong" className="music-card__title" text={title} />
        {artist && <Marquee className="music-card__artist" text={artist} />}
        <span
          className={
            nowPlaying.state === 'playing'
              ? 'music-card__state music-card__state--playing'
              : 'music-card__state'
          }
        >
          {STATE_LABELS[nowPlaying.state]}
        </span>
      </>
    );
  } else {
    body = <span className="music-card__message">Dê play no {label} para mostrar a música.</span>;
  }

  return (
    <div className="music-tab">
      <p className="music-tab__notice" role="note">
        <InfoIcon size={16} />
        Por enquanto, só o {label}.
      </p>

      <div className={live ? 'music-card music-card--live' : 'music-card'}>
        <span className="music-card__art">
          {art ? <img src={art} alt="" draggable={false} /> : <MusicIcon size={32} />}
        </span>
        <div className="music-card__body">
          <span className="music-card__app">
            {label}
            {live && <span className="music-card__live">Transmitindo música</span>}
          </span>
          {body}
        </div>
      </div>

      {status?.running && nowPlaying === null && (
        <p className="music-tab__hint">
          Se a música não aparecer, ative no {label}: Configurações → Exibir sobreposição na área de
          trabalho ao usar as teclas de mídia.
        </p>
      )}

      {support !== null && !support.supported && (
        <p className="picker__warning" role="note">
          <WarningIcon size={16} />
          {support.reason ?? 'A captura de áudio por aplicativo não está disponível neste PC.'}
        </p>
      )}

      {duplicates && (
        <p className="picker__warning" role="note">
          <WarningIcon size={16} />
          {musicDuplicationWarning(app)}
        </p>
      )}
    </div>
  );
}
