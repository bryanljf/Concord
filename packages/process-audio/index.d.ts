/**
 * Native binding contract (Phase 3b). Implemented by `src/addon.cc` and loaded through
 * `node-gyp-build` from `prebuilds/`. When no prebuilt binary matches, `load()` returns null.
 */
export interface NativeCaptureOptions {
  /** Target process id. */
  pid: number;
  /** `include`: only this process tree; `exclude`: everything but this process tree. */
  mode: 'include' | 'exclude';
}

export interface NativeCaptureFormat {
  sampleRate: number;
  channels: number;
}

export interface NativeCapture {
  /** Starts delivering interleaved float32 PCM chunks until `stop()`. */
  start(options: NativeCaptureOptions, onData: (chunk: Float32Array) => void): NativeCaptureFormat;
  stop(): void;
}

export interface ProcessAudioNative {
  /** True on Windows 10 2004+ where Process Loopback exists. */
  isSupported(): boolean;
  /** Owning process id of a top-level window handle, or 0 when it cannot be resolved. */
  windowProcessId(hwnd: number): number;
  createCapture(): NativeCapture;
}

/** Loads the prebuilt addon for this platform/ABI, or returns null when unavailable. */
export function load(): ProcessAudioNative | null;
