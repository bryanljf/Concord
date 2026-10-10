/**
 * Finds the Discord process whose tree must be excluded from a screen capture. Discord is a
 * multi-process app (browser process + renderers + the utility process that plays the call), so
 * the exclusion must target the root: the Discord process whose parent is not a Discord process.
 */
import { DISCORD_PROCESS_NAMES } from '../discord-watcher';
import { listProcessesByName, type ProcessInfo } from './win-process';

/**
 * Picks the root of the (largest) Discord process tree, or null when Discord is not running.
 * With several roots (e.g. Discord and Discord Canary open at once) the one with most descendants
 * wins, then the lowest pid; only one tree can be excluded per capture.
 */
export function chooseDiscordRootPid(
  processes: readonly ProcessInfo[],
  names: readonly string[] = DISCORD_PROCESS_NAMES,
): number | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const candidates = processes.filter(
    (process) =>
      wanted.has(process.name.toLowerCase()) && Number.isInteger(process.pid) && process.pid > 0,
  );
  if (candidates.length === 0) return null;

  const pids = new Set(candidates.map((process) => process.pid));
  const children = new Map<number, number[]>();
  for (const process of candidates) {
    if (process.ppid === null || process.ppid === process.pid || !pids.has(process.ppid)) continue;
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process.pid);
    children.set(process.ppid, siblings);
  }

  const roots = candidates.filter(
    (process) => process.ppid === null || process.ppid === process.pid || !pids.has(process.ppid),
  );
  const pool = roots.length > 0 ? roots : candidates;

  const countDescendants = (pid: number): number => {
    let count = 0;
    const seen = new Set<number>([pid]);
    const stack = [...(children.get(pid) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      count += 1;
      stack.push(...(children.get(next) ?? []));
    }
    return count;
  };

  const ranked = pool
    .map((process) => ({ pid: process.pid, descendants: countDescendants(process.pid) }))
    .sort((a, b) => b.descendants - a.descendants || a.pid - b.pid);
  return ranked[0]?.pid ?? null;
}

export async function findDiscordRootPid(
  list: (names: readonly string[]) => Promise<ProcessInfo[]> = listProcessesByName,
): Promise<number | null> {
  return chooseDiscordRootPid(await list(DISCORD_PROCESS_NAMES));
}
