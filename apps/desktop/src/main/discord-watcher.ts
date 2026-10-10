import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './log';

const logger = log('discord');
const execFileAsync = promisify(execFile);

export const DISCORD_PROCESS_NAMES = ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe'];
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

export type ProcessWatcherListener = (running: boolean) => void;

/** Polls the OS for a set of process names; abstracted so Linux (`pgrep`) can be added later. */
export interface ProcessWatcher {
  readonly isRunning: boolean;
  start(): void;
  stop(): void;
  onChange(listener: ProcessWatcherListener): () => void;
}

// ---------------------------------------------------------------------------
// tasklist parsing
// ---------------------------------------------------------------------------

/** Splits one CSV line as produced by `tasklist /FO CSV` (every field is double-quoted). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Extracts the image names (first column) from `tasklist /FO CSV /NH` output. Lines that are
 * not CSV rows (e.g. `INFO: No tasks are running...`) are skipped.
 */
export function parseTasklistCsv(output: string): string[] {
  const names: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;
    const name = parseCsvLine(line)[0];
    if (name) names.push(name);
  }
  return names;
}

async function listProcessesWithTasklist(): Promise<string[]> {
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseTasklistCsv(stdout);
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

export interface PollingWatcherOptions {
  /** Process image names to look for (case-insensitive). */
  names: readonly string[];
  intervalMs?: number;
  /** Returns the image names of the running processes. Defaults to `tasklist`. */
  listProcesses?: () => Promise<string[]>;
}

/**
 * Windows implementation: one `tasklist /FO CSV /NH` call every `intervalMs`. If `tasklist`
 * itself fails the watcher reports "running" (fail-open) so `followDiscord` never blocks
 * presence because of a broken tool; the failure is logged once.
 */
export function createPollingWatcher(options: PollingWatcherOptions): ProcessWatcher {
  const wanted = new Set(options.names.map((name) => name.toLowerCase()));
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const listProcesses = options.listProcesses ?? listProcessesWithTasklist;
  const listeners = new Set<ProcessWatcherListener>();
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let checking = false;
  let failed = false;

  function set(next: boolean): void {
    if (next === running) return;
    running = next;
    logger.info(next ? 'Discord detected' : 'Discord not running');
    for (const listener of listeners) listener(next);
  }

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const names = await listProcesses();
      failed = false;
      set(names.some((name) => wanted.has(name.toLowerCase())));
    } catch (err) {
      if (!failed) logger.warn('process listing failed; assuming Discord is running', err);
      failed = true;
      set(true);
    } finally {
      checking = false;
    }
  }

  return {
    get isRunning() {
      return running;
    },
    start() {
      if (timer) return;
      void check();
      timer = setInterval(() => void check(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Placeholder for platforms without an implementation yet: always reports "running" so the
 * "Abrir junto com o Discord" option never blocks presence. A Linux version can poll
 * `pgrep -x Discord` (or scan `/proc`) with the same interface.
 */
export function createAlwaysRunningWatcher(): ProcessWatcher {
  return {
    isRunning: true,
    start() {},
    stop() {},
    onChange() {
      return () => {};
    },
  };
}

export function createDiscordWatcher(): ProcessWatcher {
  if (process.platform === 'win32') return createPollingWatcher({ names: DISCORD_PROCESS_NAMES });
  logger.info(`no process watcher for ${process.platform}; assuming Discord is running`);
  return createAlwaysRunningWatcher();
}
