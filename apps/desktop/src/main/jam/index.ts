/**
 * Electron wiring of the Jam: yt-dlp lives in `userData/bin` (the onedir build in a folder per
 * version under `yt-dlp`) and runs with Electron's own Node as its JavaScript runtime, each
 * download with a TEMP folder of its own under `userData/tmp/yt-dlp`. Downloading (and so
 * prefetching and the warm-up) is Windows-only.
 */
import { app } from 'electron';
import { join } from 'node:path';
import type { ApiClient } from '../api-client';
import { log } from '../log';
import type { PresenceClient } from '../presence-client';
import { createYtDlpTemp, runYtDlpVersion, startJamDownload, type JamDownload } from './download';
import { createJamPrefetcher } from './prefetch';
import { createJamService, type JamService } from './service';
import { createYtDlpSlots } from './slots';
import type { JamStore } from './store';
import { createJamUploads } from './uploads';
import { createJamWarmUp } from './warmup';
import { createYtDlpManager } from './ytdlp';

export type { JamService } from './service';
export { jamSessionOwner } from './service';

const logger = log('jam');

export interface JamOptions {
  api: ApiClient;
  /** The presence client's jam store (`PresenceClient.jam`). */
  store: JamStore;
  /** The server's requests to download songs for other clients (`PresenceClient.onFetchRequest`). */
  onFetchRequest: PresenceClient['onFetchRequest'];
}

export interface Jam extends JamService {
  /**
   * Start-up housekeeping: clears the yt-dlp temp folders an earlier session left (a killed
   * run of the single-file build leaves ~30 MB), deletes older onedir versions, and deletes
   * yt-dlp (either build) after 30 days without use.
   */
  cleanUp(): Promise<void>;
}

export function createJam(options: JamOptions): Jam {
  const { api, store } = options;
  const userData = app.getPath('userData');
  const windows = process.platform === 'win32';
  const slots = createYtDlpSlots();
  const ytdlp = createYtDlpManager({
    binDir: join(userData, 'bin'),
    // Older onedir versions are deleted only while no yt-dlp runs (it locks its files).
    isIdle: () => slots.busy === 0,
  });
  const temp = createYtDlpTemp(join(userData, 'tmp', 'yt-dlp'));
  const startDownload = (exePath: string, videoId: string): JamDownload =>
    startJamDownload(exePath, videoId, { temp });
  const prefetches = createJamPrefetcher({ ytdlp, slots, startDownload });
  const uploads = createJamUploads({ api, ytdlp, store, slots, prefetches, startDownload });
  const service = createJamService({
    api,
    store,
    uploads,
    prefetches,
    canDownload: windows,
    prepare: () => {
      ytdlp.ensure().catch((err: unknown) => logger.warn('could not prepare yt-dlp', err));
    },
  });
  const warmUp = createJamWarmUp({
    store,
    enabled: windows,
    ytdlp,
    slots,
    runVersion: (exePath, signal) => runYtDlpVersion(exePath, { temp, signal }),
  });
  // Songs the server asks this app to download for someone else (silent; declined off Windows).
  const stopFetching = options.onFetchRequest((room, item) => service.fetch(room, item));
  return {
    ...service,
    async cleanUp() {
      await temp.wipe();
      await ytdlp.removeIfUnused();
    },
    destroy() {
      stopFetching();
      warmUp.destroy();
      service.destroy();
      ytdlp.destroy();
    },
  };
}
