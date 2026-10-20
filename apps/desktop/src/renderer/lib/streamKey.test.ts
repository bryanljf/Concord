import { describe, expect, it } from 'vitest';
import { cameraKey, isCameraKey, parseStreamKey, streamKey } from './streamKey';

describe('streamKey', () => {
  it('keeps the bare participant id for the screen share', () => {
    expect(streamKey('ana', 'screen')).toBe('ana');
  });

  it('suffixes the camera', () => {
    expect(streamKey('ana', 'camera')).toBe('ana#camera');
    expect(cameraKey('bob-2')).toBe('bob-2#camera');
  });

  it('parses both kinds back', () => {
    expect(parseStreamKey('ana')).toEqual({ participantId: 'ana', kind: 'screen' });
    expect(parseStreamKey('ana#camera')).toEqual({ participantId: 'ana', kind: 'camera' });
    expect(isCameraKey('ana#camera')).toBe(true);
    expect(isCameraKey('ana')).toBe(false);
  });
});
