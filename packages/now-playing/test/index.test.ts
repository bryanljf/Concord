import { describe, expect, it, vi } from 'vitest';
import { load, PLAYBACK_STATUS } from '../index';

class FakeMonitor {
  static getMediaSessions(): unknown[] {
    return [];
  }
}

describe('load', () => {
  it('returns null off Windows without touching the module', () => {
    const requireMonitor = vi.fn();
    expect(load({ platform: 'linux', requireMonitor })).toBeNull();
    expect(load({ platform: 'darwin', requireMonitor })).toBeNull();
    expect(requireMonitor).not.toHaveBeenCalled();
  });

  it('returns null when the module or its binary cannot be loaded', () => {
    expect(
      load({
        platform: 'win32',
        requireMonitor: () => {
          throw new Error('Cannot find module windows-smtc-monitor.win32-x64-msvc.node');
        },
      }),
    ).toBeNull();
    expect(load({ platform: 'win32', requireMonitor: () => ({}) })).toBeNull();
    expect(
      load({ platform: 'win32', requireMonitor: () => ({ SMTCMonitor: class {} }) }),
    ).toBeNull();
  });

  it('returns the SMTCMonitor class', () => {
    expect(load({ platform: 'win32', requireMonitor: () => ({ SMTCMonitor: FakeMonitor }) })).toBe(
      FakeMonitor,
    );
  });
});

describe('PLAYBACK_STATUS', () => {
  it('matches the Windows enumeration', () => {
    expect(PLAYBACK_STATUS).toEqual({
      CLOSED: 0,
      OPENED: 1,
      CHANGING: 2,
      STOPPED: 3,
      PLAYING: 4,
      PAUSED: 5,
    });
  });
});
