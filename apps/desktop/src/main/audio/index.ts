/**
 * Per-process audio capture (Phase 3b). The native side lives in
 * `@concord/process-audio` (WASAPI Process Loopback through the `loopback-capture` addon); this
 * module is the only thing the rest of the main process talks to, so it can degrade gracefully
 * (`support()` explains why in pt-BR) when the native module is absent or Windows is too old.
 *
 * Several captures may run at once, one native instance each, identified by a `captureId`.
 */
import { randomUUID } from 'node:crypto';
import type { NativeCapture, ProcessAudioNative } from '@concord/process-audio';
import type {
  ProcessAudioCapture,
  ProcessAudioSupport,
  ProcessAudioTarget,
} from '../../preload/api';
import { log } from '../log';
import { findDiscordRootPid } from './discord-process';
import { parseCaptureSourceId } from './source-id';
import { getWindowOwnerPid } from './win-process';

const logger = log('audio');

/** Interleaved float32 PCM of one capture. */
export type ProcessAudioDataListener = (captureId: string, chunk: Float32Array) => void;

export interface ProcessAudioEngine {
  support(): ProcessAudioSupport;
  /**
   * Starts a new capture next to any running one. Window sources (`window:<hwnd>:0`) capture only
   * the owning process tree; screens capture everything except Discord's process tree.
   */
  start(target: ProcessAudioTarget, onData: ProcessAudioDataListener): Promise<ProcessAudioCapture>;
  /** Stops one capture; unknown or already stopped ids are ignored. */
  stop(captureId: string): Promise<void>;
  stopAll(): Promise<void>;
  has(captureId: string): boolean;
  /** Number of running captures. */
  readonly size: number;
  readonly running: boolean;
}

export type ProcessAudioErrorCode =
  | 'unsupported'
  | 'invalid_source'
  | 'window_process_unknown'
  /** Screen capture without Discord running: nothing to exclude, so the caller should use loopback. */
  | 'discord_not_running'
  | 'native_failure';

