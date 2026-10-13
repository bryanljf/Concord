import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { roomLabel } from '@concord/shared';
import type { PopoutTarget } from '../../../preload/api';
import { useHotkeys } from '../../hooks/useHotkeys';
import { usePresence } from '../../hooks/usePresence';
import { useRemoteStreams } from '../../hooks/useRemoteStreams';
import { useRoom } from '../../hooks/useRoom';
import { useSettings } from '../../hooks/useSettings';
import { useStreamAudio } from '../../hooks/useStreamAudio';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { concord, toErrorMessage } from '../../lib/concord';
import { presenceProfiles } from '../../lib/presence';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import { CloseIcon, HeadphonesIcon, MonitorOffIcon, PinIcon, WarningIcon } from '../icons';
import { QualityBars } from '../stream/QualityBars';
import { StreamStatus } from '../stream/StreamStatus';
import { VideoSurface } from '../stream/VideoSurface';
import { VolumeControl } from '../stream/VolumeControl';
import '../../styles/popout.css';

/**
 * The frameless pop-out window: its own subscribe-only livekit connection
 * (`requestToken(room, 'popout')`), one participant's screen share, draggable title bar,
 * "sempre no topo", volume/mute. Main re-targets it through `onNavigate`.
 */
export function PopoutView() {
  const [target, setTarget] = useState<PopoutTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const { settings } = useSettings();
  const { room, connectionState, error, audioPlayback, join, startAudio } = useRoom({
    purpose: 'popout',
  });
  const streams = useRemoteStreams(room);
  const focusedId = target?.participantId ?? null;
  useSubscriptions(streams, focusedId, connectionState === 'connected');
  const audio = useStreamAudio({
    room,
    connectionState,
    streams,
    outputDeviceId: settings?.audioOutputDeviceId ?? null,
  });
  // Presence follows nickname/avatar changes; LiveKit's name is fixed when the token is issued.
  const { snapshot } = usePresence();
  const profile = useMemo(
    () => (focusedId ? presenceProfiles(snapshot).get(focusedId) : undefined),
    [snapshot, focusedId],
  );
  const liveStream = streams.find((candidate) => candidate.participantId === focusedId) ?? null;
  const stream =
    liveStream && profile
      ? { ...liveStream, name: profile.name, avatarUrl: profile.avatarUrl }
      : liveStream;
  // In the room but not publishing = they stopped; absent = not (yet) in the room.
  const participantPresent =
    focusedId !== null && room.getParticipantByIdentity(focusedId) !== undefined;

  useEffect(() => {
    let active = true;
    concord()
      .getPopoutTarget()
      .then(
        (initial) => {
          if (!active) return;
          if (initial) setTarget(initial);
          else setTargetError('Nenhuma transmissão foi escolhida para esta janela.');
        },
        (err: unknown) => {
          if (active) setTargetError(toErrorMessage(err, 'Não foi possível abrir a transmissão.'));
        },
      );
    const unsubscribe = concord().onNavigate((next) => {
      if (next.participantId) {
        setTarget({ room: next.room, participantId: next.participantId });
        setTargetError(null);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const targetRoom = target?.room ?? null;
  const targetParticipant = target?.participantId ?? null;
  useEffect(() => {
    if (targetRoom && targetParticipant) void join(targetRoom, targetParticipant);
  }, [targetRoom, targetParticipant, join]);

  const name = stream?.name ?? profile?.name ?? targetParticipant ?? 'Concord';
  useEffect(() => {
    document.title = targetRoom ? `${name} — ${roomLabel(targetRoom)} — Concord` : 'Concord';
  }, [name, targetRoom]);

  const togglePin = useCallback(() => {
    const next = !alwaysOnTop;
    setAlwaysOnTopState(next);
    concord()
      .setAlwaysOnTop(next)
      .then(
        () => setPinError(null),
        (err: unknown) => {
          setAlwaysOnTopState(!next);
          setPinError(toErrorMessage(err, 'Não foi possível fixar a janela.'));
        },
      );
  }, [alwaysOnTop]);

  const close = useCallback(() => {
    concord()
      .closePopout()
      .catch(() => window.close());
  }, []);

  useHotkeys({
    onToggleMute: () => {
      if (focusedId) audio.toggleMute(focusedId);
    },
  });

  let body: ReactNode;
  if (targetError) {
    body = (
      <div className="popout__state popout__state--error" role="alert">
        <WarningIcon size={36} />
        <span>{targetError}</span>
      </div>
    );
  } else if (!target) {
    body = (
      <div className="popout__state" role="status">
        <Spinner label="Carregando" />
      </div>
    );
  } else if (error) {
    body = (
      <div className="popout__state popout__state--error" role="alert">
        <WarningIcon size={36} />
        <span>{error}</span>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => void join(target.room, target.participantId)}
        >
          Tentar de novo
        </button>
      </div>
    );
  } else if (connectionState === 'connecting' || connectionState === 'disconnected') {
    body = (
      <div className="popout__state" role="status">
        <Spinner label="Conectando" />
        <span>Entrando em {roomLabel(target.room)}…</span>
      </div>
    );
  } else if (stream) {
    body = (
      <div className="popout__stage">
        <VideoSurface track={stream.videoTrack} className="popout__video" />
        <StreamStatus stream={stream} />
        {connectionState === 'reconnecting' && (
          <div className="popout__notice" role="status">
            <Spinner size="sm" label="Reconectando" />
            Reconectando…
          </div>
        )}
        {!audioPlayback && (
          <button
            type="button"
            className="popout__notice popout__notice--action"
            onClick={() => void startAudio()}
          >
            <HeadphonesIcon size={16} />
            Clique para ativar o áudio
          </button>
        )}
      </div>
    );
  } else if (participantPresent) {
    body = (
      <div className="popout__state" role="status">
        <MonitorOffIcon size={36} />
        <span>Transmissão encerrada</span>
        <span className="popout__sub">{name} parou de transmitir.</span>
      </div>
    );
  } else {
    body = (
      <div className="popout__state" role="status">
        <MonitorOffIcon size={36} />
        <span>Transmissão encerrada</span>
        <span className="popout__sub">
          {name} não está mais em {roomLabel(target.room)}.
        </span>
      </div>
    );
  }

  return (
    <div className="popout">
      <header className="popout__bar">
        <span className="popout__title">
          <span className="badge-live">AO VIVO</span>
          {targetParticipant && (
            <Avatar id={targetParticipant} name={name} src={profile?.avatarUrl} size="xs" />
          )}
          <span className="popout__name">{name}</span>
          {targetRoom && <span className="popout__room">{roomLabel(targetRoom)}</span>}
          {stream && <QualityBars quality={stream.quality} size={14} />}
        </span>
        <span className="popout__actions">
          {stream && focusedId && (
            <VolumeControl
              compact
              setting={audio.settingFor(focusedId)}
              name={name}
              onVolume={(volume) => audio.setVolume(focusedId, volume)}
              onToggleMute={() => audio.toggleMute(focusedId)}
            />
          )}
          <button
            type="button"
            className={alwaysOnTop ? 'icon-btn icon-btn--active' : 'icon-btn'}
            aria-pressed={alwaysOnTop}
            aria-label="Sempre no topo"
            data-tooltip={alwaysOnTop ? 'Sempre no topo: ligado' : 'Sempre no topo'}
            onClick={togglePin}
          >
            <PinIcon size={18} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar janela"
            data-tooltip="Fechar"
            onClick={close}
          >
            <CloseIcon size={18} />
          </button>
        </span>
      </header>
      {(pinError || audio.outputError) && (
        <div className="popout__error" role="alert">
          {pinError ?? audio.outputError}
        </div>
      )}
      {body}
    </div>
  );
}
