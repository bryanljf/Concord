import { describe, expect, it } from 'vitest';
import {
  EMPTY_GRID_AUDIO,
  audibleKey,
  chooseAudio,
  silencedKeys,
  unmuteInGrid,
  type GridAudioState,
} from './gridAudio';

const chosen = (...keys: string[]): GridAudioState =>
  keys.reduce((state, key) => chooseAudio(state, key), EMPTY_GRID_AUDIO);

describe('grid audio', () => {
  it('plays only the latest stream clicked or put in destaque', () => {
    const state = chosen('ana', 'beto', 'caio');
    expect(audibleKey(state, ['ana', 'beto', 'caio'])).toBe('caio');
    expect([...silencedKeys(state, ['ana', 'beto', 'caio'])]).toEqual(['ana', 'beto']);
    // Destaque on Ana, then back to the grid: Ana keeps the audio.
    const focused = chooseAudio(state, 'ana');
    expect(audibleKey(focused, ['ana', 'beto', 'caio'])).toBe('ana');
    expect([...silencedKeys(focused, ['ana', 'beto', 'caio'])]).toEqual(['beto', 'caio']);
  });

  it('never gives the audio to a webcam nor silences one', () => {
    const state = chooseAudio(chosen('ana'), 'beto#camera');
    expect(state).toEqual(chosen('ana'));
    expect(audibleKey(state, ['ana', 'beto#camera'])).toBe('ana');
    expect(silencedKeys(state, ['ana', 'beto#camera']).size).toBe(0);
  });

  it('lets a silenced stream be turned up until the next choice', () => {
    const state = unmuteInGrid(chosen('ana', 'beto'), 'ana');
    expect(silencedKeys(state, ['ana', 'beto']).size).toBe(0);
    expect(unmuteInGrid(state, 'ana')).toBe(state);
    const next = chooseAudio(state, 'caio');
    expect([...silencedKeys(next, ['ana', 'beto', 'caio'])]).toEqual(['ana', 'beto']);
    // Choosing the audible stream again also silences what was turned up.
    expect(chooseAudio(state, 'beto').unmuted).toEqual([]);
    expect(chooseAudio(chosen('beto'), 'beto')).toEqual(chosen('beto'));
  });

  it('hands the audio to the previous choice when the audible stream is gone', () => {
    const state = chosen('ana', 'beto', 'caio');
    expect(audibleKey(state, ['ana', 'beto'])).toBe('beto');
    expect([...silencedKeys(state, ['ana', 'beto'])]).toEqual(['ana']);
  });

  it('falls back to the latest watched screen share without any choice', () => {
    expect(audibleKey(EMPTY_GRID_AUDIO, ['ana', 'beto', 'caio#camera'])).toBe('beto');
    expect(audibleKey(EMPTY_GRID_AUDIO, ['caio#camera'])).toBeNull();
    expect(audibleKey(EMPTY_GRID_AUDIO, [])).toBeNull();
  });
});
