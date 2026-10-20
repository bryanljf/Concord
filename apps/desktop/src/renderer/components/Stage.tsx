import {
  useCallback,
  useMemo,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { RoomId } from '@concord/shared';
import type { BroadcastState } from '../hooks/useBroadcast';
import type { CameraState } from '../hooks/useCamera';
import { useContextMenu } from '../hooks/useContextMenu';
import { useElementSize } from '../hooks/useElementSize';
import type { RemoteStream } from '../hooks/useRemoteStreams';
import type { RoomConnectionState } from '../hooks/useRoom';
import type { StreamAudio } from '../hooks/useStreamAudio';
import {
  localPreviewMenuItems,
  watchMenuItems,
  type WatchMenuAction,
  type WatchedTileKind,
} from '../lib/contextMenu';
import { fitGrid } from '../lib/gridLayout';
import type { StageLayout, StripItem, WatchedTile } from '../lib/stageLayout';
import { liveCardsTitle, stageTitles } from '../lib/stageText';
import type { StreamKind } from '../lib/streamKey';
import type { Viewer } from '../lib/viewers';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Spinner } from './Spinner';
import { FocusedStreamTile, GridSlotTile, GridStreamTile, MiniStreamTile } from './StreamTile';
import { HeadphonesIcon, MonitorOffIcon, SpeakerIcon, WarningIcon } from './icons';
import { ElsewhereTile } from './stream/ElsewhereTile';
import { LiveCard } from './stream/LiveCard';
import { MusicCard, type MusicCardItem } from './music/MusicCard';
import { LocalCameraTile } from './stream/LocalCameraTile';
import { LocalPreviewTile } from './stream/LocalPreviewTile';
import '../styles/stage.css';

/** What "Estatísticas da transmissão" was opened on: a watched stream or one of your previews. */
export type StatsRequest = { kind: 'remote'; key: string } | { kind: 'local'; source: StreamKind };

interface StageProps {
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /** Remote screen shares and webcams in the room (from livekit), subscribed or not. */
  streams: RemoteStream[];
  /** What goes where (computed by the Workspace, whose hotkeys and header use it too). */
  layout: StageLayout;
  /** Who watches each remote stream, by stream key. */
  viewers: ReadonlyMap<string, readonly Viewer[]>;
  /** Who watches your own screen share. */
  localViewers: readonly Viewer[];
  /** Who watches your own webcam. */
  localCameraViewers: readonly Viewer[];
  broadcast: BroadcastState;
  camera: CameraState;
  audio: StreamAudio;
  /** False when playback was blocked until a user gesture. */
  audioPlayback: boolean;
  /** The cameras' picture-in-picture window is open. */
  pipOpen: boolean;
  fullscreen: boolean;
  /** Shortcut already formatted for display, e.g. "Ctrl+Shift+L". */
  shortcutLabel: string;
  /** Overlays positioned inside the stage (the statistics panel). */
  children?: ReactNode;
  /** "Assistir": subscribe and add to the grid (in destaque, a screen share also takes it). */
  onWatch(key: string): void;
  /** "Parar de assistir": unsubscribe video and audio. */
  onUnwatch(key: string): void;
  /** Grid/mini tile click, "Colocar em destaque". */
  onFocus(key: string): void;
  /** "Voltar à grade". */
  onShowGrid(): void;
  onRetry(): void;
  onToggleFullscreen(): void;
  onPopout(participantId: string): void;
  /** "Trazer de volta": closes the pop-out, the live plays here again. */
  onClosePopout(): void;
  /** "Mostrar janela": brings the pop-out to the front. */
  onShowPopout(): void;
  /** "Abrir câmeras em picture-in-picture". */
  onOpenPip(): void;
  onClosePip(): void;
  /** "Estatísticas da transmissão". */
  onStats(request: StatsRequest): void;
  onEnableAudio(): void;
  /** "Transmitir" in the free cell of the grid. */
  onStream(): void;
  onStopBroadcast(): void;
  /** "Trocar fonte" from your screen preview's menu or the free cell of the grid. */
  onSwitchSource(): void;
  /** "Desligar câmera". */
  onStopCamera(): void;
  /** "Escolher câmera…": Settings on the camera section. */
  onPickCamera(): void;
  /** Music broadcasts in the room (yours excluded): cards with "Ouvir", like lives' cards. */
  musicCards: readonly MusicCardItem[];
  onListen(participantId: string): void;
  onStopListening(participantId: string): void;
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: 'default' | 'error';
}

