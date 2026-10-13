import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOLUME,
  DEFAULT_VOLUME_SETTING,
  MAX_VOLUME,
  clampVolume,
  normalizeVolumeSetting,
  stepVolume,
  toggleMuteSetting,
  volumeIconLevel,
  volumeLabel,
  volumeToGain,
} from './volume';

describe('defaults', () => {
  it('starts every live at 50 % and caps at 100 %', () => {
    expect(DEFAULT_VOLUME).toBe(50);
    expect(MAX_VOLUME).toBe(100);
    expect(DEFAULT_VOLUME_SETTING).toEqual({ volume: 50, muted: false });
  });
});

describe('clampVolume', () => {
  it('keeps values inside 0–100 and rounds', () => {
    expect(clampVolume(-10)).toBe(0);
    expect(clampVolume(150)).toBe(100);
    expect(clampVolume(200)).toBe(100);
    expect(clampVolume(49.6)).toBe(50);
    expect(clampVolume(Number.NaN)).toBe(50);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(50);
  });
});

describe('normalizeVolumeSetting', () => {
  it('clamps values remembered from the old 200 % range', () => {
    expect(normalizeVolumeSetting({ volume: 180, muted: true })).toEqual({
      volume: 100,
      muted: true,
    });
  });

  it('returns the same object when already in range', () => {
    const setting = { volume: 70, muted: false };
    expect(normalizeVolumeSetting(setting)).toBe(setting);
  });
});

describe('volumeToGain', () => {
  it('maps percent to linear gain, 1.0 at most', () => {
    expect(volumeToGain(DEFAULT_VOLUME_SETTING)).toBe(0.5);
    expect(volumeToGain({ volume: 100, muted: false })).toBe(1);
    expect(volumeToGain({ volume: 200, muted: false })).toBe(1);
    expect(volumeToGain({ volume: 0, muted: false })).toBe(0);
  });

  it('is zero while muted regardless of the slider', () => {
    expect(volumeToGain({ volume: 80, muted: true })).toBe(0);
  });
});

describe('toggleMuteSetting', () => {
  it('mutes keeping the volume, and unmuting restores it', () => {
    const muted = toggleMuteSetting({ volume: 70, muted: false });
    expect(muted).toEqual({ volume: 70, muted: true });
    expect(toggleMuteSetting(muted)).toEqual({ volume: 70, muted: false });
  });

  it('brings a slider left at 0 back at the default', () => {
    expect(toggleMuteSetting({ volume: 0, muted: false })).toEqual({ volume: 50, muted: false });
    expect(toggleMuteSetting({ volume: 0, muted: true })).toEqual({ volume: 50, muted: false });
  });

  it('clamps an old out-of-range volume on the way', () => {
    expect(toggleMuteSetting({ volume: 160, muted: true })).toEqual({ volume: 100, muted: false });
  });
});

describe('labels and icon levels', () => {
  it('describes the setting in pt-BR', () => {
    expect(volumeLabel({ volume: 75, muted: false })).toBe('75%');
    expect(volumeLabel({ volume: 150, muted: false })).toBe('100%');
    expect(volumeLabel({ volume: 75, muted: true })).toBe('Mudo');
    expect(volumeLabel({ volume: 0, muted: false })).toBe('Mudo');
  });

  it('picks the icon level', () => {
    expect(volumeIconLevel({ volume: 100, muted: true })).toBe('muted');
    expect(volumeIconLevel({ volume: 0, muted: false })).toBe('muted');
    expect(volumeIconLevel({ volume: 30, muted: false })).toBe('low');
    expect(volumeIconLevel({ volume: 50, muted: false })).toBe('high');
  });
});

describe('stepVolume', () => {
  it('moves in 5 % steps and clamps', () => {
    expect(stepVolume(50, 1)).toBe(55);
    expect(stepVolume(50, -3)).toBe(35);
    expect(stepVolume(98, 1)).toBe(100);
    expect(stepVolume(2, -1)).toBe(0);
  });
});
