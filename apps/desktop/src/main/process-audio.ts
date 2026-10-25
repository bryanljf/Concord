import type { WebContents } from 'electron';
import type { ProcessAudioCapture, ProcessAudioSupport, ProcessAudioTarget } from '../preload/api';
import { EVENTS } from '../preload/channels';
import type { ProcessAudioEngine } from './audio';
import { expectSourceId } from './capture';
import { log } from './log';
import { expectString, IpcValidationError, isRecord, UserFacingError } from './validation';

const logger = log('process-audio');

/** More than this per window is a renderer bug (it normally holds one: the live's audio). */
export const MAX_CAPTURES_PER_WINDOW = 4;

const CAPTURE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** `startProcessAudio` argument: a desktopCapturer window or screen source. */
export function parseProcessAudioTarget(raw: unknown): ProcessAudioTarget {
  if (!isRecord(raw) || raw.kind !== 'source') throw new IpcValidationError('target');
  return { kind: 'source', sourceId: expectSourceId(raw.sourceId) };
}

export function expectCaptureId(value: unknown, name = 'captureId'): string {
  const id = expectString(value, name);
  if (!CAPTURE_ID_PATTERN.test(id)) throw new IpcValidationError(name);
  return id;
}

/**
 * IPC-facing side of per-process audio capture: several captures at once, each owned by the
 * window that started it. PCM chunks go to that window only, tagged with the capture id
 * (`PROCESS_AUDIO_DATA`). A window that closes, crashes or reloads loses its captures (the renderer
 * that held them is gone).
 */
export interface ProcessAudioBridge {
  support(): ProcessAudioSupport;
  start(sender: WebContents, target: unknown): Promise<ProcessAudioCapture>;
  /** Only the owning window may stop a capture; unknown or ended ids are a no-op. */
  stop(sender: WebContents, captureId: unknown): Promise<void>;
  stopAll(): Promise<void>;
}

interface Owner {
  readonly sender: WebContents;
  readonly captures: Set<string>;
  detach(): void;
}

export function createProcessAudioBridge(engine: ProcessAudioEngine): ProcessAudioBridge {
  const owners = new Map<WebContents, Owner>();
  const ownerOf = new Map<string, Owner>();

  function forget(captureId: string): void {
    const owner = ownerOf.get(captureId);
    if (!owner) return;
    ownerOf.delete(captureId);
    owner.captures.delete(captureId);
    if (owner.captures.size === 0) {
      owner.detach();
      owners.delete(owner.sender);
    }
  }

  async function stopCapture(captureId: string): Promise<void> {
    forget(captureId);
    await engine.stop(captureId);
    logger.info(`stopped ${captureId}`);
  }

  function ownerFor(sender: WebContents): Owner {
    const existing = owners.get(sender);
    if (existing) return existing;
    const captures = new Set<string>();
    const release = (): void => {
      logger.info('owning window closed or reloaded; stopping its captures');
      for (const captureId of [...captures]) void stopCapture(captureId);
    };
    sender.once('destroyed', release);
    sender.on('render-process-gone', release);
    // Main-frame navigations only (a reload included); in-page navigations do not fire it.
    sender.on('did-navigate', release);
    const owner: Owner = {
      sender,
      captures,
      detach() {
        sender.removeListener('destroyed', release);
        sender.removeListener('render-process-gone', release);
        sender.removeListener('did-navigate', release);
      },
    };
    owners.set(sender, owner);
    return owner;
  }

  return {
    support: () => engine.support(),
    async start(sender, rawTarget) {
      const target = parseProcessAudioTarget(rawTarget);
      const support = engine.support();
      if (!support.supported) {
        throw new UserFacingError(
          support.reason ?? 'Captura de áudio por processo não disponível neste computador.',
        );
      }
      if ((owners.get(sender)?.captures.size ?? 0) >= MAX_CAPTURES_PER_WINDOW) {
        throw new UserFacingError('Há capturas de áudio demais ao mesmo tempo nesta janela.');
      }
      const capture = await engine.start(target, (captureId, chunk) => {
        if (!sender.isDestroyed()) sender.send(EVENTS.PROCESS_AUDIO_DATA, captureId, chunk);
      });
      if (sender.isDestroyed()) {
        // The window went away while the target was being resolved: nobody to deliver to.
        await engine.stop(capture.captureId);
        throw new UserFacingError('A janela foi fechada.');
      }
      const owner = ownerFor(sender);
      owner.captures.add(capture.captureId);
      ownerOf.set(capture.captureId, owner);
      logger.info(
        `started ${capture.captureId} for ${target.sourceId} (${capture.format.sampleRate} Hz, ${capture.format.channels} ch)`,
      );
      return capture;
    },
    async stop(sender, rawCaptureId) {
      const captureId = expectCaptureId(rawCaptureId);
      const owner = ownerOf.get(captureId);
      if (!owner) return;
      if (owner.sender !== sender) {
        logger.warn(`a window that does not own ${captureId} tried to stop it; ignored`);
        return;
      }
      await stopCapture(captureId);
    },
    async stopAll() {
      for (const captureId of [...ownerOf.keys()]) forget(captureId);
      await engine.stopAll();
    },
  };
}
