import { useRef, useState, type ReactNode } from 'react';
import type { StreamQualityId } from '@concord/shared';
import type { BroadcastState } from '../hooks/useBroadcast';
import type { CameraState } from '../hooks/useCamera';
import { useVideoInputs } from '../hooks/useVideoInputs';
import type { Point } from '../lib/contextMenu';
import { streamQualityLabel } from '../lib/encoding';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Spinner } from './Spinner';
import {
  CameraIcon,
  CameraOffIcon,
  ChevronDownIcon,
  GearIcon,
  MonitorIcon,
  MusicIcon,
  StopIcon,
  SwapScreenIcon,
} from './icons';
import '../styles/bottom-bar.css';

interface BottomBarProps {
  /**
   * This client can share its screen (`capabilities.screenShare`): "Transmitir", "Trocar fonte",
   * "Parar" and the quality label. The web client keeps only the camera and the Jam.
   */
  canStream?: boolean;
  /** Default preset from the settings (shown while idle). */
  defaultQuality: StreamQualityId;
  broadcast: BroadcastState;
  /** A source switch is in progress. */
  switching: boolean;
  onStream(): void;
  /** While live the "Transmitir" button becomes "Trocar fonte". */
  onSwitch(): void;
  onStop(): void;
  /** Webcam state (the "Câmera" button and its device list). */
  camera: CameraState;
  /** A camera device switch is in progress. */
  cameraSwitching: boolean;
  /** Connected to a room: the camera can be turned on (disabled otherwise). */
  inRoom: boolean;
  /** `Settings.cameraDeviceId`, checked in the device list (null = system default). */
  cameraDeviceId: string | null;
  onToggleCamera(): void;
  /** A device picked in the list (saved in the settings; switched live when on). */
  onPickCamera(deviceId: string | null): void;
  /** "Configurações da câmera…": opens Settings on the camera section. */
  onCameraSettings(): void;
  /** The server has the Jam: the green "Música" button (hidden otherwise). */
  jamAvailable: boolean;
  /** The Jam's search dialog is open. */
  jamOpen: boolean;
  /** "Música": opens the search to add a song to your room's Jam (needs a room, like the camera). */
  onOpenJam(): void;
}

/** A click on the chevron that just closed the menu (outside pointerdown) must not reopen it. */
const REOPEN_GUARD_MS = 300;

export function BottomBar({
  canStream = true,
  defaultQuality,
  broadcast,
  switching,
  onStream,
  onSwitch,
  onStop,
  camera,
  cameraSwitching,
  inRoom,
  cameraDeviceId,
  onToggleCamera,
  onPickCamera,
  onCameraSettings,
  jamAvailable,
  jamOpen,
  onOpenJam,
}: BottomBarProps) {
  const live = broadcast.status === 'live';
  const busy = broadcast.status === 'starting' || broadcast.status === 'stopping' || switching;
  const quality = live ? broadcast.quality : defaultQuality;

  const stopping = broadcast.status === 'stopping';
  return (
    <footer className={live ? 'bottom-bar bottom-bar--live' : 'bottom-bar'}>
      {!canStream ? null : live ? (
        <button
          type="button"
          className={barButtonClass('btn btn--primary', switching)}
          disabled={busy}
          onClick={onSwitch}
        >
          {switching ? <Spinner size="sm" label="Trocando" /> : <SwapScreenIcon size={18} />}
          <BarLabel>{switching ? 'Trocando…' : 'Trocar fonte'}</BarLabel>
        </button>
      ) : (
        <button
          type="button"
          className={barButtonClass('btn btn--primary', broadcast.status === 'starting')}
          disabled={busy}
          onClick={onStream}
        >
          {broadcast.status === 'starting' ? (
            <Spinner size="sm" label="Iniciando" />
          ) : (
            <MonitorIcon size={18} />
          )}
          <BarLabel>{broadcast.status === 'starting' ? 'Iniciando…' : 'Transmitir'}</BarLabel>
        </button>
      )}
      {canStream && (live || stopping) && (
        <button
          type="button"
          className={barButtonClass('btn btn--danger', stopping)}
          disabled={stopping}
          onClick={onStop}
        >
          <StopIcon size={18} />
          <BarLabel>{stopping ? 'Parando…' : 'Parar'}</BarLabel>
        </button>
      )}
      <CameraControl
        camera={camera}
        switching={cameraSwitching}
        inRoom={inRoom}
        deviceId={cameraDeviceId}
        onToggle={onToggleCamera}
        onPick={onPickCamera}
        onSettings={onCameraSettings}
      />
      {jamAvailable && <JamButton inRoom={inRoom} open={jamOpen} onOpen={onOpenJam} />}
      {live && (
        <span className="bottom-bar__live" role="status">
          <span className="bottom-bar__live-dot" aria-hidden="true" />
          AO VIVO · <strong>{broadcast.sourceName}</strong>
        </span>
      )}
      {canStream && (
        <span className="bottom-bar__quality">
          qualidade: <strong>{streamQualityLabel(quality)}</strong>
        </span>
      )}
    </footer>
  );
}

/**
 * Bottom-bar buttons show only their icon; the label slides out on hover or keyboard focus,
 * pushing the next ones aside, and stays out while the action is in progress.
 */
