import type { KeyboardEvent, MouseEvent } from 'react';
import { useAutoHide } from '../hooks/useAutoHide';
import type { RemoteStream } from '../hooks/useRemoteStreams';
import { useStreamStats } from '../hooks/useStreamStats';
import { formatStats } from '../lib/streamStats';
import { Avatar } from './Avatar';
import type { VolumeSetting } from '../lib/volume';
import { ExitFullscreenIcon, FullscreenIcon, PopOutIcon } from './icons';
import { QualityBars } from './stream/QualityBars';
import { StreamStatus } from './stream/StreamStatus';
import { VideoSurface } from './stream/VideoSurface';
import { VolumeControl } from './stream/VolumeControl';

interface FocusedTileProps {
  stream: RemoteStream;
  volume: VolumeSetting;
  fullscreen: boolean;
  onVolume(volume: number): void;
  onToggleMute(): void;
  onToggleFullscreen(): void;
  onPopout(): void;
  /** Right click: opens the watched-live menu. */
  onContextMenu(event: MouseEvent<HTMLElement>): void;
  /** ContextMenu key / Shift+F10 while the tile has the focus. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

/**
 * The watched live on the stage: video at full quality with audio, auto-hiding controls, stats on
 * hover. Focusable so its context menu also opens from the keyboard.
 */
export function FocusedStreamTile({
  stream,
  volume,
  fullscreen,
  onVolume,
  onToggleMute,
  onToggleFullscreen,
  onPopout,
  onContextMenu,
  onKeyDown,
}: FocusedTileProps) {
  const controls = useAutoHide(3000);
  const stats = useStreamStats(stream.videoTrack, controls.visible);
  const statsText = stats ? formatStats(stats) : null;

  return (
    <div
      className={controls.visible ? 'tile tile--focused tile--controls' : 'tile tile--focused'}
      role="group"
      tabIndex={0}
      aria-label={`Transmissão de ${stream.name}. Shift+F10 abre as opções.`}
      aria-haspopup="menu"
      aria-keyshortcuts="Shift+F10 ContextMenu"
      data-focused-live=""
      onMouseMove={controls.poke}
      onMouseLeave={controls.hide}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <VideoSurface
        track={stream.videoTrack}
        className="tile__video"
        onDoubleClick={onToggleFullscreen}
      />
      <StreamStatus stream={stream} />
      <div
        className="tile__top"
        onMouseEnter={() => controls.hold(true)}
        onMouseLeave={() => controls.hold(false)}
      >
        <span className="tile__badge badge-live">AO VIVO</span>
        <Avatar id={stream.participantId} name={stream.name} src={stream.avatarUrl} size="sm" />
        <span className="tile__name">{stream.name}</span>
        <QualityBars quality={stream.quality} />
        <span className="tile__stats" data-tooltip="Resolução · fps · bitrate recebidos">
          {statsText ?? 'medindo…'}
        </span>
      </div>
      <div
        className="tile__controls"
        onMouseEnter={() => controls.hold(true)}
        onMouseLeave={() => controls.hold(false)}
      >
        <VolumeControl
          setting={volume}
          name={stream.name}
          onVolume={onVolume}
          onToggleMute={onToggleMute}
          onHold={controls.hold}
        />
        <div className="tile__actions">
          <button
            type="button"
            className="icon-btn icon-btn--overlay"
            aria-label="Abrir em janela separada"
            data-tooltip="Janela separada"
            onClick={onPopout}
          >
            <PopOutIcon size={18} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--overlay"
            aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            data-tooltip={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F11)'}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <ExitFullscreenIcon size={18} /> : <FullscreenIcon size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MiniTileProps {
  stream: RemoteStream;
  onSelect(): void;
  /** Right click: opens the watched-live menu. */
  onContextMenu(event: MouseEvent<HTMLElement>): void;
  /** ContextMenu key / Shift+F10 while the tile has the focus. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

/**
 * A watched live in the strip (lowest simulcast layer, no audio); clicking only swaps it onto
 * the stage, it never subscribes anything new.
 */
export function MiniStreamTile({ stream, onSelect, onContextMenu, onKeyDown }: MiniTileProps) {
  return (
    <button
      type="button"
      className="tile tile--mini"
      aria-label={`Destacar a transmissão de ${stream.name}`}
      aria-haspopup="menu"
      aria-keyshortcuts="Shift+F10 ContextMenu"
      data-tooltip="Clique para destacar · botão direito: opções"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <VideoSurface track={stream.videoTrack} className="tile__video" />
      <StreamStatus stream={stream} compact />
      <div className="tile__top tile__top--mini">
        <Avatar id={stream.participantId} name={stream.name} src={stream.avatarUrl} size="xs" />
        <span className="tile__name">{stream.name}</span>
        <QualityBars quality={stream.quality} size={14} />
      </div>
    </button>
  );
}
