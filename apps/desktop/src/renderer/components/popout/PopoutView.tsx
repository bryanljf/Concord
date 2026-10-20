import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { roomLabel } from '@concord/shared';
import type { PopoutTarget } from '../../../preload/api';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useFullscreen } from '../../hooks/useFullscreen';
import { useHotkeys } from '../../hooks/useHotkeys';
import { usePresence } from '../../hooks/usePresence';
import { useRemoteStreams } from '../../hooks/useRemoteStreams';
import { useRoom } from '../../hooks/useRoom';
import { useSettings } from '../../hooks/useSettings';
import { useStreamAudio } from '../../hooks/useStreamAudio';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useViewers } from '../../hooks/useViewers';
import { concord, toErrorMessage } from '../../lib/concord';
import { popoutMenuItems, type PopoutMenuAction } from '../../lib/popoutMenu';
import { presenceProfiles } from '../../lib/presence';
import { resolveViewers, type Viewer } from '../../lib/viewers';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { Spinner } from '../Spinner';
import { FocusedStreamTile } from '../StreamTile';
import { CloseIcon, HeadphonesIcon, MonitorOffIcon, WarningIcon } from '../icons';
import { StatsPanel, type StatsTarget } from '../stats/StatsPanel';
import '../../styles/stage.css';
import '../../styles/popout.css';

const NO_VIEWERS: readonly Viewer[] = [];

/** The only thing the pop-out's context menu is about. */
const LIVE = 'live';

/** Clicks on these start no window drag (they keep their own behavior). */
const INTERACTIVE =
  'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

/** Whether `target` is (inside) an interactive element that lives within `strip`. */
function isInteractiveWithin(target: EventTarget, strip: Element): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERACTIVE);
  return interactive !== null && interactive !== strip && strip.contains(interactive);
}

/** Where the focus goes when the element that opened the menu is gone. */
function focusedTileElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-focused-live]');
}

interface PopoutScreenProps {
  /** Name and room, shown in the top strip. */
  heading: string;
  tone?: 'default' | 'error';
  onDragStart(event: ReactPointerEvent<HTMLElement>): void;
  onClose(): void;
  /** Overlays (error notice). */
  overlay?: ReactNode;
  children: ReactNode;
}

/** A full-window message (loading, error, live ended) with a draggable strip and a close button. */
function PopoutScreen({
  heading,
  tone = 'default',
  onDragStart,
  onClose,
  overlay,
  children,
}: PopoutScreenProps) {
  return (
    <div className="popout__screen">
      <div className="popout__strip" onPointerDown={onDragStart}>
        <span className="popout__heading">{heading}</span>
        <span className="popout__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar janela"
            data-tooltip="Fechar"
            onClick={onClose}
          >
            <CloseIcon size={18} />
          </button>
        </span>
      </div>
      <div
        className={tone === 'error' ? 'popout__state popout__state--error' : 'popout__state'}
        role={tone === 'error' ? 'alert' : 'status'}
      >
        {children}
      </div>
      {overlay}
    </div>
  );
}

/**
 * The frameless pop-out window: its own subscribe-only livekit connection
 * (`requestToken(room, 'popout')`) showing one participant's screen share like the stage's focused
 * view, filling the window: auto-hiding controls over the video (volume, viewers, back to the main
 * window, "sempre no topo", fullscreen, close), the top strip drags the window, right click opens
 * the menu. Main re-targets it through `onNavigate`.
 */
