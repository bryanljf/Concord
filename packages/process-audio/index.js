'use strict';

/**
 * Loads the prebuilt native addon (see index.d.ts). Returns null instead of throwing so the
 * desktop app can fall back to system loopback audio when the binary is missing.
 */
function load() {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-gyp-build')(__dirname);
  } catch {
    return null;
  }
}

module.exports = { load };
