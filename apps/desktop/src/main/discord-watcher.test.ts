import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPollingWatcher, DISCORD_PROCESS_NAMES, parseTasklistCsv } from './discord-watcher';

const SAMPLE = [
  '"System Idle Process","0","Services","0","8 K"',
  '"explorer.exe","4321","Console","1","123,456 K"',
  '"Discord.exe","1234","Console","1","345,678 K"',
  '"Name, with comma.exe","1","Console","1","1 K"',
  '"Quote""inside.exe","2","Console","1","1 K"',
  '',
].join('\r\n');

describe('parseTasklistCsv', () => {
  it('returns the image name of every row, handling quoted commas and escaped quotes', () => {
    expect(parseTasklistCsv(SAMPLE)).toEqual([
      'System Idle Process',
      'explorer.exe',
      'Discord.exe',
      'Name, with comma.exe',
      'Quote"inside.exe',
    ]);
  });

  it('skips lines that are not CSV rows', () => {
    expect(
      parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\n'),
    ).toEqual([]);
    expect(parseTasklistCsv('')).toEqual([]);
  });
});

describe('createPollingWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('detects the process case-insensitively and reports changes', async () => {
    let processes = ['explorer.exe'];
    const listProcesses = vi.fn(async () => processes);
    const watcher = createPollingWatcher({
      names: DISCORD_PROCESS_NAMES,
      intervalMs: 1000,
      listProcesses,
    });
    const changes: boolean[] = [];
    watcher.onChange((running) => changes.push(running));

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.isRunning).toBe(false);
    expect(changes).toEqual([]);

    processes = ['explorer.exe', 'DISCORDCANARY.EXE'];
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.isRunning).toBe(true);
    expect(changes).toEqual([true]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([true]);

    processes = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.isRunning).toBe(false);
    expect(changes).toEqual([true, false]);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listProcesses).toHaveBeenCalledTimes(4);
  });

  it('fails open when the process listing breaks', async () => {
    const watcher = createPollingWatcher({
      names: DISCORD_PROCESS_NAMES,
      intervalMs: 1000,
      listProcesses: async () => {
        throw new Error('tasklist not found');
      },
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.isRunning).toBe(true);
    watcher.stop();
  });
});
