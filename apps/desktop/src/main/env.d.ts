/// <reference types="electron-vite/node" />

/** Build-time variables exposed by electron-vite to the main process (`VITE_` / `MAIN_VITE_`). */
interface ImportMetaEnv {
  /** Default concord-api URL baked into the build (SPEC 5.3). */
  readonly VITE_DEFAULT_SERVER?: string;
}