function barButtonClass(base: string, expanded: boolean): string {
  return expanded ? `${base} bar-btn bar-btn--expanded` : `${base} bar-btn`;
}

function BarLabel({ children }: { children: ReactNode }) {
  return <span className="bar-btn__label">{children}</span>;
}

interface JamButtonProps {
  inRoom: boolean;
  open: boolean;
  onOpen(): void;
}

/**
 * "Música": the Jam's way in, shaped like the other buttons (icon only, the label slides out)
 * and green like the music. Needs a room, like the camera.
 */
function JamButton({ inRoom, open, onOpen }: JamButtonProps) {
  return (
    <button
      type="button"
      className={barButtonClass('btn bottom-bar__jam', open)}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={!inRoom}
      // Only the reason it is disabled: the label itself slides out on hover.
      data-tooltip={inRoom ? undefined : 'Entre numa sala para adicionar músicas'}
      onClick={onOpen}
    >
      <MusicIcon size={18} className="bottom-bar__jam-icon" />
      <BarLabel>Música</BarLabel>
    </button>
  );
}

interface CameraControlProps {
  camera: CameraState;
  switching: boolean;
  inRoom: boolean;
  deviceId: string | null;
  onToggle(): void;
  onPick(deviceId: string | null): void;
  onSettings(): void;
}

/** "Câmera" toggle plus a chevron with the device list (split button). */
function CameraControl({
  camera,
  switching,
  inRoom,
  deviceId,
  onToggle,
  onPick,
  onSettings,
}: CameraControlProps) {
  const { devices, refresh } = useVideoInputs();
  const [menuPoint, setMenuPoint] = useState<Point | null>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const closedAt = useRef(0);

  const on = camera.status === 'on';
  const transition = camera.status === 'starting' || camera.status === 'stopping';
  const busy = transition || switching;
  // Turning it off always works; turning it on needs a room.
  const disabled = busy || (!inRoom && camera.status === 'off');

  // Only the reason it is disabled: the label itself slides out on hover.
  const tooltip =
    !inRoom && camera.status === 'off' ? 'Entre numa sala para ligar a câmera' : undefined;

  // The icon shows the action: a plain camera turns it on, a crossed one (on the red button) off.
  let icon = on ? <CameraOffIcon size={18} /> : <CameraIcon size={18} />;
  let label = on ? 'Desligar câmera' : 'Câmera';
  if (camera.status === 'starting') {
    icon = <Spinner size="sm" label="Ligando a câmera" />;
    label = 'Ligando…';
  } else if (camera.status === 'stopping') {
    icon = <Spinner size="sm" label="Desligando a câmera" />;
    label = 'Desligando…';
  } else if (switching) {
    icon = <Spinner size="sm" label="Trocando de câmera" />;
    label = 'Trocando…';
  }

  function openMenu(): void {
    if (menuPoint || performance.now() - closedAt.current < REOPEN_GUARD_MS) return;
    const rect = chevron.current?.getBoundingClientRect();
    if (!rect) return;
    // Names appear once a camera was allowed; list again on every open.
    refresh();
    // Opened just above the chevron: the menu flips up when there is no room below.
    setMenuPoint({ x: rect.left, y: rect.top - 6 });
  }

  function closeMenu(): void {
    closedAt.current = performance.now();
    setMenuPoint(null);
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) chevron.current?.focus({ preventScroll: true });
    });
  }

  const savedMissing = deviceId !== null && !devices.some((device) => device.id === deviceId);
  const items: ContextMenuItem[] = [
    {
      id: 'default',
      label: 'Padrão do sistema',
      checked: deviceId === null,
      onSelect: () => onPick(null),
    },
    ...(savedMissing && deviceId !== null
      ? [
          {
            id: `saved:${deviceId}`,
            label: 'Câmera salva (desconectada)',
            checked: true,
            onSelect: () => onPick(deviceId),
          },
        ]
      : []),
    ...devices.map((device) => ({
      id: `device:${device.id}`,
      label: device.label,
      checked: device.id === deviceId,
      onSelect: () => onPick(device.id),
    })),
    {
      id: 'settings',
      label: 'Configurações da câmera…',
      icon: <GearIcon size={16} />,
      separatorBefore: true,
      onSelect: onSettings,
    },
  ];

  return (
    <div className={on ? 'camera-split camera-split--on' : 'camera-split'}>
      <button
        type="button"
        className={barButtonClass('btn camera-split__toggle', busy)}
        aria-pressed={on}
        disabled={disabled}
        data-tooltip={tooltip}
        onClick={onToggle}
      >
        {icon}
        <BarLabel>{label}</BarLabel>
      </button>
      <button
        ref={chevron}
        type="button"
        className="btn camera-split__menu"
        aria-label="Escolher câmera"
        aria-haspopup="menu"
        aria-expanded={menuPoint !== null}
        disabled={busy}
        data-tooltip={menuPoint ? undefined : 'Escolher câmera'}
        onClick={openMenu}
      >
        <ChevronDownIcon size={16} />
      </button>
      {menuPoint && (
        <ContextMenu point={menuPoint} label="Escolher câmera" items={items} onClose={closeMenu} />
      )}
    </div>
  );
}
