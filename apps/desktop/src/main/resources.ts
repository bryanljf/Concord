import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Absolute path of a file under `apps/desktop/resources/`. In development that is the source
 * folder; in a packaged build it is either `extraResources` (next to the asar) or the copy
 * inside the app bundle.
 */
export function resourcePath(...segments: string[]): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'resources'), join(app.getAppPath(), 'resources')]
    : [join(app.getAppPath(), 'resources')];
  for (const dir of candidates) {
    const path = join(dir, ...segments);
    if (existsSync(path)) return path;
  }
  return join(candidates[0] ?? app.getAppPath(), ...segments);
}
