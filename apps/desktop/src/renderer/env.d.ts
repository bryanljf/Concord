/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default telao-api URL baked in at build time (`VITE_DEFAULT_SERVER=https://...`). */
  readonly VITE_DEFAULT_SERVER?: string;
}
