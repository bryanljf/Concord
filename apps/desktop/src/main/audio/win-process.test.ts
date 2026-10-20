import { describe, expect, it, vi } from 'vitest';
import {
  getWindowOwnerPid,
  listProcessesByName,
  listProcessesQuick,
  parseProcessListJson,
  parseTasklistCsv,
  powerShellArgs,
  processListScript,
  windowOwnerPidScript,
  type CommandRunner,
} from './win-process';

describe('powerShellArgs', () => {
  it('encodes the script as UTF-16LE base64 for -EncodedCommand', () => {
    const args = powerShellArgs('Write-Output 1');
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    expect(Buffer.from(args[5] ?? '', 'base64').toString('utf16le')).toBe('Write-Output 1');
  });
});

describe('scripts', () => {
  it('embeds the HWND and rejects invalid handles', () => {
    expect(windowOwnerPidScript(197150)).toContain('[IntPtr]197150');
    expect(() => windowOwnerPidScript(0)).toThrow(RangeError);
    expect(() => windowOwnerPidScript(1.5)).toThrow(RangeError);
  });

  it('builds a WQL filter from safe process names only', () => {
    expect(processListScript(['Discord.exe', 'DiscordPTB.exe'])).toContain(
      `$filter = "Name='Discord.exe' OR Name='DiscordPTB.exe'"`,
    );
    expect(() => processListScript([])).toThrow(RangeError);
    expect(() => processListScript(["a' OR Name='b"])).toThrow(RangeError);
  });
});

describe('parseProcessListJson', () => {
  it('parses arrays and single objects', () => {
    expect(
      parseProcessListJson(
        '[{"ProcessId":10,"ParentProcessId":5,"Name":"Discord.exe"},{"ProcessId":11,"ParentProcessId":10,"Name":"Discord.exe"}]\r\n',
      ),
    ).toEqual([
      { pid: 10, ppid: 5, name: 'Discord.exe' },
      { pid: 11, ppid: 10, name: 'Discord.exe' },
    ]);
    expect(
      parseProcessListJson('{"ProcessId":10,"ParentProcessId":5,"Name":"Discord.exe"}'),
    ).toEqual([{ pid: 10, ppid: 5, name: 'Discord.exe' }]);
  });

  it('tolerates empty, quoted and malformed output', () => {
    expect(parseProcessListJson('')).toEqual([]);
    expect(parseProcessListJson('[]')).toEqual([]);
    expect(parseProcessListJson('"[]"\r\n')).toEqual([]);
    expect(parseProcessListJson('null')).toEqual([]);
    expect(parseProcessListJson('not json')).toEqual([]);
    expect(parseProcessListJson('[{"ProcessId":"x","Name":"Discord.exe"},{"Name":"a"},5]')).toEqual(
      [],
    );
  });

  it('keeps rows with unknown parents', () => {
    expect(
      parseProcessListJson('[{"ProcessId":"12","ParentProcessId":null,"Name":"a.exe"}]'),
    ).toEqual([{ pid: 12, ppid: null, name: 'a.exe' }]);
  });
});

describe('parseTasklistCsv', () => {
  it('extracts name and pid, skipping non-CSV lines', () => {
    const output = [
      '',
      'INFO: No tasks are running which match the specified criteria.',
      '"Discord.exe","12345","Console","1","123.456 K"',
      '"Weird ""Name"".exe","7","Console","1","1 K"',
      '"broken","abc","Console","1","1 K"',
    ].join('\r\n');
    expect(parseTasklistCsv(output)).toEqual([
      { pid: 12345, ppid: null, name: 'Discord.exe' },
      { pid: 7, ppid: null, name: 'Weird "Name".exe' },
    ]);
  });
});

describe('getWindowOwnerPid', () => {
  it('returns the pid printed by PowerShell', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue('18532\r\n');
    await expect(getWindowOwnerPid(197150, run)).resolves.toBe(18532);
    expect(run).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-EncodedCommand']));
  });

  it('returns 0 for invalid handles, non-numeric output or failures', async () => {
    const run = vi.fn<CommandRunner>();
    await expect(getWindowOwnerPid(0, run)).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValueOnce('garbage');
    await expect(getWindowOwnerPid(5, run)).resolves.toBe(0);
    run.mockRejectedValueOnce(new Error('boom'));
    await expect(getWindowOwnerPid(5, run)).resolves.toBe(0);
  });
});

describe('listProcessesByName', () => {
  it('uses PowerShell and filters by name case-insensitively', async () => {
    const run = vi
      .fn<CommandRunner>()
      .mockResolvedValue(
        '[{"ProcessId":1,"ParentProcessId":0,"Name":"discord.exe"},{"ProcessId":2,"ParentProcessId":1,"Name":"Other.exe"}]',
      );
    await expect(listProcessesByName(['Discord.exe'], run)).resolves.toEqual([
      { pid: 1, ppid: null, name: 'discord.exe' },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('falls back to tasklist when PowerShell fails', async () => {
    const run = vi.fn<CommandRunner>(async (file) => {
      if (file === 'powershell.exe') throw new Error('not found');
      return '"Discord.exe","42","Console","1","1 K"\r\n"explorer.exe","9","Console","1","1 K"';
    });
    await expect(listProcessesByName(['Discord.exe'], run)).resolves.toEqual([
      { pid: 42, ppid: null, name: 'Discord.exe' },
    ]);
    expect(run).toHaveBeenLastCalledWith('tasklist', ['/FO', 'CSV', '/NH']);
  });
});

describe('listProcessesQuick', () => {
  it('uses tasklist only and filters by name case-insensitively', async () => {
    const run = vi
      .fn<CommandRunner>()
      .mockResolvedValue(
        '"Spotify.exe","900","Console","1","90 K"\r\n"spotify.exe","910","Console","1","9 K"\r\n"explorer.exe","9","Console","1","1 K"',
      );
    await expect(listProcessesQuick(['Spotify.exe'], run)).resolves.toEqual([
      { pid: 900, ppid: null, name: 'Spotify.exe' },
      { pid: 910, ppid: null, name: 'spotify.exe' },
    ]);
    expect(run).toHaveBeenCalledExactlyOnceWith('tasklist', ['/FO', 'CSV', '/NH']);
  });

  it('rejects when tasklist fails', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('boom'));
    await expect(listProcessesQuick(['Spotify.exe'], run)).rejects.toThrow('boom');
  });
});