export function PopoutView() {
  const [target, setTarget] = useState<PopoutTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  /** Pin / fullscreen / audio failures (audio output errors come from `useStreamAudio`). */
  const [windowError, setWindowError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const { settings } = useSettings();
  const { room, connectionState, error, audioPlayback, join, startAudio } = useRoom({
    purpose: 'popout',
  });
  const connected = connectionState === 'connected';
  const streams = useRemoteStreams(room);
  // The screen share's key is the participant id.
  const focusedId = target?.participantId ?? null;
  useSubscriptions(streams, focusedId, connected);
  const screens = useMemo(() => streams.filter((stream) => stream.kind === 'screen'), [streams]);
  const audio = useStreamAudio({
    room,
    connectionState,
    streams: screens,
    outputDeviceId: settings?.audioOutputDeviceId ?? null,
  });
  const { fullscreen, setFullscreen } = useFullscreen();
  const contextMenu = useContextMenu<typeof LIVE>(focusedTileElement);

  // Presence follows nickname/avatar changes; LiveKit's name is fixed when the token is issued.
  const { snapshot } = usePresence();
  const profiles = useMemo(() => presenceProfiles(snapshot), [snapshot]);
  const profile = focusedId ? profiles.get(focusedId) : undefined;
  const liveStream = screens.find((candidate) => candidate.participantId === focusedId) ?? null;
  const stream = useMemo(
    () =>
      liveStream && profile
        ? { ...liveStream, name: profile.name, avatarUrl: profile.avatarUrl }
        : liveStream,
    [liveStream, profile],
  );
  const hasAudio = stream?.audio != null;
  // In the room but not publishing = they stopped; absent = not (yet) in the room.
  const participantPresent =
    focusedId !== null && room.getParticipantByIdentity(focusedId) !== undefined;

  // Who watches this live: everyone's watching attribute, seen from this window's connection.
  const viewerIds = useViewers(room);
  const viewers = useMemo(() => {
    const ids = focusedId ? viewerIds.get(focusedId) : undefined;
    if (!ids) return NO_VIEWERS;
    const livekitName = (id: string): string | undefined =>
      room.getParticipantByIdentity(id)?.name || undefined;
    return resolveViewers(ids, profiles, livekitName);
  }, [viewerIds, focusedId, profiles, room]);

  const statsTarget = useMemo<StatsTarget | null>(
    () => (stream ? { kind: 'remote', stream } : null),
    [stream],
  );
  const statsVisible = statsOpen && statsTarget !== null;

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

  // A reopened pop-out keeps the window's pin: show what main really has.
  const pinTouched = useRef(false);
  useEffect(() => {
    let active = true;
    concord()
      .getAlwaysOnTop()
      .then(
        (pinned) => {
          if (active && !pinTouched.current) setAlwaysOnTopState(pinned);
        },
        () => undefined,
      );
    return () => {
      active = false;
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

  const reportError = useCallback((message: string) => {
    setWindowError(message);
    setDismissedError(null);
  }, []);

  const togglePin = useCallback(() => {
    const next = !alwaysOnTop;
    pinTouched.current = true;
    setAlwaysOnTopState(next);
    concord()
      .setAlwaysOnTop(next)
      .then(
        () => setWindowError(null),
        (err: unknown) => {
          setAlwaysOnTopState(!next);
          reportError(toErrorMessage(err, 'Não foi possível fixar a janela.'));
        },
      );
  }, [alwaysOnTop, reportError]);

  const changeFullscreen = useCallback(
    (enabled: boolean) => {
      setFullscreen(enabled).catch((err: unknown) => {
        reportError(toErrorMessage(err, 'Não foi possível alternar a tela cheia.'));
      });
    },
    [setFullscreen, reportError],
  );
  const toggleFullscreen = useCallback(
    () => changeFullscreen(!fullscreen),
    [changeFullscreen, fullscreen],
  );

  // Closing the pop-out is also "back to the main window": main resumes the live there.
  const close = useCallback(() => {
    concord()
      .closePopout()
      .catch(() => window.close());
  }, []);

  const enableAudio = useCallback(() => {
    startAudio().catch(() => reportError('O áudio continua bloqueado. Tente clicar de novo.'));
  }, [startAudio, reportError]);

  const closeStats = useCallback(() => setStatsOpen(false), []);

  // Frameless window: main moves it while the primary button is held on a top strip.
  const drag = useRef<{ end: (() => void) | null }>({ end: null });
  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || fullscreen) return;
      const strip = event.currentTarget;
      if (isInteractiveWithin(event.target, strip)) return;
      drag.current.end?.();
      const { pointerId } = event;
      try {
        strip.setPointerCapture(pointerId);
      } catch {
        // The pointer is already gone; the drag still ends on pointerup below.
      }
      const end = (): void => {
        if (drag.current.end !== end) return;
        drag.current.end = null;
        // On the window too: the strip may unmount mid-drag (the live ended).
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
        strip.removeEventListener('lostpointercapture', end);
        if (strip.hasPointerCapture(pointerId)) strip.releasePointerCapture(pointerId);
        concord()
          .endWindowDrag()
          .catch(() => undefined);
      };
      drag.current.end = end;
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
      strip.addEventListener('lostpointercapture', end);
      concord().startWindowDrag().catch(end);
    },
    [fullscreen],
  );
  useEffect(() => {
    const state = drag.current;
    return () => state.end?.();
  }, []);

  // Double click on the live's top strip toggles fullscreen, like on the video itself.
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!stream || !(event.target instanceof Element)) return;
      const strip = event.target.closest('.tile__top--drag');
      if (!strip || isInteractiveWithin(event.target, strip)) return;
      toggleFullscreen();
    },
    [stream, toggleFullscreen],
  );

  const runMenuAction = useCallback(
    (action: PopoutMenuAction) => {
      switch (action) {
        case 'mute':
          if (focusedId) audio.setMuted(focusedId, true);
          break;
        case 'unmute':
          if (focusedId) audio.setMuted(focusedId, false);
          break;
        case 'stats':
          setStatsOpen((open) => !open);
          break;
        case 'return':
        case 'close':
          close();
          break;
      }
    },
    [audio, focusedId, close],
  );

  useHotkeys({
    onToggleFullscreen: toggleFullscreen,
    onEscape: () => {
      if (statsVisible) setStatsOpen(false);
      else if (fullscreen) changeFullscreen(false);
    },
    onToggleMute: () => {
      if (focusedId && hasAudio) audio.toggleMute(focusedId);
    },
  });

  const errorMessage = windowError ?? audio.outputError;
  const visibleError =
    errorMessage !== null && errorMessage !== dismissedError ? errorMessage : null;
  const errorNotice = visibleError && (
    <div className="popout__notice popout__notice--error" role="alert">
      <span>{visibleError}</span>
      <button
        type="button"
        className="popout__notice-dismiss"
        aria-label="Dispensar aviso"
        onClick={() => setDismissedError(visibleError)}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
  const heading = targetRoom ? `${name} · ${roomLabel(targetRoom)}` : 'Concord';
  const screenProps = {
    heading,
    onDragStart: startDrag,
    onClose: close,
    overlay: errorNotice && <div className="popout__notices">{errorNotice}</div>,
  };

  let body: ReactNode;
  if (targetError) {
    body = (
      <PopoutScreen {...screenProps} tone="error">
        <WarningIcon size={36} />
        <span>{targetError}</span>
      </PopoutScreen>
    );
  } else if (!target) {
    body = (
      <PopoutScreen {...screenProps}>
        <Spinner label="Carregando" />
      </PopoutScreen>
    );
  } else if (error) {
    body = (
      <PopoutScreen {...screenProps} tone="error">
        <WarningIcon size={36} />
        <span>{error}</span>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => void join(target.room, target.participantId)}
        >
          Tentar de novo
        </button>
      </PopoutScreen>
    );
  } else if (connectionState === 'connecting' || connectionState === 'disconnected') {
    body = (
      <PopoutScreen {...screenProps}>
        <Spinner label="Conectando" />
        <span>Entrando em {roomLabel(target.room)}…</span>
      </PopoutScreen>
    );
  } else if (stream) {
    const participantId = stream.participantId;
    body = (
      <FocusedStreamTile
        key={stream.key}
        stream={stream}
        viewers={viewers}
        volume={hasAudio ? audio.settingFor(participantId) : undefined}
        onVolume={hasAudio ? (volume) => audio.setVolume(participantId, volume) : undefined}
        onToggleMute={hasAudio ? () => audio.toggleMute(participantId) : undefined}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onReturnToMain={close}
        pinned={alwaysOnTop}
        onTogglePin={togglePin}
        onClose={close}
        onDragStart={startDrag}
        subtitle={roomLabel(target.room)}
        onContextMenu={(event) => contextMenu.onContextMenu(event, LIVE)}
        onKeyDown={(event) => contextMenu.onKeyDown(event, LIVE)}
      >
        {statsOpen && statsTarget && <StatsPanel target={statsTarget} onClose={closeStats} />}
        <div className="popout__notices">
          {connectionState === 'reconnecting' && (
            <div className="popout__notice popout__notice--warning" role="status">
              <Spinner size="sm" label="Reconectando" />
              Reconectando…
            </div>
          )}
          {!audioPlayback && hasAudio && (
            <button
              type="button"
              className="popout__notice popout__notice--action"
              onClick={enableAudio}
            >
              <HeadphonesIcon size={16} />
              Clique para ativar o áudio
            </button>
          )}
          {errorNotice}
        </div>
      </FocusedStreamTile>
    );
  } else {
    body = (
      <PopoutScreen {...screenProps}>
        <MonitorOffIcon size={36} />
        <span>Transmissão encerrada</span>
        <span className="popout__sub">
          {participantPresent
            ? `${name} parou de transmitir.`
            : `${name} não está mais em ${roomLabel(target.room)}.`}
        </span>
      </PopoutScreen>
    );
  }

  // The menu only exists while the live is on.
  const menu = contextMenu.menu;
  let menuItems: ContextMenuItem[] = [];
  if (menu && stream) {
    const muted = audio.settingFor(stream.participantId).muted;
    menuItems = popoutMenuItems({ muted, hasAudio }).map((item) => ({
      id: item.action,
      label: item.label,
      danger: item.danger,
      separatorBefore: item.separatorBefore,
      onSelect: () => runMenuAction(item.action),
    }));
  }

  return (
    <div className="popout" onDoubleClick={onDoubleClick}>
      {body}
      {menu && stream && (
        <ContextMenu
          point={menu.point}
          label={`Opções da transmissão de ${stream.name}`}
          items={menuItems}
          onClose={contextMenu.close}
        />
      )}
    </div>
  );
}
