import { afterEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  WEB_CAPABILITIES,
  capabilities,
  clientKind,
  isWeb,
  joinPurpose,
  selfIdentity,
} from './capabilities';

type TestWindow = { concord?: Record<string, unknown> } | undefined;

// Node has no `window`: the tests install a minimal one with just the bridge fields they need.
const globalRef = globalThis as unknown as { window?: TestWindow };

function installBridge(bridge: Record<string, unknown> | undefined): void {
  globalRef.window = bridge ? { concord: bridge } : undefined;
}

afterEach(() => {
  delete globalRef.window;
});

describe('capabilities without a bridge (tests)', () => {
  it('answers as the desktop app', () => {
    expect(clientKind()).toBe('desktop');
    expect(isWeb()).toBe(false);
    expect(capabilities()).toBe(DESKTOP_CAPABILITIES);
    expect(joinPurpose()).toBe('main');
  });

  it('keeps the user id as the identity', () => {
    expect(selfIdentity('bryan')).toBe('bryan');
  });
});

describe('capabilities with the web bridge', () => {
  it('reads the client, its capabilities and the join purpose', () => {
    installBridge({ client: 'web', capabilities: WEB_CAPABILITIES, joinPurpose: 'web' });
    expect(clientKind()).toBe('web');
    expect(isWeb()).toBe(true);
    expect(capabilities()).toBe(WEB_CAPABILITIES);
    expect(joinPurpose()).toBe('web');
  });

  it('joins with the web identity', () => {
    installBridge({ client: 'web', capabilities: WEB_CAPABILITIES, joinPurpose: 'web' });
    expect(selfIdentity('bryan')).toBe('bryan~web');
  });

  it('falls back to the desktop values when the bridge lacks the fields (older preload)', () => {
    installBridge({ platform: 'win32' });
    expect(clientKind()).toBe('desktop');
    expect(capabilities()).toBe(DESKTOP_CAPABILITIES);
    expect(selfIdentity('bryan')).toBe('bryan');
  });
});

describe('capability tables', () => {
  it('give the web only the camera and the native picture-in-picture', () => {
    const enabled = Object.entries(WEB_CAPABILITIES)
      .filter(([, value]) => value)
      .map(([name]) => name);
    expect(enabled).toEqual(['camera', 'nativeVideoPip']);
  });

  it('give the desktop everything but the native picture-in-picture', () => {
    const disabled = Object.entries(DESKTOP_CAPABILITIES)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    expect(disabled).toEqual(['nativeVideoPip']);
  });
});
