import { describe, expect, it } from 'vitest';
import { audioSwitchAction, planSourceSwitch, sourceKindOf } from './sourceSwitch';

describe('audioSwitchAction', () => {
  it('replaces the audio in place when both sources carry audio', () => {
    expect(audioSwitchAction(true, true)).toBe('replace');
  });

  it('unpublishes the audio when the new source has none', () => {
    expect(audioSwitchAction(true, false)).toBe('unpublish');
  });

  it('publishes audio when the new source adds it', () => {
    expect(audioSwitchAction(false, true)).toBe('publish');
  });

  it('does nothing when neither has audio', () => {
    expect(audioSwitchAction(false, false)).toBe('keep-none');
  });
});

describe('planSourceSwitch', () => {
  it('stops the old process capture first only when the new one is also per-process', () => {
    expect(
      planSourceSwitch(
        { quality: 'standard', processAudio: true },
        { quality: 'standard', audio: 'process' },
      ).stopOldProcessAudioFirst,
    ).toBe(true);
    expect(
      planSourceSwitch(
        { quality: 'standard', processAudio: true },
        { quality: 'standard', audio: 'system' },
      ).stopOldProcessAudioFirst,
    ).toBe(false);
    expect(
      planSourceSwitch(
        { quality: 'standard', processAudio: false },
        { quality: 'standard', audio: 'process' },
      ).stopOldProcessAudioFirst,
    ).toBe(false);
  });

  it('re-encodes only when the quality preset changes', () => {
    expect(
      planSourceSwitch(
        { quality: 'standard', processAudio: false },
        { quality: 'game', audio: 'none' },
      ).reencode,
    ).toBe(true);
    expect(
      planSourceSwitch(
        { quality: 'standard', processAudio: false },
        { quality: 'standard', audio: 'none' },
      ).reencode,
    ).toBe(false);
  });
});

describe('sourceKindOf', () => {
  it('reads the kind from Electron desktopCapturer ids', () => {
    expect(sourceKindOf('screen:0:0')).toBe('screen');
    expect(sourceKindOf('window:1234:0')).toBe('window');
  });
});
