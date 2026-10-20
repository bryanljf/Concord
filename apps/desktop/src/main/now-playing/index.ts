/**
 * Electron wiring of the "now playing" service: the SMTC reader runs in a utility process built
 * from `worker.ts` (out/main/now-playing-worker.js), covers are resized with `nativeImage`, and
 * the music apps' processes are looked for with `tasklist`.
 */
import { nativeImage, utilityProcess } from 'electron';
import { listProcessesQuick } from '../audio/win-process';
import { encodeCoverArt } from './art';
import { createNowPlayingService, type NowPlayingService } from './service';

export type { NowPlayingService } from './service';

export interface NowPlayingOptions {
  /** Absolute path of the built worker (`now-playing-worker.js` next to the main bundle). */
  workerPath: string;
}

export function createNowPlaying(options: NowPlayingOptions): NowPlayingService {
  return createNowPlayingService({
    supported: process.platform === 'win32',
    spawnWorker() {
      // `utilityProcess.fork` needs `app` ready: the service only spawns on the first getStatus.
      const child = utilityProcess.fork(options.workerPath, [], {
        serviceName: 'Concord Now Playing',
        stdio: 'inherit',
      });
      return {
        onMessage: (listener) => {
          child.on('message', listener);
        },
        onExit: (listener) => {
          child.on('exit', listener);
        },
        postMessage: (message) => child.postMessage(message),
        kill: () => {
          child.kill();
        },
      };
    },
    isRunning: async (names) => (await listProcessesQuick(names)).length > 0,
    encodeArt: (bytes) => encodeCoverArt(bytes, nativeImage),
  });
}
