import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOLUME_SETTING,
  clampVolume,
  stepVolume,
  volumeIconLevel,
  volumeLabel,
  volumeToGain,
} from './volume';

describe('clampVolume', () => {
  it('keeps values inside 0–200 and rounds', () => {
    expect(clampVolume(-10)).toBe(0);
    expect(clampVolume(250)).toBe(200);
    expect(clampVolume(99.6)).toBe(100);
    expect(clampVolume(Number.NaN)).toBe(100);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe('volumeToGain', () => {
  it('maps percent to linear gain with 200 % boost', () => {
    expect(volumeToGain(DEFAULT_VOLUME_SETTING)).toBe(1);
    expect(volumeToGain({ volume: 200, muted: false })).toBe(2);
    expect(volumeToGain({ volume: 50, muted: false })).toBe(0.5);
    expect(volumeToGain({ volume: 0, muted: false })).toBe(0);
  });

  it('is zero while muted regardless of the slider', () => {
    expect(volumeToGain({ volume: 150, muted: true })).toBe(0);
  });
});

describe('labels and icon levels', () => {
  it('describes the setting in pt-BR', () => {
    expect(volumeLabel({ volume: 150, muted: false })).toBe('150%');
    expect(volumeLabel({ volume: 150, muted: true })).toBe('Mudo');
    expect(volumeLabel({ volume: 0, muted: false })).toBe('Mudo');
  });

  it('picks the icon level', () => {
    expect(volumeIconLevel({ volume: 100, muted: true })).toBe('muted');
    expect(volumeIconLevel({ volume: 0, muted: false })).toBe('muted');
    expect(volumeIconLevel({ volume: 30, muted: false })).toBe('low');
    expect(volumeIconLevel({ volume: 60, muted: false })).toBe('high');
  });
});

describe('stepVolume', () => {
  it('moves in 5 % steps and clamps', () => {
    expect(stepVolume(100, 1)).toBe(105);
    expect(stepVolume(100, -3)).toBe(85);
    expect(stepVolume(198, 1)).toBe(200);
    expect(stepVolume(2, -1)).toBe(0);
  });
});
