import type { WebContents } from 'electron';
import type { ProcessAudioFormat, ProcessAudioSupport } from '../preload/api';
import { EVENTS } from '../preload/channels';
import type { ProcessAudioEngine } from './audio';
import { expectSourceId } from './capture';
import { log } from './log';
import { UserFacingError } from './validation';

const logger = log('process-audio');

/**
 * IPC-facing side of per-process audio capture (SPEC 5.7): one capture at a time, owned by the
 * renderer that started it. PCM chunks are pushed to that renderer as `PROCESS_AUDIO_DATA`.
 */
export interface ProcessAudioBridge {
  support(): ProcessAudioSupport;
  start(sender: WebContents, sourceId: unknown): Promise<ProcessAudioFormat>;
  stop(): Promise<void>;
}

export function createProcessAudioBridge(engine: ProcessAudioEngine): ProcessAudioBridge {
  let owner: WebContents | null = null;
  let onOwnerDestroyed: (() => void) | null = null;

  async function stop(): Promise<void> {
    if (owner && onOwnerDestroyed) owner.removeListener('destroyed', onOwnerDestroyed);
    const wasRunning = owner !== null || engine.running;
    owner = null;
    onOwnerDestroyed = null;
    if (!wasRunning) return;
    await engine.stop();
    logger.info('stopped');
  }

  return {
    support: () => engine.support(),
    async start(sender, rawSourceId) {
      const sourceId = expectSourceId(rawSourceId);
      const support = engine.support();
      if (!support.supported) {
        throw new UserFacingError(
          support.reason ?? 'Captura de áudio por processo não disponível neste computador.',
        );
      }
      await stop();
      const format = await engine.start(sourceId, (chunk) => {
        if (!sender.isDestroyed()) sender.send(EVENTS.PROCESS_AUDIO_DATA, chunk);
      });
      owner = sender;
      onOwnerDestroyed = () => {
        logger.info('owning window closed; stopping');
        void stop();
      };
      sender.once('destroyed', onOwnerDestroyed);
      logger.info(`started for ${sourceId} (${format.sampleRate} Hz, ${format.channels} ch)`);
      return format;
    },
    stop,
  };
}
