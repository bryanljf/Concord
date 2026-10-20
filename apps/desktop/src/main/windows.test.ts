import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true },
  shell: { openExternal: vi.fn() },
}));

import type { BrowserWindow, WebContents, WebFrameMain } from 'electron';
import { EVENTS } from '../preload/channels';
import { createWindowRegistry, isHttpUrl, type AppWindow, type WindowKind } from './windows';

function makeWindow(kind: WindowKind, frameTreeNodeId: number) {
  let destroyed = false;
  let onClosed: (() => void) | null = null;
  const webContents = {
    mainFrame: { frameTreeNodeId, processId: 7 },
  } as unknown as WebContents;
  const browserWindow = {
    webContents,
    isDestroyed: () => destroyed,
    once: vi.fn((_event: string, listener: () => void) => {
      onClosed = listener;
    }),
  } as unknown as BrowserWindow;
  const window: AppWindow = { kind, browserWindow, send: vi.fn() };
  return {
    window,
    webContents,
    close: () => {
      destroyed = true;
      onClosed?.();
    },
  };
}

describe('createWindowRegistry', () => {
  it('trusts only registered, live windows', () => {
    const registry = createWindowRegistry();
    const main = makeWindow('main', 1);
    const popout = makeWindow('popout', 2);
    const stranger = makeWindow('popout', 3);
    const pip = makeWindow('pip', 4);
    registry.add(main.window);
    registry.add(popout.window);
    registry.add(pip.window);
    expect(registry.fromSender(pip.webContents)?.kind).toBe('pip');
    pip.close();

    expect(registry.fromSender(main.webContents)).toBe(main.window);
    expect(registry.fromSender(popout.webContents)?.kind).toBe('popout');
    expect(registry.isTrustedSender(stranger.webContents)).toBe(false);
    expect(registry.all()).toHaveLength(2);

    popout.close();
    expect(registry.isTrustedSender(popout.webContents)).toBe(false);
    expect(registry.all()).toEqual([main.window]);
  });

  it('supports early removal', () => {
    const registry = createWindowRegistry();
    const main = makeWindow('main', 1);
    const remove = registry.add(main.window);
    remove();
    expect(registry.isTrustedSender(main.webContents)).toBe(false);
  });

  it('recognises the main frame of a registered window', () => {
    const registry = createWindowRegistry();
    const main = makeWindow('main', 1);
    registry.add(main.window);
    const frame = (id: number, processId = 7) =>
      ({ frameTreeNodeId: id, processId }) as unknown as WebFrameMain;
    expect(registry.isTrustedFrame(frame(1))).toBe(true);
    expect(registry.isTrustedFrame(frame(1, 8))).toBe(false);
    expect(registry.isTrustedFrame(frame(2))).toBe(false);
    expect(registry.isTrustedFrame(null)).toBe(false);
  });

  it('broadcasts to every live window', () => {
    const registry = createWindowRegistry();
    const main = makeWindow('main', 1);
    const popout = makeWindow('popout', 2);
    registry.add(main.window);
    registry.add(popout.window);
    popout.close();

    registry.broadcast(EVENTS.STREAMING_STATE, { active: false });
    expect(main.window.send).toHaveBeenCalledWith(EVENTS.STREAMING_STATE, { active: false });
    expect(popout.window.send).not.toHaveBeenCalled();
  });
});

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://github.com/x')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isHttpUrl('file:///C:/x')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});
