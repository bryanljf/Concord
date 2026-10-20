import { describe, expect, it } from 'vitest';
import {
  chooseDiscordRootPid,
  chooseRootPid,
  findDiscordRootPid,
  findRootPid,
} from './discord-process';
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
  const SPOTIFY = ['Spotify.exe'];

  it('finds the root of a music app tree, ignoring other apps', () => {
    const processes = [
      row(5100, 5000, 'Spotify.exe'), // renderer
      row(5000, 3000, 'Spotify.exe'), // root (parent explorer.exe)
      row(5200, 5000, 'Spotify.exe'), // gpu
      row(5300, 5100, 'Spotify.exe'), // utility under the renderer
      row(100, 1, 'Discord.exe'),
      row(101, 100, 'Discord.exe'),
      row(102, 100, 'Discord.exe'),
      row(103, 100, 'Discord.exe'),
      row(104, 100, 'Discord.exe'),
    ];
    expect(chooseRootPid(processes, SPOTIFY)).toBe(5000);
  });

  it('handles the Microsoft Store build (same image name, root started by svchost)', () => {
    const processes = [
      row(8820, 1144, 'Spotify.exe'),
      row(8900, 8820, 'Spotify.exe'),
      row(8930, 8820, 'Spotify.exe'),
    ];
    expect(chooseRootPid(processes, SPOTIFY)).toBe(8820);
  });

  it('returns null when the app is not running', () => {
    expect(chooseRootPid([row(1, null, 'Discord.exe')], SPOTIFY)).toBeNull();
    expect(chooseRootPid([], SPOTIFY)).toBeNull();
  });

  it('falls back to the lowest pid without parent pids (tasklist)', () => {
    expect(
      chooseRootPid(
        [
          row(7300, null, 'Spotify.exe'),
          row(7200, null, 'spotify.exe'),
          row(7400, null, 'Spotify.exe'),
        ],
        SPOTIFY,
      ),
    ).toBe(7200);
  });

  it('ignores invalid pids', () => {
    expect(
      chooseRootPid([row(0, null, 'Spotify.exe'), row(-3, null, 'Spotify.exe')], SPOTIFY),
    ).toBeNull();
  });

  it('keeps the Discord behaviour behind chooseDiscordRootPid', () => {
    const processes = [row(10, 1), row(11, 10), row(20, 1, 'Spotify.exe')];
    expect(chooseDiscordRootPid(processes)).toBe(chooseRootPid(processes, ['Discord.exe']));
  });
});

describe('findRootPid', () => {
  it('lists the given image names and picks the root', async () => {
    const list = async (names: readonly string[]): Promise<ProcessInfo[]> => {
      expect(names).toEqual(['Spotify.exe']);
      return [row(41, 40, 'Spotify.exe'), row(40, 2, 'Spotify.exe')];
    };
    await expect(findRootPid(['Spotify.exe'], list)).resolves.toBe(40);
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
