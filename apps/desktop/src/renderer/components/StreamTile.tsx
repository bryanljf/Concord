import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useAutoHide } from '../hooks/useAutoHide';
import { useLongPress } from '../hooks/useLongPress';
import type { RemoteStream } from '../hooks/useRemoteStreams';
import { useStreamStats } from '../hooks/useStreamStats';
import { useTouchReveal } from '../hooks/useTouchReveal';
import { useViewport } from '../hooks/useViewport';
import { formatStats } from '../lib/streamStats';
import { dispatchContextMenu, usesVideoFullscreen } from '../lib/touch';
import { Avatar } from './Avatar';
import type { Viewer } from '../lib/viewers';
import type { VolumeSetting } from '../lib/volume';
import {
  CloseIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  GridIcon,
  MonitorIcon,
  MonitorOffIcon,
  PinIcon,
  PopOutIcon,
  ReturnIcon,
  SwapScreenIcon,
} from './icons';
import { QualityBars } from './stream/QualityBars';
import { StreamStatus } from './stream/StreamStatus';
import { ViewerList } from './stream/ViewerList';
import { VideoSurface } from './stream/VideoSurface';
import { VolumeControl } from './stream/VolumeControl';

interface FocusedTileProps {
  stream: RemoteStream;
  /** Who is watching this live (you included). */
  viewers: readonly Viewer[];
  /** Screen shares only: webcams have no audio, so the volume control is hidden without it. */
  volume?: VolumeSetting;
  onVolume?(volume: number): void;
  onToggleMute?(): void;
  fullscreen: boolean;
  onToggleFullscreen(): void;
  // Optional actions: each button is only rendered when its callback is given.
  /** Stage: open in another window (the pop-out for a screen share, the PiP for a webcam). */
  onPopout?(): void;
  /**
   * `onPopout` opens the browser's own picture-in-picture of this stream instead of another
   * window (the web client): the button says so.
   */
  popoutNative?: boolean;
  /** Stage: "Parar de assistir" (also in the right-click menu). */
  onStopWatching?(): void;
  /** Stage with 2+ watched lives: "Voltar à grade". */
  onShowGrid?(): void;
  /** Pop-out: close it and show the live in the main window again. */
  onReturnToMain?(): void;
  /** Pop-out: "Sempre no topo" toggle. */
  pinned?: boolean;
  onTogglePin?(): void;
  /** Pop-out: close the window. */
  onClose?(): void;
  /** Pointer down on the top strip (the pop-out drags its frameless window from there). */
  onDragStart?(event: PointerEvent<HTMLElement>): void;
  /** Shown after the name in the top strip (the pop-out shows the room). */
  subtitle?: string;
  /** Right click (or a long press on a touch screen): opens the watched-live menu. */
  onContextMenu(event: MouseEvent<HTMLElement>): void;
  /** ContextMenu key / Shift+F10 while the tile has the focus. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  /** Overlays rendered inside the tile (notices, the stats panel). */
  children?: ReactNode;
}

/**
 * The watched live on the stage (or filling the pop-out): video at full quality, auto-hiding
 * controls, stats on hover. Focusable so its context menu also opens from the keyboard. On a
 * touch screen a tap shows the controls for a moment and a long press opens the menu.
 */
