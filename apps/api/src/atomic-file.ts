import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

let tmpCounter = 0;

/** On Windows a rename can briefly fail while another process (antivirus, indexer) reads the file. */
export async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/**
 * Moves an unreadable file aside to `<path>.corrupt-<now>` so nothing is lost, keeping only that
 * latest copy: older `.corrupt-*` copies of the same file are deleted. Returns the copy's path.
 */
export async function moveAsideCorrupt(path: string, now: number): Promise<string> {
  const backup = `${path}.corrupt-${now}`;
  await rename(path, backup);
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith(prefix) && name !== basename(backup)) {
      await unlink(join(dir, name)).catch(() => undefined);
    }
  }
  return backup;
}

/**
 * Writes `data` to `path` atomically: a temporary file next to it, then a rename, so a crash
 * never leaves a half-written file behind. Creates the directory when needed.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  tmpCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, data, 'utf8');
    await renameWithRetry(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
