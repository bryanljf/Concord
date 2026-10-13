/** Empty unless a build sets `VITE_DEFAULT_SERVER`: the server address is shared privately. */
export const DEFAULT_SERVER_URL: string = import.meta.env.VITE_DEFAULT_SERVER ?? '';

/** Electron accelerator that starts/stops streaming (mirrors the main-process default). */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+L';

/** Public repository (Settings → Sobre → "Projeto no GitHub"). */
export const PROJECT_URL = 'https://github.com/bryanljf/Concord';
