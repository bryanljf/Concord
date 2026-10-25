/** Per-stream playback volume (0–100 %) and mute, mapped to a Web Audio gain. */

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 100;
/**
 * Every live (and the Jam) starts here: 70 % plays at gain ≈ 0.49, as loud as the old linear 50 %
 * did, leaving the upper part of the slider room to get louder.
 */
export const DEFAULT_VOLUME = 70;
export const VOLUME_STEP = 1;

export interface VolumeSetting {
  /** Percent, 0–100. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_VOLUME_SETTING: VolumeSetting = { volume: DEFAULT_VOLUME, muted: false };

/** Clamps to 0–100 and rounds; anything that is not a finite number becomes the default (70). */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(volume)));
}

/** A remembered setting brought inside the current range (older values could reach 200 %). */
export function normalizeVolumeSetting(setting: VolumeSetting): VolumeSetting {
  const volume = clampVolume(setting.volume);
  return volume === setting.volume ? setting : { ...setting, volume };
}

/**
 * Gain for a `GainNode` on a perceptual (squared) curve: 50 % → 0.25, 70 % → 0.49, 100 % → 1 (the
 * maximum), muted → 0. Loudness is heard logarithmically: with a linear gain everything above 50 %
 * spans only 6 dB and barely changes; squared, the whole slider makes audible steps.
 */
export function volumeToGain(setting: VolumeSetting): number {
  if (setting.muted) return 0;
  const fraction = clampVolume(setting.volume) / 100;
  return fraction * fraction;
}

/**
 * The mute toggle (button, M key, menu): muting keeps the volume, so unmuting brings back the
 * previous non-zero value; a slider left at 0 comes back at the default instead of staying silent.
 */
export function toggleMuteSetting(setting: VolumeSetting): VolumeSetting {
  const volume = clampVolume(setting.volume);
  if (setting.muted || volume === 0) {
    return { volume: volume > 0 ? volume : DEFAULT_VOLUME, muted: false };
  }
  return { volume, muted: true };
}

/** "Mudo" / "50%" (slider labels and tooltips). */
export function volumeLabel(setting: VolumeSetting): string {
  if (setting.muted || setting.volume === 0) return 'Mudo';
  return `${clampVolume(setting.volume)}%`;
}

/** Keyboard/scroll adjustments, clamped. */
export function stepVolume(volume: number, steps: number): number {
  return clampVolume(volume + steps * VOLUME_STEP);
}

/** Three-level icon state for the speaker button. */
export type VolumeIconLevel = 'muted' | 'low' | 'high';

export function volumeIconLevel(setting: VolumeSetting): VolumeIconLevel {
  if (setting.muted || setting.volume === 0) return 'muted';
  return setting.volume < 50 ? 'low' : 'high';
}
