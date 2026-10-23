import { describe, expect, it, vi } from 'vitest';
import {
  GPU_PRIORITY_CLASSES,
  parseGpuPriority,
  raiseGpuPriority,
  type GpuPriorityNative,
} from './gpu-priority';

function fakeNative(status = 0): GpuPriorityNative & { set: ReturnType<typeof vi.fn> } {
  return { set: vi.fn(() => status), get: () => GPU_PRIORITY_CLASSES.normal };
}

describe('parseGpuPriority', () => {
  it('accepts the class names, any case and padding', () => {
    expect(parseGpuPriority('realtime')).toBe('realtime');
    expect(parseGpuPriority(' High ')).toBe('high');
    expect(parseGpuPriority('below-normal')).toBe('below-normal');
  });

  it('rejects anything else', () => {
    expect(parseGpuPriority(undefined)).toBeNull();
    expect(parseGpuPriority('')).toBeNull();
    expect(parseGpuPriority('5')).toBeNull();
    expect(parseGpuPriority('toString')).toBeNull();
  });
});

describe('raiseGpuPriority', () => {
  it('sets REALTIME on Windows by default', () => {
    const native = fakeNative();
    const result = raiseGpuPriority({
      platform: 'win32',
      override: undefined,
      loadNative: () => native,
    });
    expect(native.set).toHaveBeenCalledWith(GPU_PRIORITY_CLASSES.realtime);
    expect(result).toEqual({ applied: true, priority: 'realtime' });
  });

  it('does nothing outside Windows, without loading the binding', () => {
    const loadNative = vi.fn(() => fakeNative());
    const result = raiseGpuPriority({ platform: 'linux', override: undefined, loadNative });
    expect(loadNative).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it('honours CONCORD_GPU_PRIORITY', () => {
    const native = fakeNative();
    const result = raiseGpuPriority({
      platform: 'win32',
      override: 'normal',
      loadNative: () => native,
    });
    expect(native.set).toHaveBeenCalledWith(GPU_PRIORITY_CLASSES.normal);
    expect(result).toEqual({ applied: true, priority: 'normal' });
  });

  it('falls back to REALTIME on an unknown CONCORD_GPU_PRIORITY', () => {
    const native = fakeNative();
    raiseGpuPriority({ platform: 'win32', override: 'turbo', loadNative: () => native });
    expect(native.set).toHaveBeenCalledWith(GPU_PRIORITY_CLASSES.realtime);
  });

  it('reports a missing binding', () => {
    const result = raiseGpuPriority({
      platform: 'win32',
      override: undefined,
      loadNative: () => null,
    });
    expect(result).toEqual({ applied: false, reason: 'native binding unavailable' });
  });

  it('reports a failed call with its NTSTATUS', () => {
    // STATUS_PRIVILEGE_NOT_HELD, as a signed int32 from the binding.
    const native = fakeNative(0xc0000061 | 0);
    const result = raiseGpuPriority({
      platform: 'win32',
      override: undefined,
      loadNative: () => native,
    });
    expect(result).toEqual({ applied: false, reason: 'NTSTATUS 0xC0000061' });
  });

  it('survives a binding that throws', () => {
    const native: GpuPriorityNative = {
      set: () => {
        throw new Error('boom');
      },
      get: () => null,
    };
    const result = raiseGpuPriority({
      platform: 'win32',
      override: undefined,
      loadNative: () => native,
    });
    expect(result).toEqual({ applied: false, reason: 'boom' });
  });
});
