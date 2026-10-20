/**
 * Finds the root of a multi-process app's tree: Discord's (excluded from a screen capture) or a
 * music app's (the only thing an app capture includes). These apps run a browser process plus
 * renderers and utility processes under the same image name, so a capture must target the root:
 * the process whose parent is not one of the app's processes.
 */
import { DISCORD_PROCESS_NAMES } from '../discord-watcher';
import { listProcessesByName, type ProcessInfo } from './win-process';

/**
 * Picks the root of the (largest) tree of processes named `names`, or null when none runs. With
 * several roots (e.g. Discord and Discord Canary open at once) the one with most descendants
 * wins, then the lowest pid; only one tree can be included or excluded per capture.
 *
 * Without parent pids (the `tasklist` fallback) every process looks like a root with no
 * descendants, so the lowest pid wins: usually the app's first (root) process, but Windows reuses
 * pids, so it is a best guess. Callers that must know whether a capture's process is still alive
 * should check that its pid is still listed rather than re-running this choice.
 */
export function chooseRootPid(
  processes: readonly ProcessInfo[],
  names: readonly string[],
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

/** Root of Discord's process tree (any of its release channels), or null when it is closed. */
export function chooseDiscordRootPid(
  processes: readonly ProcessInfo[],
  names: readonly string[] = DISCORD_PROCESS_NAMES,
): number | null {
  return chooseRootPid(processes, names);
}

export async function findDiscordRootPid(
  list: (names: readonly string[]) => Promise<ProcessInfo[]> = listProcessesByName,
): Promise<number | null> {
  return chooseDiscordRootPid(await list(DISCORD_PROCESS_NAMES));
}

/** Root of the tree of processes named `names` (a music app), or null when none runs. */
export async function findRootPid(
  names: readonly string[],
  list: (names: readonly string[]) => Promise<ProcessInfo[]> = listProcessesByName,
): Promise<number | null> {
  return chooseRootPid(await list(names), names);
}
