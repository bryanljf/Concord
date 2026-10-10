/**
 * Per-process audio capture (SPEC 5.7, Phase 3b). The real implementation lives in
 * `@concord/process-audio` (Windows Process Loopback); this module is the only thing the rest
 * of the main process talks to, so it can degrade gracefully when the native module is absent.
 */
import type { ProcessAudioFormat, ProcessAudioSupport } from '../../preload/api';

export type ProcessAudioDataListener = (chunk: Float32Array) => void;

export interface ProcessAudioEngine {
  support(): ProcessAudioSupport;
  /**
   * `sourceId` is a `desktopCapturer` id. Windows (`window:<hwnd>:0`) capture only the owning
   * process tree; screens capture everything except Discord's process tree.
   */
  start(sourceId: string, onData: ProcessAudioDataListener): Promise<ProcessAudioFormat>;
  stop(): Promise<void>;
  readonly running: boolean;
}

const UNSUPPORTED: ProcessAudioSupport = {
  supported: false,
  reason: 'Captura de áudio por processo ainda não disponível nesta versão.',
};

/** Placeholder until Phase 3b lands: reports "unsupported" and refuses to start. */
export function createProcessAudioEngine(): ProcessAudioEngine {
  return {
    support: () => UNSUPPORTED,
    start: async () => {
      throw new Error(UNSUPPORTED.reason ?? 'unsupported');
    },
    stop: async () => undefined,
    running: false,
  };
}
