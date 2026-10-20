import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Track } from 'livekit-client';
import type { PipResizeCorner, PipTarget } from '../../../preload/api';
import { usePresence } from '../../hooks/usePresence';
import { useRemoteStreams, type RemoteStream } from '../../hooks/useRemoteStreams';
import { useRoom } from '../../hooks/useRoom';
import { useSettings } from '../../hooks/useSettings';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { concord } from '../../lib/concord';
import { presenceProfiles } from '../../lib/presence';
import { cameraKey } from '../../lib/streamKey';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import { CloseIcon, ExitFullscreenIcon, MaximizeIcon, WarningIcon } from '../icons';
import { VideoSurface } from '../stream/VideoSurface';
import '../../styles/pip.css';

const CORNERS: readonly PipResizeCorner[] = ['nw', 'ne', 'sw', 'se'];
const NO_PARTICIPANTS: readonly string[] = [];

/** What the pointer is doing to the window (main follows the cursor until it is released). */
type Gesture = 'move' | 'resize' | null;

function ignoreFailure(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Main may be gone (quitting) or the window closing; nothing to show in a PiP.
  });
}

/** Buttons and resize grips handle their own pointer; the rest of the window drags it. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, .pip__grip') !== null;
}

/**
 * The cameras' picture-in-picture window: its own subscribe-only livekit connection
 * (`requestToken(room, 'pip')`), every camera of the target stacked in a small frameless,
 * always-on-top window. No audio (voice stays on Discord). The window is moved and resized by
 * main following the cursor (`startWindowDrag` / `startPipResize`), never with
 * `-webkit-app-region`, which would swallow hover and clicks.
 */
