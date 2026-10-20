import { describe, expect, it } from 'vitest';
import {
  CAMERA_ENCODING,
  cameraConstraints,
  cameraErrorMessage,
  cameraLabel,
  toVideoInputs,
} from './cameraEncoding';

function domError(name: string): { name: string; message: string } {
  return { name, message: `${name} happened` };
}

describe('cameraConstraints', () => {
  it('asks for 720p30 from the system default camera', () => {
    expect(cameraConstraints(null)).toEqual({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
  });

  it('requires the saved device exactly', () => {
    const video = cameraConstraints('cam-1').video as MediaTrackConstraints;
    expect(video.deviceId).toEqual({ exact: 'cam-1' });
    expect(video.width).toEqual({ ideal: 1280 });
  });
});

describe('CAMERA_ENCODING', () => {
  it('caps the top layer at 1.5 Mbps and 30 fps', () => {
    expect(CAMERA_ENCODING).toEqual({ maxBitrate: 1_500_000, maxFramerate: 30 });
  });
});

describe('cameraLabel', () => {
  it('drops the USB ids Windows appends', () => {
    expect(cameraLabel('HD Pro Webcam C920 (046d:082d)')).toBe('HD Pro Webcam C920');
    expect(cameraLabel('Integrated Camera')).toBe('Integrated Camera');
  });

  it('falls back when the label is empty', () => {
    expect(cameraLabel('')).toBe('Câmera');
    expect(cameraLabel('  ', 'Câmera 2')).toBe('Câmera 2');
  });
});

describe('toVideoInputs', () => {
  it('keeps the webcams with an id and names the unnamed ones', () => {
    expect(
      toVideoInputs([
        { kind: 'audioinput', deviceId: 'mic', label: 'Microfone' },
        { kind: 'videoinput', deviceId: 'a', label: 'Webcam (1234:abcd)' },
        { kind: 'videoinput', deviceId: 'b', label: '' },
        { kind: 'videoinput', deviceId: '', label: '' },
        { kind: 'audiooutput', deviceId: 'default', label: 'Padrão' },
      ]),
    ).toEqual([
      { id: 'a', label: 'Webcam' },
      { id: 'b', label: 'Câmera 2' },
    ]);
  });
});

describe('cameraErrorMessage', () => {
  it('points to the Windows privacy setting when access is blocked', () => {
    expect(cameraErrorMessage(domError('NotAllowedError'))).toMatch(/Privacidade e segurança/);
    expect(cameraErrorMessage(domError('SecurityError'))).toMatch(/O Windows bloqueou a câmera/);
  });

  it('explains a busy or missing camera', () => {
    expect(cameraErrorMessage(domError('NotReadableError'))).toBe(
      'A câmera está em uso por outro aplicativo.',
    );
    expect(cameraErrorMessage(domError('TrackStartError'))).toMatch(/em uso/);
    expect(cameraErrorMessage(domError('NotFoundError'))).toMatch(/Câmera não encontrada/);
    expect(cameraErrorMessage(domError('OverconstrainedError'))).toMatch(/não encontrada/);
  });

  it('never leaks an English message', () => {
    expect(cameraErrorMessage(domError('AbortError'))).toBe('Não foi possível ligar a câmera.');
    expect(cameraErrorMessage(new Error('Could not start video source'))).toBe(
      'Não foi possível ligar a câmera.',
    );
    expect(cameraErrorMessage(undefined)).toBe('Não foi possível ligar a câmera.');
  });
});
