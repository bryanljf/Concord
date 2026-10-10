'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS entry loaded directly by Node/Electron */

/**
 * Adapter between Concord's native capture contract (index.d.ts) and the `loopback-capture` addon
 * (https://github.com/WerdoxDev/loopback-capture, MIT): WASAPI Process Loopback with a prebuilt
 * win32-x64 N-API binary. The addon delivers 16-bit PCM Buffers; this module converts them to
 * float32, validates inputs and normalises errors. See README.md for the research and decision.
 */
const os = require('node:os');

const FORMAT = Object.freeze({ sampleRate: 48000, channels: 2 });
/** Windows 10 2004. Microsoft's docs list build 20348 for the header, the API shipped in 19041. */
const MIN_WINDOWS_BUILD = 19041;
/**
 * The addon's stop() reports E_NOT_VALID_STATE while its "start capture" work item is still
 * queued and would then orphan a running capture; keeping every capture alive for at least this
 * long closes that window.
 */
const MIN_RUN_MS = 100;

function windowsBuildFromRelease(release) {
  const match = /^\d+\.\d+\.(\d+)/.exec(release);
  return match ? Number(match[1]) : 0;
}

function hresultFromMessage(message) {
  const match = /HRESULT\s+0x([0-9A-Fa-f]{8})/.exec(message);
  return match ? Number.parseInt(match[1], 16) : null;
}

function toNativeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const error = new Error(message);
  error.name = 'NativeCaptureError';
  error.hresult = hresultFromMessage(message);
  return error;
}

function pcm16ToFloat32(buffer) {
  const samples = buffer.byteLength >> 1;
  const out = new Float32Array(samples);
  if (buffer.byteOffset % 2 === 0) {
    const view = new Int16Array(buffer.buffer, buffer.byteOffset, samples);
    for (let i = 0; i < samples; i += 1) out[i] = view[i] / 32768;
    return out;
  }
  const bytes = new DataView(buffer.buffer, buffer.byteOffset, samples * 2);
  for (let i = 0; i < samples; i += 1) out[i] = bytes.getInt16(i * 2, true) / 32768;
  return out;
}

function createCapture(addon) {
  let instance = null;
  let startedAt = 0;

  return {
    get running() {
      return instance !== null;
    },

    start(options, onData) {
      if (instance) throw new Error('A capture is already running on this instance.');
      const pid = options && options.pid;
      const mode = options && options.mode;
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new RangeError(`Invalid process id for process loopback: ${String(pid)}`);
      }
      if (mode !== 'include' && mode !== 'exclude') {
        throw new RangeError(`Invalid process loopback mode: ${String(mode)}`);
      }
      if (typeof onData !== 'function') throw new TypeError('onData must be a function');

      const capture = new addon.LoopbackCapture();
      try {
        capture.start(pid, mode === 'include', (chunk) => {
          // Chunks still queued when stop() ran must not reach the consumer.
          if (instance === capture) onData(pcm16ToFloat32(chunk));
        });
      } catch (err) {
        throw toNativeError(err);
      }
      instance = capture;
      startedAt = Date.now();
      return { ...FORMAT };
    },

    async stop() {
      const capture = instance;
      if (!capture) return;
      instance = null;
      const remaining = MIN_RUN_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      try {
        capture.stop();
      } catch (err) {
        throw toNativeError(err);
      }
    },
  };
}

function load(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== 'win32' || arch !== 'x64') return null;

  let addon;
  try {
    addon = options.requireAddon ? options.requireAddon() : require('loopback-capture');
  } catch {
    return null;
  }
  if (!addon || typeof addon.LoopbackCapture !== 'function') return null;

  const build = windowsBuildFromRelease(options.release || os.release());
  return {
    isSupported: () => build >= MIN_WINDOWS_BUILD,
    windowsBuild: () => build,
    createCapture: () => createCapture(addon),
  };
}

module.exports = {
  load,
  FORMAT,
  MIN_WINDOWS_BUILD,
  windowsBuildFromRelease,
  hresultFromMessage,
  pcm16ToFloat32,
};
