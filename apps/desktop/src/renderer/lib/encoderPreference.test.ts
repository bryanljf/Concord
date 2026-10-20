import { describe, expect, it } from 'vitest';
import { orderCodecsFor } from './encoderPreference';

const h264 = (profile: string, mode = 1): RTCRtpCodec => ({
  mimeType: 'video/H264',
  clockRate: 90000,
  sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`,
});
const other = (mimeType: string): RTCRtpCodec => ({ mimeType, clockRate: 90000 });

// The order Chromium (and so livekit-client) lists them, H.264 first for `videoCodec: 'h264'`.
const CHROMIUM = [
  h264('42001f'),
  h264('42001f', 0),
  h264('42e01f'),
  h264('42e01f', 0),
  h264('4d001f'),
  h264('4d001f', 0),
  h264('640032'),
  other('video/VP8'),
  other('video/rtx'),
  other('video/red'),
];

const profiles = (codecs: RTCRtpCodec[]): string[] =>
  codecs.map(
    (codec) => /profile-level-id=(\w+)/.exec(codec.sdpFmtpLine ?? '')?.[1] ?? codec.mimeType,
  );

describe('orderCodecsFor', () => {
  it('keeps the order for the CPU (Constrained Baseline, OpenH264)', () => {
    expect(orderCodecsFor('cpu', CHROMIUM)).toEqual(CHROMIUM);
  });

  it('puts the profiles a hardware encoder takes first for the GPU', () => {
    expect(profiles(orderCodecsFor('gpu', CHROMIUM))).toEqual([
      '640032',
      '4d001f',
      '4d001f',
      '42001f',
      '42001f',
      '42e01f',
      '42e01f',
      'video/VP8',
      'video/rtx',
      'video/red',
    ]);
  });

  it('keeps the other codecs in their slots', () => {
    const mixed = [other('video/VP8'), h264('42e01f'), other('video/rtx'), h264('640032')];
    expect(profiles(orderCodecsFor('gpu', mixed))).toEqual([
      'video/VP8',
      '640032',
      'video/rtx',
      '42e01f',
    ]);
  });

  it('leaves Constrained Baseline alone when nothing else is offered (no hardware encoder)', () => {
    const softwareOnly = [h264('42e01f'), h264('42e01f', 0), other('video/VP8')];
    expect(orderCodecsFor('gpu', softwareOnly)).toEqual(softwareOnly);
  });
});