export function PipView() {
  const [target, setTarget] = useState<PipTarget | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { settings } = useSettings();
  const { room, connectionState, error, join } = useRoom({ purpose: 'pip' });
  const streams = useRemoteStreams(room);
  const participantIds = target?.participantIds ?? NO_PARTICIPANTS;
  const cameraKeys = useMemo(() => participantIds.map(cameraKey), [participantIds]);
  const connected = connectionState === 'connected';
  // Every remote video goes in, so a camera dropped from the target is unsubscribed too.
  useSubscriptions(streams, null, connected, cameraKeys);
  // Presence follows nickname/avatar changes; LiveKit's name is fixed when the token is issued.
  const { snapshot } = usePresence();
  const profiles = useMemo(() => presenceProfiles(snapshot), [snapshot]);
  const cameras = useMemo(() => {
    const byParticipant = new Map<string, RemoteStream>();
    for (const stream of streams) {
      if (stream.kind === 'camera') byParticipant.set(stream.participantId, stream);
    }
    return byParticipant;
  }, [streams]);

  // pip.css paints the window (dark, rounded): the theme's page background must go.
  useLayoutEffect(() => {
    document.documentElement.classList.add('pip-window');
    document.title = 'Câmeras — Concord';
  }, []);

  useEffect(() => {
    let active = true;
    const api = concord();
    const unsubscribe = api.onPipTarget((next) => {
      setTarget(next);
      setLoaded(true);
    });
    api.getPipTarget().then(
      (initial) => {
        if (!active) return;
        // A target pushed meanwhile is newer than this one.
        setTarget((previous) => previous ?? initial);
        setLoaded(true);
      },
      () => {
        if (active) setLoaded(true);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => concord().onPipFullscreenChanged(setFullscreen), []);

  const targetRoom = target?.room ?? null;
  useEffect(() => {
    if (targetRoom) void join(targetRoom);
  }, [targetRoom, join]);

  const gesture = useRef<Gesture>(null);

  const endGesture = useCallback(() => {
    const current = gesture.current;
    gesture.current = null;
    if (current === 'move') ignoreFailure(concord().endWindowDrag());
    else if (current === 'resize') ignoreFailure(concord().endPipResize());
  }, []);

  // Never leave main following the cursor (e.g. the window reloads mid-drag).
  useEffect(() => endGesture, [endGesture]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // A fullscreen PiP covers the screen: nothing to drag.
    if (event.button !== 0 || gesture.current || fullscreen || isControl(event.target)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = 'move';
    ignoreFailure(concord().startWindowDrag());
  }

  function onGripPointerDown(
    event: ReactPointerEvent<HTMLSpanElement>,
    corner: PipResizeCorner,
  ): void {
    if (event.button !== 0 || gesture.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = 'resize';
    ignoreFailure(concord().startPipResize(corner));
  }

  const toggleFullscreen = useCallback(() => {
    const next = !fullscreen;
    setFullscreen(next);
    concord()
      .setPipFullscreen(next)
      .catch(() => setFullscreen(!next));
  }, [fullscreen]);

  function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!isControl(event.target)) toggleFullscreen();
  }

  function onContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    ignoreFailure(concord().showPipMenu());
  }

  const close = useCallback(() => {
    concord()
      .closePip()
      .catch(() => window.close());
  }, []);

  const layout = settings?.pipLayout ?? 'vertical';
  // Fullscreen: a grid as square as possible instead of one long row or column.
  const count = Math.max(participantIds.length, 1);
  const columns = Math.ceil(Math.sqrt(count));
  const gridStyle = {
    '--pip-columns': columns,
    '--pip-rows': Math.ceil(count / columns),
  } as CSSProperties;

  let notice: ReactNode = null;
  if (error) {
    notice = (
      <div className="pip__notice pip__notice--error" role="alert">
        <WarningIcon size={14} />
        <span className="pip__notice-text">{error}</span>
        {targetRoom && (
          <button type="button" className="pip__retry" onClick={() => void join(targetRoom)}>
            Tentar de novo
          </button>
        )}
      </div>
    );
  } else if (loaded && !target) {
    notice = (
      <div className="pip__notice" role="status">
        <span className="pip__notice-text">Nenhuma câmera escolhida.</span>
      </div>
    );
  }

  return (
    <div
      className={fullscreen ? `pip pip--${layout} pip--fullscreen` : `pip pip--${layout}`}
      style={gridStyle}
      onPointerDown={onPointerDown}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {!loaded && (
        <div className="pip__loading" role="status">
          <Spinner label="Carregando" />
        </div>
      )}
      <div className="pip__tiles">
        {participantIds.map((participantId) => {
          const stream = cameras.get(participantId) ?? null;
          const profile = profiles.get(participantId);
          return (
            <PipTile
              key={participantId}
              participantId={participantId}
              name={profile?.name ?? stream?.name ?? participantId}
              avatarUrl={profile?.avatarUrl ?? null}
              stream={stream}
              waiting={!connected && !error}
            />
          );
        })}
      </div>
      {notice}
      <div className="pip__actions">
        <button
          type="button"
          className="pip__btn"
          aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <ExitFullscreenIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button
          type="button"
          className="pip__btn pip__btn--close"
          aria-label="Fechar picture-in-picture"
          title="Fechar"
          onClick={close}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      {!fullscreen &&
        CORNERS.map((corner) => (
          <span
            key={corner}
            className={`pip__grip pip__grip--${corner}`}
            aria-hidden="true"
            onPointerDown={(event) => onGripPointerDown(event, corner)}
          />
        ))}
    </div>
  );
}

interface PipTileProps {
  participantId: string;
  name: string;
  avatarUrl: string | null;
  /** Null while the camera is not (or no longer) published in the room. */
  stream: RemoteStream | null;
  /** Still connecting to the room (or reconnecting). */
  waiting: boolean;
}

/** One camera: the video filling a rounded 16:9 tile, the name on hover. */
function PipTile({ participantId, name, avatarUrl, stream, waiting }: PipTileProps) {
  const track = stream?.videoTrack ?? null;
  let status: ReactNode = null;
  if (!track) {
    // Subscribed but the first frame has not arrived, or not connected yet: wait. Otherwise
    // the camera went off (main drops it from the target shortly).
    status =
      waiting || stream ? (
        <div className="pip__status" role="status">
          <Spinner size="sm" label={`Carregando a câmera de ${name}`} />
        </div>
      ) : (
        <div className="pip__status" role="status" aria-label={`Câmera de ${name} desligada`}>
          <Avatar id={participantId} name={name} src={avatarUrl} size="md" />
        </div>
      );
  } else if (stream?.videoMuted) {
    status = (
      <div className="pip__status" role="status" aria-label={`Câmera de ${name} pausada`}>
        <Avatar id={participantId} name={name} src={avatarUrl} size="md" />
      </div>
    );
  } else if (waiting || stream?.streamState === Track.StreamState.Paused) {
    status = (
      <div className="pip__status pip__status--translucent" role="status">
        <Spinner size="sm" label={`Aguardando o vídeo de ${name}`} />
      </div>
    );
  }

  return (
    <div className="pip__cell">
      <div className="pip__tile" role="group" aria-label={`Câmera de ${name}`}>
        <VideoSurface track={track} className="pip__video" />
        {status}
        <span className="pip__name">
          <Avatar id={participantId} name={name} src={avatarUrl} size="xs" />
          <span className="pip__name-text">{name}</span>
        </span>
      </div>
    </div>
  );
}
