/** Per-stream playback volume (0–200 %) and mute, mapped to a Web Audio gain. */

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 200;
export const DEFAULT_VOLUME = 100;
export const VOLUME_STEP = 5;

export interface VolumeSetting {
  /** Percent, 0–200. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_VOLUME_SETTING: VolumeSetting = { volume: DEFAULT_VOLUME, muted: false };

/** Clamps to 0–200 and rounds; anything that is not a finite number becomes 100. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(volume)));
}

/** Gain for a `GainNode`: 100 % → 1, 200 % → 2, muted → 0. */
export function volumeToGain(setting: VolumeSetting): number {
  if (setting.muted) return 0;
  return clampVolume(setting.volume) / 100;
}

/** "Mudo" / "150%" (slider labels and tooltips). */
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
  return setting.volume < 60 ? 'low' : 'high';
}
