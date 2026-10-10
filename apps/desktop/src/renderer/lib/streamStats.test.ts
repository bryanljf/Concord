import { describe, expect, it } from 'vitest';
import { codecName, deriveStats, formatBitrate, formatStats } from './streamStats';

describe('deriveStats', () => {
  it('needs two samples far enough apart', () => {
    const sample = { timestamp: 1000, bytesReceived: 100, framesDecoded: 10 };
    expect(deriveStats(null, sample)).toBeNull();
    expect(deriveStats(sample, { ...sample, timestamp: 1100 })).toBeNull();
  });

  it('computes bitrate and fps from deltas', () => {
    const prev = { timestamp: 1000, bytesReceived: 0, framesDecoded: 0 };
    const next = {
      timestamp: 3000,
      bytesReceived: 1_000_000,
      framesDecoded: 120,
      frameWidth: 1920,
      frameHeight: 1080,
      codec: 'video/H264',
    };
    expect(deriveStats(prev, next)).toEqual({
      bitrate: 4_000_000,
      fps: 60,
      width: 1920,
      height: 1080,
      codec: 'H264',
    });
  });

  it('never reports negative values after a stats reset', () => {
    const prev = { timestamp: 1000, bytesReceived: 5000, framesDecoded: 50 };
    const next = { timestamp: 2000, bytesReceived: 100, framesDecoded: 2 };
    expect(deriveStats(prev, next)).toMatchObject({ bitrate: 0, fps: 0, width: null, codec: null });
  });
});

describe('formatting', () => {
  it('formats bitrates in pt-BR', () => {
    expect(formatBitrate(4_200_000)).toBe('4,2 Mbps');
    expect(formatBitrate(850_000)).toBe('850 kbps');
    expect(formatBitrate(0)).toBe('0 kbps');
  });

  it('extracts codec names', () => {
    expect(codecName('video/VP9')).toBe('VP9');
    expect(codecName('video/h264')).toBe('H264');
    expect(codecName(undefined)).toBeNull();
    expect(codecName('')).toBeNull();
  });

  it('joins the known parts', () => {
    expect(
      formatStats({ bitrate: 4_200_000, fps: 60, width: 1920, height: 1080, codec: 'H264' }),
    ).toBe('1920×1080 · 60 fps · 4,2 Mbps · H264');
    expect(formatStats({ bitrate: 500_000, fps: 30, width: null, height: null, codec: null })).toBe(
      '30 fps · 500 kbps',
    );
  });
});
