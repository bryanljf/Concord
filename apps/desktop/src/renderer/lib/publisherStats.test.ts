import { describe, expect, it } from 'vitest';
import {
  buildPublisherSummary,
  decodePublisherSummary,
  encodePublisherSummary,
  MAX_SUMMARY_BYTES,
  readPublisherStats,
  statsAttributeKey,
  type PublisherSummary,
} from './publisherStats';
import type { OutboundPoint, OutboundWindow } from './rtcStats';

const SUMMARY: PublisherSummary = {
  v: 1,
  at: 1_760_000_000_000,
  targetFps: 30,
  captureFps: 29.9,
  encodeFps: 24.5,
  sentFps: 24.4,
  width: 1920,
  height: 1080,
  captureWidth: 2560,
  captureHeight: 1440,
  bitrateKbps: 3950,
  targetBitrateKbps: 4000,
  limitation: 'bandwidth',
  cpuShare: 0.05,
  bandwidthShare: 0.42,
  encoder: 'SimulcastEncoderAdapter (OpenH264, OpenH264)',
  hardware: false,
  codec: 'H264',
  encodeMs: 6.2,
  uplinkKbps: 5100,
  rttMs: 35,
  lossPercent: 0.4,
  layers: [
    { rid: 'q', width: 960, height: 540, fps: 30, kbps: 1000, active: true },
    { rid: 'h', width: 1920, height: 1080, fps: 24.4, kbps: 2950, active: true },
  ],
};

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('statsAttributeKey', () => {
  it('has one attribute per video kind', () => {
    expect(statsAttributeKey('screen')).toBe('concord.stats.screen');
    expect(statsAttributeKey('camera')).toBe('concord.stats.camera');
  });
});

describe('encodePublisherSummary / decodePublisherSummary', () => {
  it('round-trips a typical summary within the size bound', () => {
    const json = encodePublisherSummary(SUMMARY);
    expect(bytes(json)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(JSON.parse(json)).toMatchObject({ v: 1, tf: 30, lim: 'bandwidth', hw: 0 });
    expect(decodePublisherSummary(json)).toEqual(SUMMARY);
  });

  it('round-trips unknown values as null', () => {
    const sparse: PublisherSummary = {
      ...SUMMARY,
      captureFps: null,
      limitation: null,
      hardware: null,
      encoder: null,
      codec: null,
      uplinkKbps: null,
      layers: [],
    };
    expect(decodePublisherSummary(encodePublisherSummary(sparse))).toEqual(sparse);
  });

  it('shortens the encoder name, then drops the layers, to stay under 400 bytes', () => {
    const huge: PublisherSummary = {
      ...SUMMARY,
      encoder: 'X'.repeat(500),
      layers: Array.from({ length: 4 }, (_, index) => ({
        rid: `layer${index}`,
        width: 16_000,
        height: 16_000,
        fps: 999.9,
        kbps: 999_999,
        active: true,
      })),
    };
    const json = encodePublisherSummary(huge);
    expect(bytes(json)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    const decoded = decodePublisherSummary(json);
    expect(decoded?.targetFps).toBe(30);
    expect(decoded?.encoder?.length).toBeLessThanOrEqual(64);
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['not JSON', 'not json'],
    ['an array', '[1,2]'],
    ['another version', '{"v":2,"at":1760000000000}'],
    ['no timestamp', '{"v":1}'],
    ['a bad timestamp', '{"v":1,"at":"yesterday"}'],
    ['not a string', 42],
    ['too long', `{"v":1,"at":1,"enc":"${'x'.repeat(5000)}"}`],
  ])('rejects %s', (_, raw) => {
    expect(decodePublisherSummary(raw)).toBeNull();
  });

  it('drops fields with wrong types or out-of-range values', () => {
    const decoded = decodePublisherSummary(
      JSON.stringify({
        v: 1,
        at: 1_760_000_000_000,
        tf: 'thirty',
        cf: -5,
        sf: 1e9,
        lim: 'gpu',
        cpu: 3,
        hw: 'yes',
        co: 'H264<script>',
        ly: [['q', 960, 540, 30, 1000, 1], 'garbage', [{}, 1, 2, 3, 4, 5]],
      }),
    );
    expect(decoded).toMatchObject({
      targetFps: null,
      captureFps: null,
      sentFps: null,
      limitation: null,
      cpuShare: null,
      hardware: null,
      codec: null,
      layers: [{ rid: 'q', width: 960, height: 540, fps: 30, kbps: 1000, active: true }],
    });
  });
});

describe('readPublisherStats', () => {
  it('tells a missing attribute from an unreadable one', () => {
    expect(readPublisherStats({}, 'screen')).toEqual({ status: 'missing' });
    expect(readPublisherStats({ 'concord.stats.screen': '' }, 'screen')).toEqual({
      status: 'missing',
    });
    expect(readPublisherStats(undefined, 'camera')).toEqual({ status: 'missing' });
    expect(readPublisherStats({ 'concord.stats.camera': '{' }, 'camera')).toEqual({
      status: 'invalid',
    });
    const ok = readPublisherStats(
      { 'concord.stats.camera': encodePublisherSummary(SUMMARY) },
      'camera',
    );
    expect(ok).toEqual({ status: 'ok', summary: SUMMARY });
  });
});

describe('buildPublisherSummary', () => {
  it('takes the rates from the window and the encoder from the latest point', () => {
    const window: OutboundWindow = {
      seconds: 5,
      captureFps: 29.94,
      encodeFps: 24.46,
      sentFps: 24.42,
      bitrate: 3_950_400,
      targetBitrate: 4_000_000,
      encodeMs: 6.24,
      qp: 30,
      cpuShare: 0.051,
      bandwidthShare: 0.4249,
      hugeFrames: 0,
      nacks: 0,
      plis: 0,
      keyFrames: 0,
      remoteLossPercent: 0.43,
      rttMs: 35.2,
      uplink: 5_100_200,
      layers: [
        {
          rid: 'q',
          active: true,
          width: 960,
          height: 540,
          encodeFps: 30,
          sentFps: 30,
          bitrate: 1_000_100,
          targetBitrate: 1_000_000,
          limitation: 'none',
        },
        {
          rid: 'h',
          active: true,
          width: 1920,
          height: 1080,
          encodeFps: 24.4,
          sentFps: 24.4,
          bitrate: 2_950_300,
          targetBitrate: 3_000_000,
          limitation: 'bandwidth',
        },
      ],
    };
    const latest = {
      width: 1920,
      height: 1080,
      captureWidth: 2560,
      captureHeight: 1440,
      targetBitrate: 4_000_000,
      limitation: 'bandwidth',
      encoder: 'SimulcastEncoderAdapter (OpenH264, OpenH264)',
      hardware: false,
      codec: 'video/H264',
    } as OutboundPoint;
    const summary = buildPublisherSummary({ at: SUMMARY.at, targetFps: 30, window, latest });
    expect(summary).toEqual(SUMMARY);
  });
});
