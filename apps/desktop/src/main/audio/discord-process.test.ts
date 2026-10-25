import { describe, expect, it } from 'vitest';
import { chooseDiscordRootPid, chooseRootPid, findDiscordRootPid } from './discord-process';
import type { ProcessInfo } from './win-process';

const row = (pid: number, ppid: number | null, name = 'Discord.exe'): ProcessInfo => ({
  pid,
  ppid,
  name,
});

describe('chooseDiscordRootPid', () => {
  it('returns null when Discord is not running', () => {
    expect(chooseDiscordRootPid([])).toBeNull();
    expect(chooseDiscordRootPid([row(1, null, 'explorer.exe')])).toBeNull();
  });

  it('picks the process whose parent is not a Discord process', () => {
    const processes = [
      row(300, 100), // renderer, child of the root
      row(200, 1), // root (parent is Update.exe, already gone)
      row(400, 200), // gpu
      row(500, 200), // utility (audio)
    ];
    expect(chooseDiscordRootPid([...processes, row(100, 200)])).toBe(200);
  });

  it('prefers the tree with more descendants when several clients run', () => {
    const processes = [
      row(10, 1, 'DiscordCanary.exe'),
      row(11, 10, 'DiscordCanary.exe'),
      row(20, 1, 'Discord.exe'),
      row(21, 20, 'Discord.exe'),
      row(22, 20, 'Discord.exe'),
      row(23, 22, 'Discord.exe'),
    ];
    expect(chooseDiscordRootPid(processes)).toBe(20);
  });

  it('breaks ties by the lowest pid and ignores case', () => {
    expect(chooseDiscordRootPid([row(50, 1, 'discord.exe'), row(40, 1, 'DISCORD.EXE')])).toBe(40);
  });

  it('falls back to the lowest pid when parent pids are unknown (tasklist)', () => {
    expect(chooseDiscordRootPid([row(900, null), row(700, null), row(800, null)])).toBe(700);
  });

  it('survives cycles and self-parented rows', () => {
    expect(chooseDiscordRootPid([row(1, 2), row(2, 1), row(3, 3)])).toBe(3);
  });
});

describe('chooseRootPid', () => {
  const APP = ['App.exe'];

  it('finds the root of another tree, ignoring other apps', () => {
    const processes = [
      row(5100, 5000, 'App.exe'), // renderer
      row(5000, 3000, 'App.exe'), // root (parent explorer.exe)
      row(5200, 5000, 'App.exe'), // gpu
      row(5300, 5100, 'App.exe'), // utility under the renderer
      row(100, 1, 'Discord.exe'),
      row(101, 100, 'Discord.exe'),
      row(102, 100, 'Discord.exe'),
      row(103, 100, 'Discord.exe'),
      row(104, 100, 'Discord.exe'),
    ];
    expect(chooseRootPid(processes, APP)).toBe(5000);
  });

  it('returns null when the app is not running', () => {
    expect(chooseRootPid([row(1, null, 'Discord.exe')], APP)).toBeNull();
    expect(chooseRootPid([], APP)).toBeNull();
  });

  it('falls back to the lowest pid without parent pids (tasklist)', () => {
    expect(
      chooseRootPid(
        [row(7300, null, 'App.exe'), row(7200, null, 'app.exe'), row(7400, null, 'App.exe')],
        APP,
      ),
    ).toBe(7200);
  });

  it('ignores invalid pids', () => {
    expect(chooseRootPid([row(0, null, 'App.exe'), row(-3, null, 'App.exe')], APP)).toBeNull();
  });

  it('keeps the Discord behaviour behind chooseDiscordRootPid', () => {
    const processes = [row(10, 1), row(11, 10), row(20, 1, 'App.exe')];
    expect(chooseDiscordRootPid(processes)).toBe(chooseRootPid(processes, ['Discord.exe']));
  });
});

describe('findDiscordRootPid', () => {
  it('queries the Discord image names and picks the root', async () => {
    const list = async (names: readonly string[]): Promise<ProcessInfo[]> => {
      expect(names).toEqual(['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe']);
      return [row(5, 1), row(6, 5)];
    };
    await expect(findDiscordRootPid(list)).resolves.toBe(5);
  });
});
