import { describe, expect, it } from 'vitest';
import {
  CLEAN_BEFORE_UP_MS,
  MUSIC_MAX_KBPS,
  audioNetworkSample,
  initialAudioQuality,
  nextAudioQuality,
  type AudioQualityState,
} from './audioQuality';

const clean = { lossFraction: 0, rttMs: 30 };

describe('nextAudioQuality', () => {
  it('starts and stays at the best quality on a clean connection', () => {
    let state = initialAudioQuality();
    for (let t = 0; t < 60_000; t += 2_000) state = nextAudioQuality(state, clean, t);
    expect(state.kbps).toBe(MUSIC_MAX_KBPS);
  });

  it('steps down on packet loss, one step per bad sample', () => {
    let state = initialAudioQuality();
    state = nextAudioQuality(state, { lossFraction: 0.05, rttMs: 30 }, 0);
    expect(state.kbps).toBe(256);
    state = nextAudioQuality(state, { lossFraction: 0.05, rttMs: 30 }, 2_000);
    expect(state.kbps).toBe(192);
  });

  it('steps down when the round trip climbs well above its best (queues)', () => {
    let state = nextAudioQuality(initialAudioQuality(), clean, 0);
    state = nextAudioQuality(state, { lossFraction: 0, rttMs: 200 }, 2_000);
    expect(state.kbps).toBe(256);
  });

  it('never goes below the lowest step', () => {
    let state: AudioQualityState = { kbps: 64, bestRttMs: 30, cleanSince: null };
    state = nextAudioQuality(state, { lossFraction: 0.5, rttMs: 30 }, 0);
    expect(state.kbps).toBe(64);
  });

  it('climbs back one step after a clean while, always trying the best', () => {
    let state: AudioQualityState = { kbps: 128, bestRttMs: 30, cleanSince: null };
    state = nextAudioQuality(state, clean, 0);
    state = nextAudioQuality(state, clean, CLEAN_BEFORE_UP_MS - 1);
    expect(state.kbps).toBe(128);
    state = nextAudioQuality(state, clean, CLEAN_BEFORE_UP_MS);
    expect(state.kbps).toBe(160);
    state = nextAudioQuality(state, clean, CLEAN_BEFORE_UP_MS + 2_000);
    expect(state.kbps).toBe(160); // waits another clean while
    state = nextAudioQuality(state, clean, 2 * CLEAN_BEFORE_UP_MS);
    expect(state.kbps).toBe(192);
  });

  it('holds (without climbing) on moderate loss', () => {
    let state: AudioQualityState = { kbps: 192, bestRttMs: 30, cleanSince: 0 };
    state = nextAudioQuality(state, { lossFraction: 0.01, rttMs: 30 }, 20_000);
    expect(state).toMatchObject({ kbps: 192, cleanSince: null });
  });

  it('copes with missing stats', () => {
    const state = nextAudioQuality(initialAudioQuality(), { lossFraction: null, rttMs: null }, 0);
    expect(state.kbps).toBe(MUSIC_MAX_KBPS);
  });
});

describe('audioNetworkSample', () => {
  it('reads the remote-inbound loss and round trip', () => {
    const report = new Map<string, Record<string, unknown>>([
      [
        'r',
        { type: 'remote-inbound-rtp', kind: 'audio', fractionLost: 0.03, roundTripTime: 0.045 },
      ],
      ['p', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.05 }],
    ]) as unknown as RTCStatsReport;
    expect(audioNetworkSample(report)).toEqual({ lossFraction: 0.03, rttMs: 45 });
  });

  it('falls back to the candidate pair round trip', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['p', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.05 }],
    ]) as unknown as RTCStatsReport;
    expect(audioNetworkSample(report)).toEqual({ lossFraction: null, rttMs: 50 });
  });
});
