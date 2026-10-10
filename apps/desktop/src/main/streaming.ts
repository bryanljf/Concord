import type { StreamingState } from '../preload/api';
import { log } from './log';
import {
  expectBoolean,
  expectNullableString,
  expectQualityPresetId,
  expectRoomId,
  IpcValidationError,
  isRecord,
} from './validation';

const logger = log('streaming');

export const INACTIVE_STREAMING_STATE: StreamingState = {
  active: false,
  room: null,
  sourceName: null,
  quality: null,
};

/** Window titles can be long; the tooltip only needs the beginning. */
export const MAX_SOURCE_NAME_LENGTH = 200;

/** Validates a `setStreamingState` payload; an inactive state is normalised to all-null. */
export function parseStreamingState(raw: unknown): StreamingState {
  if (!isRecord(raw)) throw new IpcValidationError('state');
  const active = expectBoolean(raw.active, 'active');
  if (!active) return INACTIVE_STREAMING_STATE;
  return {
    active: true,
    room: raw.room === null ? null : expectRoomId(raw.room),
    sourceName: expectNullableString(raw.sourceName, 'sourceName', MAX_SOURCE_NAME_LENGTH),
    quality: raw.quality === null ? null : expectQualityPresetId(raw.quality),
  };
}

export function isSameStreamingState(a: StreamingState, b: StreamingState): boolean {
  return (
    a.active === b.active &&
    a.room === b.room &&
    a.sourceName === b.sourceName &&
    a.quality === b.quality
  );
}

/** Tray tooltip detail while this instance is live, e.g. "você está ao vivo em #jogos (Elden Ring)". */
export function streamingTrayDetail(state: StreamingState): string | null {
  if (!state.active) return null;
  let detail = 'você está ao vivo';
  if (state.room) detail += ` em #${state.room}`;
  if (state.sourceName) detail += ` (${state.sourceName})`;
  return detail;
}

export type StreamingListener = (state: StreamingState) => void;

export interface StreamingStore {
  get(): StreamingState;
  /** Returns true when the state actually changed (listeners are only notified then). */
  set(state: StreamingState): boolean;
  onChange(listener: StreamingListener): () => void;
}

/** Mirror of what the renderer publishes; main uses it for the tray and the pop-out. */
export function createStreamingStore(): StreamingStore {
  let state = INACTIVE_STREAMING_STATE;
  const listeners = new Set<StreamingListener>();
  return {
    get: () => state,
    set(next) {
      if (isSameStreamingState(state, next)) return false;
      state = next;
      logger.info(next.active ? `live: ${streamingTrayDetail(next)}` : 'stopped');
      for (const listener of listeners) listener(next);
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
