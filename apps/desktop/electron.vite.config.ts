import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

/** Build-time constants shared by main and preload (the sandboxed preload cannot read package.json). */
const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig({
  main: {
    define,
    // @telao/shared ships TS source, so it must be bundled rather than required at runtime.
    build: { externalizeDeps: { exclude: ['@telao/shared'] } },
  },
  preload: {
    define,
    // Sandboxed preloads can't require node_modules: bundle everything.
    build: { externalizeDeps: false },
  },
  renderer: {
    plugins: [react()],
  },
});
