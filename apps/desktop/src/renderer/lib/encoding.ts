import { QUALITY_PRESETS, type QualityPreset, type QualityPresetId } from '@concord/shared';

/**
 * Pure helpers that turn a quality preset into capture constraints and livekit-client publish
 * parameters. Kept free of livekit imports so they stay testable in Node; the hook that
 * publishes adds `Track.Source.*` on top (see `hooks/useBroadcast.ts`).
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

export function presetOf(id: QualityPresetId): QualityPreset {
  return QUALITY_PRESETS[id];
}

/**
 * `getDisplayMedia` constraints: `ideal` so a smaller screen still captures, `max` on the frame
 * rate so a 30 fps preset does not capture at 60 and waste encoder time.
 */
export function displayMediaConstraints(
  preset: QualityPreset,
  systemAudio: boolean,
): DisplayMediaStreamOptions {
  return {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    },
    audio: systemAudio,
  };
}

/** livekit reads `screenShareEncoding` (not `videoEncoding`) for `Track.Source.ScreenShare`. */
export function screenShareEncoding(preset: QualityPreset): ScreenShareEncoding {
  return { maxBitrate: preset.maxBitrate, maxFramerate: preset.fps };
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

/** Everything the broadcast hook needs from a preset, in one place. */
export interface EncodingParams {
  contentHint: typeof SCREEN_SHARE_CONTENT_HINT;
  screenShareEncoding: ScreenShareEncoding;
  degradationPreference: DegradationPreference;
  audioPreset: AudioEncoding;
}

export function encodingParams(id: QualityPresetId): EncodingParams {
  const preset = presetOf(id);
  return {
    contentHint: SCREEN_SHARE_CONTENT_HINT,
    screenShareEncoding: screenShareEncoding(preset),
    degradationPreference: DEGRADATION_PREFERENCE,
    audioPreset: SCREEN_SHARE_AUDIO_PRESET,
  };
}

/** "1080p60" */
export function presetShortLabel(id: QualityPresetId): string {
  const preset = presetOf(id);
  return `${preset.height}p${preset.fps}`;
}

/** "1080p60 · até 6 Mbps" */
export function presetDescription(id: QualityPresetId): string {
  const preset = presetOf(id);
  const mbps = (preset.maxBitrate / 1_000_000).toLocaleString('pt-BR');
  return `${presetShortLabel(id)} · até ${mbps} Mbps`;
}
