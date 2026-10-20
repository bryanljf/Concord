import { describe, expect, it, vi } from 'vitest';
import {
  createStreamingStore,
  INACTIVE_STREAMING_STATE,
  isSameStreamingState,
  MAX_SOURCE_NAME_LENGTH,
  parseStreamingState,
  streamingTrayDetail,
} from './streaming';
import { IpcValidationError } from './validation';

const live = { active: true, room: 'jogos', sourceName: 'Elden Ring', quality: '1080p60' } as const;

describe('parseStreamingState', () => {
  it('accepts an active state and trims the source name', () => {
    expect(parseStreamingState({ ...live, sourceName: '  Elden Ring ' })).toEqual(live);
  });

  it('allows nulls while active', () => {
    expect(
      parseStreamingState({ active: true, room: null, sourceName: null, quality: null }),
    ).toEqual({ active: true, room: null, sourceName: null, quality: null });
  });

  it('normalises an inactive state to all-null', () => {
    expect(
      parseStreamingState({ active: false, room: 'jogos', sourceName: 'x', quality: '1080p60' }),
    ).toBe(INACTIVE_STREAMING_STATE);
  });

  it('rejects bad shapes', () => {
    expect(() => parseStreamingState(undefined)).toThrow(IpcValidationError);
    expect(() => parseStreamingState({ ...live, active: 'yes' })).toThrow(IpcValidationError);
    expect(() => parseStreamingState({ ...live, room: 'sala com espaço' })).toThrow(
      IpcValidationError,
    );
    expect(() => parseStreamingState({ ...live, quality: 'ultra' })).toThrow(IpcValidationError);
    expect(() => parseStreamingState({ ...live, quality: '1080p45' })).toThrow(IpcValidationError);
    expect(parseStreamingState({ ...live, quality: '480p15' }).quality).toBe('480p15');
    expect(() => parseStreamingState({ ...live, sourceName: 42 })).toThrow(IpcValidationError);
    expect(() =>
      parseStreamingState({ ...live, sourceName: 'x'.repeat(MAX_SOURCE_NAME_LENGTH + 1) }),
    ).toThrow(IpcValidationError);
  });
});

describe('streamingTrayDetail', () => {
  it('describes the transmission in pt-BR', () => {
    expect(streamingTrayDetail(live)).toBe('você está ao vivo em Jogos (Elden Ring)');
    expect(streamingTrayDetail({ ...live, sourceName: null })).toBe('você está ao vivo em Jogos');
    expect(streamingTrayDetail({ ...live, room: null, sourceName: null })).toBe(
      'você está ao vivo',
    );
    expect(streamingTrayDetail(INACTIVE_STREAMING_STATE)).toBeNull();
  });
});

describe('createStreamingStore', () => {
  it('starts inactive and notifies only on real changes', () => {
    const store = createStreamingStore();
    const listener = vi.fn();
    store.onChange(listener);
    expect(store.get()).toBe(INACTIVE_STREAMING_STATE);

    expect(store.set({ ...INACTIVE_STREAMING_STATE })).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(store.set(live)).toBe(true);
    expect(store.get()).toEqual(live);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(live);

    expect(store.set({ ...live })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(store.set(INACTIVE_STREAMING_STATE)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes listeners', () => {
    const store = createStreamingStore();
    const listener = vi.fn();
    store.onChange(listener)();
    store.set(live);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('isSameStreamingState', () => {
  it('compares field by field', () => {
    expect(isSameStreamingState(live, { ...live })).toBe(true);
    expect(isSameStreamingState(live, { ...live, quality: '720p30' })).toBe(false);
  });
});
