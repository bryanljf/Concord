/**
 * Native capture contract (Phase 3b). Implemented by `index.js` on top of the `loopback-capture`
 * npm addon (WASAPI Process Loopback, prebuilt win32-x64, N-API 9). `load()` returns null when the
 * addon is absent so the desktop app can fall back to Electron's system loopback audio.
 */
export type NativeCaptureMode = 'include' | 'exclude';

export interface NativeCaptureOptions {
  /** Target process id (must be > 0; Windows rejects 0 with E_INVALIDARG). */
  pid: number;
  /** `include`: only this process tree; `exclude`: everything but this process tree. */
  mode: NativeCaptureMode;
}

export interface NativeCaptureFormat {
  sampleRate: number;
  channels: number;
}

/** Error thrown by `NativeCapture.start()`/`stop()`; `hresult` is parsed from the addon message. */
export interface NativeCaptureError extends Error {
  name: 'NativeCaptureError';
  hresult: number | null;
}

export interface NativeCapture {
  /**
   * Starts delivering interleaved float32 PCM chunks (10 ms each; silent packets are not
   * delivered by the addon) until `stop()`. Synchronous: activation completes before it returns.
   * Throws a `NativeCaptureError` when Windows refuses the activation.
   */
  start(options: NativeCaptureOptions, onData: (chunk: Float32Array) => void): NativeCaptureFormat;
  /** Stops the capture; late chunks are dropped. Safe to call twice. */
  stop(): Promise<void>;
  readonly running: boolean;
}

export interface ProcessAudioNative {
  /** True on Windows 10 2004 (build 19041) or newer, where Process Loopback exists. */
  isSupported(): boolean;
  /** Windows build number taken from `os.release()`, 0 when it cannot be parsed. */
  windowsBuild(): number;
  createCapture(): NativeCapture;
}

/** Overrides used by tests; production callers pass nothing. */
export interface LoadOptions {
  platform?: string;
  arch?: string;
  /** `os.release()` replacement, e.g. "10.0.26200". */
  release?: string;
  /** Replaces `require('loopback-capture')`. */
  requireAddon?: () => unknown;
}

/** Loads the prebuilt addon for this platform (win32 x64 only), or returns null when unavailable. */
export function load(options?: LoadOptions): ProcessAudioNative | null;

/** Fixed output format of the addon (it asks WASAPI to convert to 48 kHz stereo). */
export const FORMAT: NativeCaptureFormat;
export const MIN_WINDOWS_BUILD: number;

// --- Helpers exported for unit tests -------------------------------------------------------
export function windowsBuildFromRelease(release: string): number;
export function hresultFromMessage(message: string): number | null;
export function pcm16ToFloat32(buffer: Uint8Array): Float32Array;
