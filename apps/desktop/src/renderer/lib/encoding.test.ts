import { describe, expect, it } from 'vitest';
import {
  STREAM_FRAME_RATES,
  STREAM_RESOLUTIONS,
  streamQualityId,
  streamQualityOf,
} from '@concord/shared';
import {
  SCREEN_SHARE_AUDIO_PRESET,
  displayMediaConstraints,
  encodingParams,
  isHeavyStreamQuality,
  screenShareEncoding,
  streamQualityDescription,
  streamQualityLabel,
  streamUploadHint,
} from './encoding';

const ALL_QUALITIES = STREAM_RESOLUTIONS.flatMap((resolution) =>
  STREAM_FRAME_RATES.map((fps) => streamQualityId(resolution, fps)),
);

describe('screenShareEncoding', () => {
  it('maps bitrate and fps from the quality', () => {
    expect(screenShareEncoding(streamQualityOf('720p30'))).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
    });
    expect(screenShareEncoding(streamQualityOf('1080p60'))).toEqual({
      maxBitrate: 6_000_000,
      maxFramerate: 60,
    });
    expect(screenShareEncoding(streamQualityOf('480p15'))).toEqual({
      maxBitrate: 800_000,
      maxFramerate: 15,
    });
  });
});

describe('displayMediaConstraints', () => {
  it('asks for the resolution as ideal and caps the frame rate', () => {
    expect(displayMediaConstraints(streamQualityOf('1440p60'), false)).toEqual({
      video: {
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        frameRate: { ideal: 60, max: 60 },
      },
      audio: false,
    });
    expect(displayMediaConstraints(streamQualityOf('480p15'), true)).toEqual({
      video: {
        width: { ideal: 854 },
        height: { ideal: 480 },
        frameRate: { ideal: 15, max: 15 },
      },
      audio: true,
    });
  });
});

describe('encodingParams', () => {
  it.each(ALL_QUALITIES)(
    '%s keeps the frame rate and lowers the resolution under pressure',
    (id) => {
      expect(encodingParams(id).contentHint).toBe('motion');
      expect(encodingParams(id).degradationPreference).toBe('maintain-framerate');
    },
  );

  it('bundles the content hint, encoding and audio preset', () => {
    expect(encodingParams('1080p60')).toEqual({
      contentHint: 'motion',
      screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 60 },
      degradationPreference: 'maintain-framerate',
      audioPreset: SCREEN_SHARE_AUDIO_PRESET,
    });
    expect(SCREEN_SHARE_AUDIO_PRESET.maxBitrate).toBe(128_000);
  });
});

describe('labels', () => {
  it('formats labels, descriptions and the upload hint in pt-BR', () => {
    expect(streamQualityLabel('1080p60')).toBe('1080p · 60 fps');
    expect(streamQualityLabel('480p15')).toBe('480p · 15 fps');
    expect(streamQualityDescription('720p30')).toBe('720p · 30 fps · até 2,5 Mbps');
    expect(streamQualityDescription('1440p60')).toBe('1440p · 60 fps · até 9,5 Mbps');
    expect(streamUploadHint('1080p30')).toBe('Upload de até 4 Mbps');
  });

  it('flags only 1440p as heavy', () => {
    expect(ALL_QUALITIES.filter(isHeavyStreamQuality)).toEqual(['1440p15', '1440p30', '1440p60']);
  });
});
