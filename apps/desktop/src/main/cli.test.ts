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
});