/** A watched stream (by key and where its tile sits), or one of your own previews. */
type MenuTarget =
  { kind: 'watched'; tile: WatchedTileKind; key: string } | { kind: 'local'; source: StreamKind };

const NO_VIEWERS: readonly Viewer[] = [];

/** Pixels between grid tiles (matches the stage gap). */
const GRID_GAP = 12;

function EmptyState({ icon, title, children, tone = 'default' }: EmptyStateProps) {
  return (
    <div
      className={tone === 'error' ? 'stage__empty stage__empty--error' : 'stage__empty'}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <div className="stage__icon">{icon}</div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

interface StageGridProps {
  /** Grid tiles, in order; the free slot (if any) goes last. */
  tiles: ReactNode[];
  slot: ReactNode | null;
}

/** 2 columns of equal 16:9 tiles, the largest that fit, centered in the stage. */
function StageGrid({ tiles, slot }: StageGridProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const fit = fitGrid(tiles.length, size.width, size.height, GRID_GAP);
  const style: CSSProperties = {
    gridTemplateColumns: `repeat(${fit.cols}, ${fit.tileWidth}px)`,
    gridAutoRows: `${fit.tileHeight}px`,
    gap: `${GRID_GAP}px`,
  };
  return (
    <div ref={ref} className="stage__grid">
      <ul className="stage__grid-cells" style={style} aria-label="Transmissões assistidas">
        {tiles}
        {fit.slot && slot && <li key="slot">{slot}</li>}
      </ul>
    </div>
  );
}

/** Where the focus goes when the tile that opened the menu is gone. */
function focusedTileElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-focused-live]');
}

interface RenderedTile {
  tile: WatchedTileKind;
  elsewhere: boolean;
}

/** Which watched tiles are on screen right now, by key (a menu only lives while its tile does). */
function renderedTiles(layout: StageLayout): Map<string, RenderedTile> {
  const tiles = new Map<string, RenderedTile>();
  if (layout.main.kind === 'focus') {
    tiles.set(layout.main.tile.key, { tile: 'focused', elsewhere: layout.main.tile.elsewhere });
  }
  if (layout.main.kind === 'grid') {
    for (const { key, elsewhere } of layout.main.tiles) tiles.set(key, { tile: 'grid', elsewhere });
  }
  for (const item of layout.strip) {
    if (item.kind === 'mini') {
      tiles.set(item.tile.key, { tile: 'mini', elsewhere: item.tile.elsewhere });
    }
  }
  return tiles;
}

