import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '@concord/shared';
import {
  SCREEN_SHARE_AUDIO_PRESET,
  degradationPreference,
  displayMediaConstraints,
  encodingParams,
  presetDescription,
  presetShortLabel,
  screenShareEncoding,
} from './encoding';

describe('screenShareEncoding', () => {
  it('maps bitrate and fps from every preset', () => {
    expect(screenShareEncoding(QUALITY_PRESETS.light)).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
    });
    expect(screenShareEncoding(QUALITY_PRESETS.standard)).toEqual({
      maxBitrate: 4_000_000,
      maxFramerate: 30,
    });
    expect(screenShareEncoding(QUALITY_PRESETS.game)).toEqual({
      maxBitrate: 6_000_000,
      maxFramerate: 60,
    });
  });
});

describe('displayMediaConstraints', () => {
  it('asks for the preset resolution as ideal and caps the frame rate', () => {
    expect(displayMediaConstraints(QUALITY_PRESETS.game, false)).toEqual({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, max: 60 },
      },
      audio: false,
    });
    expect(displayMediaConstraints(QUALITY_PRESETS.light, true).audio).toBe(true);
  });
});

describe('degradationPreference / encodingParams', () => {
  it('keeps the frame rate for games and the resolution otherwise', () => {
    expect(degradationPreference(QUALITY_PRESETS.game)).toBe('maintain-framerate');
    expect(degradationPreference(QUALITY_PRESETS.standard)).toBe('maintain-resolution');
    expect(degradationPreference(QUALITY_PRESETS.light)).toBe('maintain-resolution');
  });

  it('bundles the content hint, encoding and audio preset', () => {
    expect(encodingParams('game')).toEqual({
      contentHint: 'motion',
      screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 60 },
      degradationPreference: 'maintain-framerate',
      audioPreset: SCREEN_SHARE_AUDIO_PRESET,
    });
    expect(encodingParams('light').contentHint).toBe('detail');
    expect(SCREEN_SHARE_AUDIO_PRESET.maxBitrate).toBe(128_000);
  });
});

describe('labels', () => {
  it('formats short labels and descriptions in pt-BR', () => {
    expect(presetShortLabel('game')).toBe('1080p60');
    expect(presetShortLabel('light')).toBe('720p30');
    expect(presetDescription('light')).toBe('720p30 · até 2,5 Mbps');
    expect(presetDescription('standard')).toBe('1080p30 · até 4 Mbps');
  });
});