/** `message` is pt-BR and safe to show in the UI; `code` lets callers decide on a fallback. */
export class ProcessAudioError extends Error {
  override readonly name = 'ProcessAudioError';
  constructor(
    readonly code: ProcessAudioErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const MESSAGES = {
  notWindows: 'A captura de áudio por processo só existe no Windows.',
  notX64: 'O módulo de captura de áudio só está disponível para Windows x64.',
  moduleMissing: 'O módulo nativo de captura de áudio não está disponível nesta instalação.',
  oldWindows: (build: number): string =>
    `A captura por processo exige o Windows 10 versão 2004 (build 19041) ou mais recente; este Windows é a build ${build}.`,
  invalidSource: 'Fonte de captura inválida.',
  windowProcessUnknown: 'Não foi possível identificar o processo da janela selecionada.',
  discordNotRunning:
    'O Discord não está aberto, então não há chamada para excluir da captura. Use a opção de áudio do sistema.',
} as const;

/** pt-BR explanations for the HRESULTs Windows is likely to return from the activation. */
const HRESULT_MESSAGES: Readonly<Record<number, string>> = {
  0x80070057: 'O Windows rejeitou o processo escolhido para a captura de áudio.', // E_INVALIDARG
  0x80004001: 'Este Windows não suporta captura de áudio por processo.', // E_NOTIMPL
  0x80070490: 'Nenhum dispositivo de saída de áudio foi encontrado.', // E_NOTFOUND
  0x88890004: 'O dispositivo de áudio foi desconectado ou mudou durante a captura.', // AUDCLNT_E_DEVICE_INVALIDATED
  0x88890008: 'O Windows não aceitou o formato de áudio da captura.', // AUDCLNT_E_UNSUPPORTED_FORMAT
  0x88890010: 'O serviço de áudio do Windows não está em execução.', // AUDCLNT_E_SERVICE_NOT_RUNNING
};

export function describeNativeFailure(err: unknown): string {
  const hresult =
    typeof err === 'object' && err !== null && 'hresult' in err && typeof err.hresult === 'number'
      ? err.hresult
      : null;
  if (hresult !== null) {
    const known = HRESULT_MESSAGES[hresult];
    if (known) return known;
    return `Falha ao iniciar a captura de áudio por processo (HRESULT 0x${hresult.toString(16).padStart(8, '0')}).`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Falha ao iniciar a captura de áudio por processo: ${detail}`;
}

export interface ProcessAudioEngineDeps {
  platform: string;
  arch: string;
  loadNative: () => ProcessAudioNative | null;
  /** Owner pid of a window handle, 0 when unknown. */
  windowOwnerPid: (hwnd: number) => Promise<number>;
  /** Root pid of Discord's process tree, null when Discord is not running. */
  discordRootPid: () => Promise<number | null>;
  createCaptureId: () => string;
}

/**
 * `@concord/process-audio` is an external dependency resolved at runtime (it carries a prebuilt
 * binary), so it is required lazily and guarded: the main bundle must keep working without it.
 */
function loadNativeModule(): ProcessAudioNative | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@concord/process-audio') as typeof import('@concord/process-audio');
    return mod.load();
  } catch (err) {
    logger.warn('@concord/process-audio could not be loaded', err);
    return null;
  }
}

interface CaptureTarget {
  pid: number;
  mode: 'include' | 'exclude';
}

export function createProcessAudioEngine(
  overrides: Partial<ProcessAudioEngineDeps> = {},
): ProcessAudioEngine {
  const deps: ProcessAudioEngineDeps = {
    platform: process.platform,
    arch: process.arch,
    loadNative: loadNativeModule,
    windowOwnerPid: getWindowOwnerPid,
    discordRootPid: findDiscordRootPid,
    createCaptureId: randomUUID,
    ...overrides,
  };

  /** `undefined` until the first use; `null` when the module is unavailable. */
  let native: ProcessAudioNative | null | undefined;
  const captures = new Map<string, NativeCapture>();

  function getNative(): ProcessAudioNative | null {
    if (native === undefined) {
      native = deps.platform === 'win32' && deps.arch === 'x64' ? deps.loadNative() : null;
    }
    return native;
  }

  function unsupported(reason: string): ProcessAudioSupport {
    return { supported: false, reason };
  }

  function support(): ProcessAudioSupport {
    if (deps.platform !== 'win32') return unsupported(MESSAGES.notWindows);
    if (deps.arch !== 'x64') return unsupported(MESSAGES.notX64);
    const mod = getNative();
    if (!mod) return unsupported(MESSAGES.moduleMissing);
    if (!mod.isSupported()) return unsupported(MESSAGES.oldWindows(mod.windowsBuild()));
    return { supported: true, reason: null };
  }

  async function resolveTarget(target: ProcessAudioTarget): Promise<CaptureTarget> {
    const source = parseCaptureSourceId(target.sourceId);
    if (!source) throw new ProcessAudioError('invalid_source', MESSAGES.invalidSource);
    if (source.kind === 'window') {
      const pid = await deps.windowOwnerPid(source.handle);
      if (pid <= 0) {
        throw new ProcessAudioError('window_process_unknown', MESSAGES.windowProcessUnknown);
      }
      return { pid, mode: 'include' };
    }
    const pid = await deps.discordRootPid();
    if (pid === null)
      throw new ProcessAudioError('discord_not_running', MESSAGES.discordNotRunning);
    return { pid, mode: 'exclude' };
  }

  /** Idempotent: the entry leaves the map at once, so a second call finds nothing to stop. */
  async function stopCapture(captureId: string): Promise<void> {
    const capture = captures.get(captureId);
    if (!capture) return;
    captures.delete(captureId);
    try {
      await capture.stop();
      logger.info(`process audio capture ${captureId} stopped`);
    } catch (err) {
      logger.warn(`native stop of ${captureId} failed`, err);
    }
  }

  async function startCapture(
    target: ProcessAudioTarget,
    onData: ProcessAudioDataListener,
  ): Promise<ProcessAudioCapture> {
    const status = support();
    const mod = getNative();
    if (!status.supported || !mod) {
      throw new ProcessAudioError('unsupported', status.reason ?? MESSAGES.moduleMissing);
    }
    const resolved = await resolveTarget(target);
    const captureId = deps.createCaptureId();
    const next = mod.createCapture();
    let format: ProcessAudioCapture['format'];
    try {
      format = next.start({ pid: resolved.pid, mode: resolved.mode }, (chunk) =>
        onData(captureId, chunk),
      );
    } catch (err) {
      logger.warn('native start failed', err);
      throw new ProcessAudioError('native_failure', describeNativeFailure(err));
    }
    captures.set(captureId, next);
    logger.info(`process audio capture ${captureId} started`, {
      target: target.sourceId,
      pid: resolved.pid,
      mode: resolved.mode,
      ...format,
    });
    return { captureId, format };
  }

  return {
    support,
    start: startCapture,
    stop: stopCapture,
    async stopAll() {
      await Promise.all([...captures.keys()].map((captureId) => stopCapture(captureId)));
    },
    has: (captureId) => captures.has(captureId),
    get size() {
      return captures.size;
    },
    get running() {
      return captures.size > 0;
    },
  };
}
