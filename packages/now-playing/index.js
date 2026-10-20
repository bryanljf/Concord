'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS entry loaded directly by Node/Electron */

/**
 * Adapter between Concord and `@coooookies/windows-smtc-monitor`
 * (https://github.com/LeagueTavern/node-windows-smtc-monitor, MIT): what each app is playing, read
 * from the Windows System Media Transport Controls (Rust/napi-rs, prebuilt win32 binaries).
 * Deliberately thin: it only loads the module or reports that it is unavailable. The module locks
 * the thread that uses it, so Concord runs it in a utility process, never on Electron's main
 * thread (see README.md).
 */

/** `PlaybackInfo.playbackStatus` values (GlobalSystemMediaTransportControlsSessionPlaybackStatus). */
const PLAYBACK_STATUS = Object.freeze({
  CLOSED: 0,
  OPENED: 1,
  CHANGING: 2,
  STOPPED: 3,
  PLAYING: 4,
  PAUSED: 5,
});

/**
 * Returns the `SMTCMonitor` class, or null off Windows and when the package or its prebuilt binary
 * cannot be loaded (it is an optional dependency).
 */
function load(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return null;

  let mod;
  try {
    mod = options.requireMonitor
      ? options.requireMonitor()
      : require('@coooookies/windows-smtc-monitor');
  } catch {
    return null;
  }
  const monitor = mod && mod.SMTCMonitor;
  if (typeof monitor !== 'function' || typeof monitor.getMediaSessions !== 'function') return null;
  return monitor;
}

module.exports = { load, PLAYBACK_STATUS };
