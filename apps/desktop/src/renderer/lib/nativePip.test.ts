import { describe, expect, it } from 'vitest';
import {
  escapeAttributeValue,
  nativePipAvailable,
  nativePipMethod,
  streamVideoSelector,
} from './nativePip';

describe('streamVideoSelector', () => {
  it('targets the video inside the tile carrying the stream key', () => {
    expect(streamVideoSelector('ana')).toBe('[data-stream-key="ana"] video');
    expect(streamVideoSelector('ana~web#camera')).toBe('[data-stream-key="ana~web#camera"] video');
  });

  it('escapes quotes and backslashes (never part of a real key)', () => {
    expect(escapeAttributeValue('a"b\\c')).toBe('a\\"b\\\\c');
    expect(streamVideoSelector('x"y')).toBe('[data-stream-key="x\\"y"] video');
  });
});

describe('nativePipMethod', () => {
  const standard = { requestPictureInPicture: () => undefined };
  const webkit = {
    webkitSetPresentationMode: () => undefined,
    webkitSupportsPresentationMode: (mode: string) => mode === 'picture-in-picture',
  };

  it('prefers the standard API when the document allows it', () => {
    expect(nativePipMethod(standard, { pictureInPictureEnabled: true })).toBe('standard');
    expect(nativePipMethod({ ...standard, ...webkit }, { pictureInPictureEnabled: true })).toBe(
      'standard',
    );
  });

  it('falls back to Safari presentation modes', () => {
    expect(nativePipMethod(webkit, { pictureInPictureEnabled: false })).toBe('webkit');
    expect(nativePipMethod(webkit, {})).toBe('webkit');
    expect(nativePipMethod({ ...standard, ...webkit }, {})).toBe('webkit');
  });

  it('is null when nothing is available or the video opted out', () => {
    expect(nativePipMethod({}, { pictureInPictureEnabled: true })).toBeNull();
    expect(nativePipMethod(standard, { pictureInPictureEnabled: false })).toBeNull();
    expect(
      nativePipMethod(
        { ...standard, disablePictureInPicture: true },
        { pictureInPictureEnabled: true },
      ),
    ).toBeNull();
    expect(
      nativePipMethod(
        { ...webkit, webkitSupportsPresentationMode: () => false },
        { pictureInPictureEnabled: false },
      ),
    ).toBeNull();
  });
});

describe('nativePipAvailable', () => {
  it('reads the document flag', () => {
    expect(nativePipAvailable({ pictureInPictureEnabled: true })).toBe(true);
    expect(nativePipAvailable({ pictureInPictureEnabled: false })).toBe(false);
    expect(nativePipAvailable({})).toBe(false);
  });
});