export function Stage({
  currentRoom,
  connectionState,
  error,
  streams,
  layout,
  viewers,
  localViewers,
  localCameraViewers,
  broadcast,
  camera,
  audio,
  audioPlayback,
  pipOpen,
  fullscreen,
  shortcutLabel,
  children,
  onWatch,
  onUnwatch,
  onFocus,
  onShowGrid,
  onRetry,
  onToggleFullscreen,
  onPopout,
  onClosePopout,
  onShowPopout,
  onOpenPip,
  onClosePip,
  onStats,
  onEnableAudio,
  onStream,
  onStopBroadcast,
  onSwitchSource,
  onStopCamera,
  onPickCamera,
  musicCards,
  onListen,
  onStopListening,
}: StageProps) {
  const contextMenu = useContextMenu<MenuTarget>(focusedTileElement);
  const byKey = useMemo(() => new Map(streams.map((stream) => [stream.key, stream])), [streams]);

  const runMenuAction = useCallback(
    (action: WatchMenuAction, stream: RemoteStream) => {
      switch (action) {
        case 'focus':
          onFocus(stream.key);
          break;
        case 'grid':
          onShowGrid();
          break;
        case 'popout':
          onPopout(stream.participantId);
          break;
        case 'return':
          onClosePopout();
          break;
        case 'pip-open':
          onOpenPip();
          break;
        case 'pip-close':
          onClosePip();
          break;
        case 'mute':
          audio.setMuted(stream.participantId, true);
          break;
        case 'unmute':
          audio.setMuted(stream.participantId, false);
          break;
        case 'stats':
          onStats({ kind: 'remote', key: stream.key });
          break;
        case 'stop':
          onUnwatch(stream.key);
          break;
      }
    },
    [
      audio,
      onFocus,
      onShowGrid,
      onPopout,
      onClosePopout,
      onOpenPip,
      onClosePip,
      onStats,
      onUnwatch,
    ],
  );

  if (!currentRoom) {
    return (
      <div className="stage">
        <EmptyState icon={<SpeakerIcon size={64} />} title="Escolha uma sala na barra lateral">
          <p>
            Entrar numa sala não assina nenhum vídeo automaticamente — você escolhe o que assistir.
          </p>
        </EmptyState>
      </div>
    );
  }

  const titles = stageTitles(currentRoom);

  if (error) {
    return (
      <div className="stage">
        <EmptyState tone="error" icon={<WarningIcon size={64} />} title={titles.failed}>
          <p>{error}</p>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Tentar de novo
          </button>
        </EmptyState>
      </div>
    );
  }

  if (connectionState === 'connecting' || connectionState === 'disconnected') {
    return (
      <div className="stage">
        <EmptyState icon={<Spinner label="Conectando" />} title={titles.joining} />
      </div>
    );
  }

  const live = broadcast.status === 'live';
  const stageClass = live ? 'stage stage--live' : 'stage';
  // Blocked playback matters as soon as any subscribed screen share carries audio.
  const audioBlocked =
    !audioPlayback &&
    streams.some((stream) => stream.kind === 'screen' && stream.audioTrack !== null);

  // The menu only exists while its target is still there (a watched stream that ended or moved,
  // or a preview that stopped, closes it).
  const menu = contextMenu.menu;
  const target = menu?.target ?? null;
  let menuLabel = '';
  let menuItems: ContextMenuItem[] = [];
  if (target?.kind === 'local') {
    const present = target.source === 'screen' ? live : camera.status === 'on';
    if (present) {
      menuLabel = target.source === 'screen' ? 'Opções da sua transmissão' : 'Opções da sua câmera';
      const handlers = {
        switch: onSwitchSource,
        'pick-camera': onPickCamera,
        stats: () => onStats({ kind: 'local', source: target.source }),
        'stop-broadcast': onStopBroadcast,
        'stop-camera': onStopCamera,
      };
      menuItems = localPreviewMenuItems(target.source).map((item) => ({
        id: item.action,
        label: item.label,
        danger: item.danger,
        separatorBefore: item.separatorBefore,
        onSelect: handlers[item.action],
      }));
    }
  } else if (target) {
    const rendered = renderedTiles(layout).get(target.key);
    const stream = rendered?.tile === target.tile ? byKey.get(target.key) : undefined;
    if (stream && rendered) {
      menuLabel =
        stream.kind === 'camera'
          ? `Opções da câmera de ${stream.name}`
          : `Opções da transmissão de ${stream.name}`;
      menuItems = watchMenuItems({
        tile: target.tile,
        kind: stream.kind,
        muted: audio.settingFor(stream.participantId).muted,
        hasAudio: stream.audio !== null,
        canShowGrid: layout.canShowGrid,
        pipOpen,
        elsewhere: rendered.elsewhere,
      }).map((item) => ({
        id: item.action,
        label: item.label,
        danger: item.danger,
        separatorBefore: item.separatorBefore,
        onSelect: () => runMenuAction(item.action, stream),
      }));
    }
  }

  const menuHandlers = (menuTarget: MenuTarget) => ({
    onContextMenu: (event: MouseEvent<HTMLElement>) => contextMenu.onContextMenu(event, menuTarget),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => contextMenu.onKeyDown(event, menuTarget),
  });
  const watchedMenu = (tile: WatchedTileKind, key: string) =>
    menuHandlers({ kind: 'watched', tile, key });

  /** A watched stream shown by another window: the notice and the way back. */
  const elsewhereTile = (stream: RemoteStream, variant: WatchedTileKind) => (
    <ElsewhereTile
      stream={stream}
      variant={variant}
      onBringBack={stream.kind === 'camera' ? onClosePip : onClosePopout}
      onShowWindow={stream.kind === 'camera' ? undefined : onShowPopout}
      onStopWatching={() => onUnwatch(stream.key)}
      {...watchedMenu(variant, stream.key)}
    />
  );

  const localScreenTile = (focused: boolean) =>
    broadcast.status === 'live' ? (
      <LocalPreviewTile
        track={broadcast.videoTrack}
        sourceName={broadcast.sourceName}
        quality={broadcast.quality}
        hasAudio={broadcast.hasAudio}
        viewers={localViewers}
        focused={focused}
        onStop={onStopBroadcast}
        {...menuHandlers({ kind: 'local', source: 'screen' })}
      />
    ) : null;

  const localCameraTile = (focused: boolean) =>
    camera.status === 'on' ? (
      <LocalCameraTile
        track={camera.track}
        label={camera.label}
        viewers={localCameraViewers}
        focused={focused}
        onStop={onStopCamera}
        {...menuHandlers({ kind: 'local', source: 'camera' })}
      />
    ) : null;

  const focusedTile = (tile: WatchedTile) => {
    const stream = byKey.get(tile.key);
    if (!stream) return null;
    if (tile.elsewhere) return elsewhereTile(stream, 'focused');
    // Volume and mute only exist for a screen share with audio; "another window" is the pop-out
    // for a screen share and the cameras' picture-in-picture for a webcam.
    const screen = stream.kind === 'screen';
    const withAudio = screen && stream.audio !== null;
    return (
      <FocusedStreamTile
        key={stream.key}
        stream={stream}
        viewers={viewers.get(stream.key) ?? NO_VIEWERS}
        volume={withAudio ? audio.settingFor(stream.participantId) : undefined}
        onVolume={withAudio ? (volume) => audio.setVolume(stream.participantId, volume) : undefined}
        onToggleMute={withAudio ? () => audio.toggleMute(stream.participantId) : undefined}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onPopout={screen ? () => onPopout(stream.participantId) : onOpenPip}
        onStopWatching={() => onUnwatch(stream.key)}
        onShowGrid={layout.canShowGrid ? onShowGrid : undefined}
        {...watchedMenu('focused', stream.key)}
      />
    );
  };

  const musicCardOf = (item: MusicCardItem, size: 'stage' | 'strip') => (
    <MusicCard
      item={item}
      size={size}
      onListen={() => onListen(item.participantId)}
      onStopListening={() => onStopListening(item.participantId)}
    />
  );

  const cardOf = (key: string, size: 'stage' | 'strip') => {
    const stream = byKey.get(key);
    if (!stream) return null;
    return (
      <LiveCard
        participantId={stream.participantId}
        name={stream.name}
        avatarUrl={stream.avatarUrl}
        kind={stream.kind}
        size={size}
        onWatch={() => onWatch(stream.key)}
      />
    );
  };

  // Cards of lives and cameras nobody picked, plus the music in the room (yours excluded).
  const cameraCards = layout.cards.filter((key) => byKey.get(key)?.kind === 'camera').length;
  const cardsSection = (
    <section className="stage__cards" aria-labelledby="stage-cards-title">
      <header className="stage__cards-header">
        <h2 id="stage-cards-title">
          {liveCardsTitle(
            {
              screens: layout.cards.length - cameraCards,
              cameras: cameraCards,
              music: musicCards.length,
            },
            currentRoom,
          )}
        </h2>
        <p>
          {musicCards.length > 0
            ? 'Nada é baixado até você clicar em Assistir ou Ouvir.'
            : 'Nenhum vídeo é recebido até você clicar em Assistir.'}
        </p>
      </header>
      <ul className="stage__cards-grid">
        {layout.cards.map((key) => (
          <li key={key}>{cardOf(key, 'stage')}</li>
        ))}
        {musicCards.map((item) => (
          <li key={`music-${item.participantId}`}>{musicCardOf(item, 'stage')}</li>
        ))}
      </ul>
    </section>
  );
  // With something on the stage, the music cards wait in the strip (like the lives' cards).
  const musicOnStage = layout.main.kind === 'cards' || layout.main.kind === 'empty';
  const stripMusic = musicOnStage || fullscreen ? [] : musicCards;

  let main: ReactNode;
  switch (layout.main.kind) {
    case 'focus':
      main = <div className="stage__focus">{focusedTile(layout.main.tile)}</div>;
      break;
    case 'grid': {
      const tiles = layout.main.tiles.map((tile) => {
        const stream = byKey.get(tile.key);
        if (!stream) return null;
        const withAudio = stream.kind === 'screen' && stream.audio !== null;
        return (
          <li key={tile.key}>
            {tile.elsewhere ? (
              elsewhereTile(stream, 'grid')
            ) : (
              <GridStreamTile
                stream={stream}
                viewers={viewers.get(stream.key) ?? NO_VIEWERS}
                onSelect={() => onFocus(stream.key)}
                onStopWatching={() => onUnwatch(stream.key)}
                volume={withAudio ? audio.settingFor(stream.participantId) : undefined}
                onVolume={
                  withAudio ? (volume) => audio.setVolume(stream.participantId, volume) : undefined
                }
                onToggleMute={withAudio ? () => audio.toggleMute(stream.participantId) : undefined}
                {...watchedMenu('grid', stream.key)}
              />
            )}
          </li>
        );
      });
      main = (
        <StageGrid
          tiles={tiles}
          slot={
            layout.main.slot ? (
              <GridSlotTile
                live={live}
                busy={broadcast.status === 'starting' || broadcast.status === 'stopping'}
                onStream={onStream}
                onSwitch={onSwitchSource}
              />
            ) : null
          }
        />
      );
      break;
    }
    case 'local':
      main = (
        <div className="stage__focus">
          {layout.main.source === 'screen' ? localScreenTile(true) : localCameraTile(true)}
        </div>
      );
      break;
    case 'cards':
      main = cardsSection;
      break;
    case 'empty':
      // Only music in the room: its cards take the stage instead of "Ninguém está transmitindo".
      if (musicCards.length > 0) {
        main = cardsSection;
        break;
      }
      main = (
        <EmptyState icon={<MonitorOffIcon size={64} />} title={titles.nobodyLive}>
          <p>
            Pressione <kbd>{shortcutLabel}</kbd> ou clique em <strong>Transmitir</strong> para
            compartilhar sua tela.
          </p>
        </EmptyState>
      );
      break;
  }

  const stripItem = (item: StripItem): ReactNode => {
    switch (item.kind) {
      case 'local':
        return (
          <li key={`local-${item.source}`}>
            {item.source === 'screen' ? localScreenTile(false) : localCameraTile(false)}
          </li>
        );
      case 'mini': {
        const stream = byKey.get(item.tile.key);
        if (!stream) return null;
        return (
          <li key={stream.key}>
            {item.tile.elsewhere ? (
              elsewhereTile(stream, 'mini')
            ) : (
              <MiniStreamTile
                stream={stream}
                onSelect={() => onFocus(stream.key)}
                onStopWatching={() => onUnwatch(stream.key)}
                {...watchedMenu('mini', stream.key)}
              />
            )}
          </li>
        );
      }
      case 'card':
        return <li key={`card-${item.key}`}>{cardOf(item.key, 'strip')}</li>;
    }
  };

  return (
    <div className={stageClass}>
      {connectionState === 'reconnecting' && (
        <div className="stage__notice stage__notice--warning" role="status">
          <Spinner size="sm" label="Reconectando" />
          Reconectando à sala…
        </div>
      )}
      {audioBlocked && (
        <button
          type="button"
          className="stage__notice stage__notice--action"
          onClick={onEnableAudio}
        >
          <HeadphonesIcon size={16} />
          Clique para ativar o áudio das transmissões
        </button>
      )}
      {live && (
        <div className="stage__live-pill" role="status">
          <span className="stage__live-dot" aria-hidden="true" />
          VOCÊ ESTÁ AO VIVO
        </div>
      )}
      {broadcast.status === 'starting' && (
        <div className="stage__notice" role="status">
          <Spinner size="sm" label="Iniciando" />
          Iniciando a transmissão de {broadcast.sourceName}…
        </div>
      )}

      {main}

      {(layout.strip.length > 0 || stripMusic.length > 0) && (
        <ul className="stage__strip" aria-label="Outras transmissões">
          {layout.strip.map(stripItem)}
          {stripMusic.map((item) => (
            <li key={`music-${item.participantId}`}>{musicCardOf(item, 'strip')}</li>
          ))}
        </ul>
      )}

      {children}

      {menu && menuItems.length > 0 && (
        <ContextMenu
          point={menu.point}
          label={menuLabel}
          items={menuItems}
          onClose={contextMenu.close}
        />
      )}
    </div>
  );
}
