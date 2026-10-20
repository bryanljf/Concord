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
    build: {
      // @concord/shared ships TS source, so it must be bundled rather than required at runtime.
      externalizeDeps: { exclude: ['@concord/shared'] },
      rollupOptions: {
        input: {
          // The main process.
          index: 'src/main/index.ts',
          // Utility process that reads the Windows media sessions (SMTC locks its thread, so it
          // never runs in the main process); forked by src/main/now-playing/index.ts.
          'now-playing-worker': 'src/main/now-playing/worker.ts',
        },
        // CJS / native packages stay `require`d from node_modules (electron-builder packs them
        // and asar-unpacks the native prebuilds); never inline them into the bundles.
        external: [
          'electron-updater',
          '@concord/process-audio',
          '@concord/now-playing',
          '@coooookies/windows-smtc-monitor',
        ],
      },
    },
  },
  preload: {
    define,
    // Sandboxed preloads can't require node_modules: bundle everything.
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          // Bridge of the app windows.
          index: 'src/preload/index.ts',
          // Discord login window only: disables WebAuthn (see the file header).
          oauth: 'src/preload/oauth.ts',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