export function FocusedStreamTile({
  stream,
  viewers,
  volume,
  onVolume,
  onToggleMute,
  fullscreen,
  onToggleFullscreen,
  onPopout,
  popoutNative = false,
  onStopWatching,
  onShowGrid,
  onReturnToMain,
  pinned = false,
  onTogglePin,
  onClose,
  onDragStart,
  subtitle,
  onContextMenu,
  onKeyDown,
  children,
}: FocusedTileProps) {
  const tile = useRef<HTMLDivElement>(null);
  const { touch } = useViewport();
  // The bars stay while the pointer rests on them (checked live when the timer runs out). Not on
  // a touch screen, where `:hover` sticks to the last thing tapped and would never let them go.
  const controls = useAutoHide(3000, true, () =>
    Boolean(!touch && tile.current?.querySelector('.tile__top:hover, .tile__controls:hover')),
  );
  const stats = useStreamStats(stream.videoTrack, controls.visible);
  const statsText = stats ? formatStats(stats) : null;
  const camera = stream.kind === 'camera';
  const longPress = useLongPress(dispatchContextMenu);

  // On an iPhone the page cannot go fullscreen, but the video itself can.
  const toggleFullscreen = (): void => {
    const video = tile.current?.querySelector('video') ?? null;
    if (!fullscreen && usesVideoFullscreen(document, video)) {
      try {
        (video as HTMLVideoElement & { webkitEnterFullscreen(): void }).webkitEnterFullscreen();
        return;
      } catch {
        // Not playing yet: the usual way, which the owner reports.
      }
    }
    onToggleFullscreen();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    longPress.onPointerDown(event);
    // A tap shows the controls like the mouse moving does; the next tap acts on them.
    if (event.pointerType === 'touch') controls.poke();
  };

  return (
    <div
      ref={tile}
      className={tileClass(
        controls.visible ? 'tile tile--focused tile--controls' : 'tile tile--focused',
        stream,
      )}
      role="group"
      tabIndex={0}
      aria-label={`${camera ? 'Câmera' : 'Transmissão'} de ${stream.name}. Shift+F10 abre as opções.`}
      aria-haspopup="menu"
      aria-keyshortcuts="Shift+F10 ContextMenu"
      data-focused-live=""
      data-stream-key={stream.key}
      onMouseMove={controls.poke}
      onMouseLeave={controls.hide}
      {...longPress}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <VideoSurface
        track={stream.videoTrack}
        className="tile__video"
        onDoubleClick={toggleFullscreen}
      />
      <StreamStatus stream={stream} />
      <div
        className={onDragStart ? 'tile__top tile__top--drag' : 'tile__top'}
        onPointerDown={onDragStart}
      >
        <KindBadge stream={stream} />
        <Avatar id={stream.participantId} name={stream.name} src={stream.avatarUrl} size="sm" />
        <span className="tile__name">{stream.name}</span>
        {subtitle && <span className="tile__subtitle">{subtitle}</span>}
        <QualityBars quality={stream.quality} />
        <span className="tile__stats" data-tooltip="Resolução · fps · bitrate recebidos">
          {statsText ?? 'medindo…'}
        </span>
      </div>
      <div className="tile__controls">
        <div className="tile__bottom-left">
          {volume && onVolume && onToggleMute && (
            <VolumeControl
              setting={volume}
              name={stream.name}
              onVolume={onVolume}
              onToggleMute={onToggleMute}
              onHold={controls.hold}
            />
          )}
          <ViewerList viewers={viewers} />
        </div>
        <div className="tile__actions">
          {onShowGrid && (
            <button
              type="button"
              className="icon-btn icon-btn--overlay"
              aria-label="Voltar à grade"
              data-tooltip="Voltar à grade"
              onClick={onShowGrid}
            >
              <GridIcon size={18} />
            </button>
          )}
          {onStopWatching && (
            <button
              type="button"
              className="icon-btn icon-btn--overlay"
              aria-label={`Parar de assistir ${stream.name}`}
              data-tooltip="Parar de assistir"
              onClick={onStopWatching}
            >
              <MonitorOffIcon size={18} />
            </button>
          )}
          {onPopout && (
            <button
              type="button"
              className="icon-btn icon-btn--overlay"
              aria-label={
                popoutNative
                  ? 'Abrir em picture-in-picture'
                  : camera
                    ? 'Abrir as câmeras em picture-in-picture'
                    : 'Abrir em janela separada'
              }
              data-tooltip={popoutNative || camera ? 'Picture-in-picture' : 'Janela separada'}
              onClick={onPopout}
            >
              <PopOutIcon size={18} />
            </button>
          )}
          {onReturnToMain && (
            <button
              type="button"
              className="icon-btn icon-btn--overlay"
              aria-label="Voltar para a janela principal"
              data-tooltip="Voltar para a janela principal"
              onClick={onReturnToMain}
            >
              <ReturnIcon size={18} />
            </button>
          )}
          {onTogglePin && (
            <button
              type="button"
              className={
                pinned
                  ? 'icon-btn icon-btn--overlay icon-btn--active'
                  : 'icon-btn icon-btn--overlay'
              }
              aria-pressed={pinned}
              aria-label="Sempre no topo"
              data-tooltip={pinned ? 'Sempre no topo: ligado' : 'Sempre no topo'}
              onClick={onTogglePin}
            >
              <PinIcon size={18} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--overlay"
            aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            data-tooltip={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F11)'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <ExitFullscreenIcon size={18} /> : <FullscreenIcon size={18} />}
          </button>
          {onClose && (
            <button
              type="button"
              className="icon-btn icon-btn--overlay"
              aria-label="Fechar janela"
              data-tooltip="Fechar"
              onClick={onClose}
            >
              <CloseIcon size={18} />
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/** "AO VIVO" for a screen share, "CÂMERA" for a webcam. */
function KindBadge({ stream }: { stream: RemoteStream }) {
  return stream.kind === 'camera' ? (
    <span className="tile__badge badge-camera">CÂMERA</span>
  ) : (
    <span className="tile__badge badge-live">AO VIVO</span>
  );
}

function tileClass(base: string, stream: RemoteStream): string {
  return stream.kind === 'camera' ? `${base} tile--camera` : base;
}

/** "a transmissão de Ana" / "a câmera de Ana", for accessible names. */
function streamLabel(stream: RemoteStream): string {
  return `${stream.kind === 'camera' ? 'a câmera' : 'a transmissão'} de ${stream.name}`;
}

/**
 * The × and volume of a small tile show on hover; on a touch screen the first tap shows them for
 * a moment (`tile-mini--revealed`) and the next tap acts on the tile.
 */
function useSmallTileTouch() {
  const { touch } = useViewport();
  const reveal = useTouchReveal();
  const longPress = useLongPress(dispatchContextMenu);
  const revealed = touch && reveal.revealed;
  /** Wraps the tile's tap action: the first tap on a touch screen only reveals. */
  const onTap = (act: () => void) => (): void => {
    if (touch && reveal.tap()) return;
    act();
  };
  return { revealed, longPress, onTap, keep: reveal.show };
}

interface MiniTileProps {
  stream: RemoteStream;
  onSelect(): void;
  /** The small × in the corner (also in the right-click menu). */
  onStopWatching(): void;
  /** Right click (or a long press on a touch screen): opens the watched-stream menu. */
  onContextMenu(event: MouseEvent<HTMLElement>): void;
  /** ContextMenu key / Shift+F10 while the tile has the focus. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

/**
 * A watched stream in the strip (lowest simulcast layer, no audio, webcams filling the tile);
 * clicking only puts it in destaque, it never subscribes anything new.
 */
export function MiniStreamTile({
  stream,
  onSelect,
  onStopWatching,
  onContextMenu,
  onKeyDown,
}: MiniTileProps) {
  const { revealed, longPress, onTap } = useSmallTileTouch();
  return (
    <div
      className={revealed ? 'tile-mini tile-mini--revealed' : 'tile-mini'}
      data-stream-key={stream.key}
    >
      <button
        type="button"
        className={tileClass('tile tile--mini', stream)}
        aria-label={`Destacar ${streamLabel(stream)}`}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10 ContextMenu"
        data-tooltip="Clique para destacar · botão direito: opções"
        {...longPress}
        onClick={onTap(onSelect)}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        <VideoSurface track={stream.videoTrack} className="tile__video" />
        <StreamStatus stream={stream} compact />
        <div className="tile__top tile__top--mini">
          {stream.kind === 'camera' && <KindBadge stream={stream} />}
          <Avatar id={stream.participantId} name={stream.name} src={stream.avatarUrl} size="xs" />
          <span className="tile__name">{stream.name}</span>
          <QualityBars quality={stream.quality} size={14} />
        </div>
      </button>
      <button
        type="button"
        className="tile-mini__close"
        aria-label={`Parar de assistir ${streamLabel(stream)}`}
        title="Parar de assistir"
        onClick={onStopWatching}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

interface GridTileProps {
  stream: RemoteStream;
  /** Who is watching this stream (you included). */
  viewers: readonly Viewer[];
  /** Click / Enter: puts it in destaque. */
  onSelect(): void;
  /** The × shown on hover (also in the right-click menu). */
  onStopWatching(): void;
  onContextMenu(event: MouseEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  /** Screen shares with audio: the volume shown on hover (muted while the grid silences it). */
  volume?: VolumeSetting;
  onVolume?(volume: number): void;
  onToggleMute?(): void;
}

/**
 * A watched stream on the grid (2+ watched): full quality (adaptive stream picks the layer from
 * the tile size), name, badge and viewers always visible, × and volume on hover (a silent tile
 * keeps its muted icon). Fills its grid cell.
 */
export function GridStreamTile({
  stream,
  viewers,
  onSelect,
  onStopWatching,
  onContextMenu,
  onKeyDown,
  volume,
  onVolume,
  onToggleMute,
}: GridTileProps) {
  const { revealed, longPress, onTap, keep } = useSmallTileTouch();
  return (
    <div
      className={revealed ? 'tile-mini tile-grid tile-mini--revealed' : 'tile-mini tile-grid'}
      data-stream-key={stream.key}
    >
      <button
        type="button"
        className={tileClass('tile tile--grid', stream)}
        aria-label={`Destacar ${streamLabel(stream)}`}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10 ContextMenu"
        {...longPress}
        onClick={onTap(onSelect)}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        <VideoSurface track={stream.videoTrack} className="tile__video" />
        <StreamStatus stream={stream} />
        <div className="tile__top tile__top--grid">
          <KindBadge stream={stream} />
          <Avatar id={stream.participantId} name={stream.name} src={stream.avatarUrl} size="sm" />
          <span className="tile__name">{stream.name}</span>
          <QualityBars quality={stream.quality} />
          <ViewerList viewers={viewers} variant="compact" />
        </div>
      </button>
      <button
        type="button"
        className="tile-mini__close tile-grid__close"
        aria-label={`Parar de assistir ${streamLabel(stream)}`}
        title="Parar de assistir"
        onClick={onStopWatching}
      >
        <CloseIcon size={16} />
      </button>
      {volume && onVolume && onToggleMute && (
        <div
          className={
            volume.muted ? 'tile-grid__volume tile-grid__volume--muted' : 'tile-grid__volume'
          }
          // Using the revealed slider keeps it on screen.
          onPointerDown={keep}
        >
          <VolumeControl
            setting={volume}
            name={stream.name}
            onVolume={onVolume}
            onToggleMute={onToggleMute}
            compact
          />
        </div>
      )}
    </div>
  );
}

interface GridSlotTileProps {
  /** You are live: the button reads "Trocar fonte" (like the bottom bar's). */
  live: boolean;
  /** A broadcast is starting or stopping. */
  busy: boolean;
  /** "Transmitir": opens the source picker. */
  onStream(): void;
  /** "Trocar fonte": opens the picker to switch what is shared. */
  onSwitch(): void;
}

/** The free cell of a grid with an odd count: same outline as the tiles, "Transmitir" inside. */
export function GridSlotTile({ live, busy, onStream, onSwitch }: GridSlotTileProps) {
  return (
    <div className="grid-slot">
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={live ? onSwitch : onStream}
      >
        {live ? <SwapScreenIcon size={18} /> : <MonitorIcon size={18} />}
        {live ? 'Trocar fonte' : 'Transmitir'}
      </button>
      <span className="grid-slot__hint">
        {live ? 'Troque a janela ou a tela transmitida' : 'Compartilhe sua tela com a sala'}
      </span>
    </div>
  );
}
