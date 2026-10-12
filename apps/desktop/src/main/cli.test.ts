import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli';

describe('parseCliArgs', () => {
  it('defaults to visible with no values', () => {
    expect(parseCliArgs(['electron.exe', '.'])).toEqual({ hidden: false });
  });

  it('reads --flag=value and --flag value forms', () => {
    expect(
      parseCliArgs([
        '--hidden',
        '--user-data-dir=C:\\tmp\\concord-b',
        '--server',
        'http://127.0.0.1:3000',
        '--key=abc',
        '--room',
        'jogos',
      ]),
    ).toEqual({
      hidden: true,
      userDataDir: 'C:\\tmp\\concord-b',
      server: 'http://127.0.0.1:3000',
      key: 'abc',
      room: 'jogos',
    });
  });

  it('ignores unknown flags, empty values and values that look like flags', () => {
    expect(parseCliArgs(['--inspect=9229', '--room', '--hidden', '--key='])).toEqual({
      hidden: true,
    });
  });

  it('uses the environment directory when the dev runner consumes CLI flags', () => {
    expect(parseCliArgs([], { CONCORD_USER_DATA_DIR: 'C:\\tmp\\concord-b' })).toEqual({
      hidden: false,
      userDataDir: 'C:\\tmp\\concord-b',
    });
  });

  it('prefers an explicit CLI directory over the environment', () => {
    expect(
      parseCliArgs(['--user-data-dir=C:\\tmp\\explicit'], {
        CONCORD_USER_DATA_DIR: 'C:\\tmp\\environment',
      }),
    ).toEqual({
      hidden: false,
      userDataDir: 'C:\\tmp\\explicit',
    });
  });
});
