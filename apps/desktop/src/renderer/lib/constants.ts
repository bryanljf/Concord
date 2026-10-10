/** Fallback telao-api URL when the build did not define `VITE_DEFAULT_SERVER`. */
export const DEFAULT_SERVER_URL: string =
  import.meta.env.VITE_DEFAULT_SERVER ?? 'http://127.0.0.1:3000';

/** Electron accelerator that starts/stops streaming (mirrors the main-process default). */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+L';

// TODO: replace with the real repository URL once it exists (SPEC §13, question 4).
export const PROJECT_URL = 'https://github.com/';
