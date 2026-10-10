import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { log } from './log';
import type { TrayState, TrayStatus } from './presence-controller';
import { resourcePath } from './resources';
import type { SettingsStore } from './settings';

const logger = log('tray');

export interface TrayDeps {
  settings: SettingsStore;
  onOpen(): void;
  onToggle(): void;
  onStreamToggle(): void;
  onOpenSettings(): void;
  onQuit(): void;
}

export interface TrayHandle {
  setStatus(status: TrayStatus): void;
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
  const tray = new Tray(icons.offline);
  tray.setToolTip(trayTooltip({ state: 'offline', detail: null }));

  function buildMenu(): Menu {
    const settings = deps.settings.get();
    const template: MenuItemConstructorOptions[] = [
      { label: 'Abrir Concord', click: () => deps.onOpen() },
      { label: 'Transmitir…', click: () => deps.onStreamToggle() },
      // Streaming arrives in Phase 3; the item exists so the layout is final.
      { label: 'Parar transmissão', visible: false, enabled: false },
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
    setStatus(status) {
      tray.setImage(icons[status.state]);
      tray.setToolTip(trayTooltip(status));
    },
    destroy() {
      unsubscribe();
      tray.destroy();
    },
  };
}
