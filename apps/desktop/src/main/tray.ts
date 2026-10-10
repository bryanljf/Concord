import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import type { StreamingState } from '../preload/api';
import { log } from './log';
import type { TrayState, TrayStatus } from './presence-controller';
import { resourcePath } from './resources';
import type { SettingsStore } from './settings';
import { INACTIVE_STREAMING_STATE, streamingTrayDetail } from './streaming';

const logger = log('tray');

export interface TrayDeps {
  settings: SettingsStore;
  onOpen(): void;
  onToggle(): void;
  /** "Transmitir…" and "Parar transmissão": the renderer owns the actual toggle. */
  onStreamToggle(): void;
  onOpenSettings(): void;
  onQuit(): void;
}

export interface TrayHandle {
  /** Presence-derived state (someone else live, connected, offline). */
  setPresenceStatus(status: TrayStatus): void;
  /** What this instance is publishing; wins over presence while active. */
  setStreamingState(state: StreamingState): void;
  destroy(): void;
}

export function trayTooltip(status: TrayStatus): string {
  switch (status.state) {
    case 'offline':
      return 'Concord — desconectado';
    case 'idle':
      return 'Concord — conectado';
    case 'live':
      return `Concord — ${status.detail ?? 'alguém ao vivo'}`;
  }
}

/** Our own transmission shows as `live` regardless of the presence connection (pure). */
export function resolveTrayStatus(presence: TrayStatus, streaming: StreamingState): TrayStatus {
  if (!streaming.active) return presence;
  return { state: 'live', detail: streamingTrayDetail(streaming) };
}

function loadIcon(state: TrayState): NativeImage {
  // `nativeImage.createFromPath` also picks up the `@2x` sibling for high-DPI displays.
  const path = resourcePath('tray', `${state}.png`);
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) logger.warn(`tray icon missing or unreadable: ${path}`);
  return image;
}

export function createTray(deps: TrayDeps): TrayHandle {
  const icons: Record<TrayState, NativeImage> = {
    offline: loadIcon('offline'),
    idle: loadIcon('idle'),
    live: loadIcon('live'),
  };
  let presence: TrayStatus = { state: 'offline', detail: null };
  let streaming: StreamingState = INACTIVE_STREAMING_STATE;

  const tray = new Tray(icons.offline);
  tray.setToolTip(trayTooltip(presence));

  function buildMenu(): Menu {
    const settings = deps.settings.get();
    const template: MenuItemConstructorOptions[] = [
      { label: 'Abrir Concord', click: () => deps.onOpen() },
      { label: 'Transmitir…', enabled: !streaming.active, click: () => deps.onStreamToggle() },
      {
        label: 'Parar transmissão',
        visible: streaming.active,
        enabled: streaming.active,
        click: () => deps.onStreamToggle(),
      },
      { type: 'separator' },
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        checked: settings.launchAtLogin,
        click: (item) => deps.settings.update({ launchAtLogin: item.checked }),
      },
      {
        label: 'Abrir junto com o Discord',
        type: 'checkbox',
        checked: settings.followDiscord,
        click: (item) => deps.settings.update({ followDiscord: item.checked }),
      },
      { label: 'Configurações', click: () => deps.onOpenSettings() },
      { type: 'separator' },
      { label: 'Sair', click: () => deps.onQuit() },
    ];
    return Menu.buildFromTemplate(template);
  }

  function refresh(): void {
    const status = resolveTrayStatus(presence, streaming);
    tray.setImage(icons[status.state]);
    tray.setToolTip(trayTooltip(status));
  }

  tray.setContextMenu(buildMenu());
  const unsubscribe = deps.settings.onChange((next, previous) => {
    if (
      next.launchAtLogin !== previous.launchAtLogin ||
      next.followDiscord !== previous.followDiscord
    ) {
      tray.setContextMenu(buildMenu());
    }
  });

  tray.on('click', () => deps.onToggle());
  tray.on('double-click', () => deps.onOpen());
  logger.info('tray created');

  return {
    setPresenceStatus(status) {
      presence = status;
      refresh();
    },
    setStreamingState(state) {
      const activeChanged = state.active !== streaming.active;
      streaming = state;
      refresh();
      if (activeChanged) tray.setContextMenu(buildMenu());
    },
    destroy() {
      unsubscribe();
      tray.destroy();
    },
  };
}
