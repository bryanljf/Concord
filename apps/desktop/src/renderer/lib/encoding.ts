import { streamQualityOf, type StreamQuality, type StreamQualityId } from '@concord/shared';

/**
 * Pure helpers that turn a stream quality (resolution × frame rate) into capture constraints and
 * livekit-client publish parameters. Kept free of livekit imports so they stay testable in Node;
 * the hook that publishes adds `Track.Source.*` on top (see `hooks/useBroadcast.ts`).
 */

/** Shape of livekit's `VideoEncoding` (`screenShareEncoding` in `TrackPublishOptions`). */
export interface ScreenShareEncoding {
  maxBitrate: number;
  maxFramerate: number;
}

/** Shape of livekit's `AudioPreset` (`audioPreset` in `TrackPublishOptions`). */
export interface AudioEncoding {
  maxBitrate: number;
}

/** Same bitrate as livekit's `AudioPresets.musicHighQualityStereo` (verified in 2.22.3). */
export const SCREEN_SHARE_AUDIO_PRESET: AudioEncoding = { maxBitrate: 128_000 };

export type DegradationPreference = 'maintain-framerate' | 'maintain-resolution';

/**
 * `getDisplayMedia` constraints: `ideal` so a smaller screen still captures, `max` on the frame
 * rate so a 30 fps live does not capture at 60 and waste encoder time.
 */
export function displayMediaConstraints(
  quality: StreamQuality,
  systemAudio: boolean,
): DisplayMediaStreamOptions {
  return {
    video: {
      width: { ideal: quality.width },
      height: { ideal: quality.height },
      frameRate: { ideal: quality.fps, max: quality.fps },
    },
    audio: systemAudio,
  };
}

/** livekit reads `screenShareEncoding` (not `videoEncoding`) for `Track.Source.ScreenShare`. */
export function screenShareEncoding(quality: StreamQuality): ScreenShareEncoding {
  return { maxBitrate: quality.maxBitrate, maxFramerate: quality.fps };
}

/**
 * `motion` makes WebRTC treat the capture as camera-like content, and `maintain-framerate` makes
 * CPU overuse lower the resolution instead of the frame rate. That is all they do: with two
 * active simulcast layers WebRTC never downscales for bandwidth (quality scaling needs a single
 * active stream), so a frame that does not fit the bitrate is dropped by the encoder's rate
 * control (OpenH264 frame skip) or by WebRTC's FrameDropper. Keep the FrameDropper: v0.2.0
 * disabled it (`WebRTC-FrameDropper/Disabled/` field trial) and real lives got worse, with
 * overshooting frames queueing on slow uplinks (RTT ~500 ms, freezes) and capture starved of CPU.
 * The broadcaster's stats panel shows which stage (capture, encode, send) loses frames.
 */
export const SCREEN_SHARE_CONTENT_HINT = 'motion';
export const DEGRADATION_PREFERENCE: DegradationPreference = 'maintain-framerate';

/**
 * Everything the broadcast hook needs from a quality, in one place. The content hint and the
 * degradation preference are the same for every resolution and frame rate: frames come first.
 */
export interface EncodingParams {
  contentHint: typeof SCREEN_SHARE_CONTENT_HINT;
  screenShareEncoding: ScreenShareEncoding;
  degradationPreference: DegradationPreference;
  audioPreset: AudioEncoding;
}

export function encodingParams(id: StreamQualityId): EncodingParams {
  return {
    contentHint: SCREEN_SHARE_CONTENT_HINT,
    screenShareEncoding: screenShareEncoding(streamQualityOf(id)),
    degradationPreference: DEGRADATION_PREFERENCE,
    audioPreset: SCREEN_SHARE_AUDIO_PRESET,
  };
}

/** "4", "2,5", "0,8" (pt-BR decimal comma). */
function formatMbps(bps: number): string {
  return (bps / 1_000_000).toLocaleString('pt-BR');
}

/** "1080p · 60 fps" */
export function streamQualityLabel(id: StreamQualityId): string {
  const quality = streamQualityOf(id);
  return `${quality.height}p · ${quality.fps} fps`;
}

/** "1080p · 60 fps · até 6 Mbps" */
export function streamQualityDescription(id: StreamQualityId): string {
  return `${streamQualityLabel(id)} · até ${formatMbps(streamQualityOf(id).maxBitrate)} Mbps`;
}

/** "Upload de até 6 Mbps" (the cap of the top layer; the lower one adds a little). */
export function streamUploadHint(id: StreamQualityId): string {
  return `Upload de até ${formatMbps(streamQualityOf(id).maxBitrate)} Mbps`;
}

/** 1440p needs a strong PC (software encoding) and a fast uplink: the picker warns. */
export function isHeavyStreamQuality(id: StreamQualityId): boolean {
  return streamQualityOf(id).height >= 1440;
}
