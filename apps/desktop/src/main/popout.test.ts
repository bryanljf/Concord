import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    destroyed = false;
    pinned = false;
    private readonly listeners = new Map<string, (() => void)[]>();
    readonly webContents = { on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    constructor(readonly options: Record<string, unknown>) {
      this.pinned = options.alwaysOnTop === true;
      FakeWindow.instances.push(this);
    }
    isDestroyed = (): boolean => this.destroyed;
    isMinimized = vi.fn(() => false);
    isFullScreen = (): boolean => false;
    isAlwaysOnTop = (): boolean => this.pinned;
    setAlwaysOnTop = vi.fn((pinned: boolean) => {
      this.pinned = pinned;
    });
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
    on(event: string, listener: () => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: () => void): this {
      return this.on(event, listener);
    }
    close(): void {
      this.destroyed = true;
      for (const listener of this.listeners.get('closed') ?? []) listener();
    }
    destroy(): void {
      this.close();
    }
  }
  return { FakeWindow };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '' },
  shell: { openExternal: vi.fn() },
  BrowserWindow: mocks.FakeWindow,
}));

import { EVENTS } from '../preload/channels';
import { createPopoutManager, MAX_PARTICIPANT_ID_LENGTH, parsePopoutTarget } from './popout';
import { IpcValidationError } from './validation';
import type { WindowRegistry } from './windows';

describe('parsePopoutTarget', () => {
  it('accepts a room and a participant id', () => {
    expect(parsePopoutTarget({ room: 'jogos', participantId: 'ana' })).toEqual({
      room: 'jogos',
      participantId: 'ana',
    });
  });

  it('drops unknown fields', () => {
    expect(parsePopoutTarget({ room: 'jogos', participantId: 'ana', extra: 1 })).toEqual({
      room: 'jogos',
      participantId: 'ana',
    });
  });

  it('rejects bad shapes', () => {
    expect(() => parsePopoutTarget(null)).toThrow(IpcValidationError);
    expect(() => parsePopoutTarget('jogos')).toThrow(IpcValidationError);
    expect(() => parsePopoutTarget({ room: 'sala inválida', participantId: 'ana' })).toThrow(
      IpcValidationError,
    );
    expect(() => parsePopoutTarget({ room: 'jogos', participantId: '' })).toThrow(
      IpcValidationError,
    );
    expect(() => parsePopoutTarget({ room: 'jogos', participantId: 7 })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parsePopoutTarget({
        room: 'jogos',
        participantId: 'a'.repeat(MAX_PARTICIPANT_ID_LENGTH + 1),
      }),
    ).toThrow(IpcValidationError);
  });
});

describe('createPopoutManager', () => {
  const ana = { room: 'jogos', participantId: 'ana' };
  const bia = { room: 'jogos', participantId: 'bia' };

  function setup() {
    const broadcast = vi.fn();
    const registry = { add: vi.fn(() => () => undefined), broadcast } as unknown as WindowRegistry;
    return { broadcast, popout: createPopoutManager({ registry }) };
  }

  beforeEach(() => {
    mocks.FakeWindow.instances.length = 0;
  });

  it('broadcasts its state on open, re-target and close', () => {
    const { broadcast, popout } = setup();
    expect(popout.getState()).toEqual({ open: false, target: null });

    popout.open(ana);
    expect(broadcast).toHaveBeenLastCalledWith(EVENTS.POPOUT_STATE, { open: true, target: ana });
    popout.open(bia);
    expect(mocks.FakeWindow.instances).toHaveLength(1);
    expect(broadcast).toHaveBeenLastCalledWith(EVENTS.POPOUT_STATE, { open: true, target: bia });
    expect(popout.getState()).toEqual({ open: true, target: bia });

    popout.close();
    expect(broadcast).toHaveBeenLastCalledWith(EVENTS.POPOUT_STATE, { open: false, target: null });
    expect(popout.getState()).toEqual({ open: false, target: null });
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it('does not broadcast when destroyed on quit', () => {
    const { broadcast, popout } = setup();
    popout.open(ana);
    broadcast.mockClear();
    popout.destroy();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('focuses the pop-out on demand and reports its pin', () => {
    const { popout } = setup();
    popout.focus(); // closed: no-op
    expect(popout.getAlwaysOnTop()).toBe(false);
    popout.setAlwaysOnTop(true);
    expect(popout.getAlwaysOnTop()).toBe(true);

    popout.open(ana);
    const win = mocks.FakeWindow.instances[0];
    expect(win?.options.alwaysOnTop).toBe(true);
    win?.isMinimized.mockReturnValue(true);
    win?.focus.mockClear();
    popout.focus();
    expect(win?.restore).toHaveBeenCalled();
    expect(win?.focus).toHaveBeenCalledTimes(1);

    popout.setAlwaysOnTop(false);
    expect(popout.getAlwaysOnTop()).toBe(false);
  });
});
