import { describe, expect, it } from 'vitest';
import { parseCaptureSourceId } from './source-id';

describe('parseCaptureSourceId', () => {
  it('parses window ids with a decimal HWND', () => {
    expect(parseCaptureSourceId('window:1324:0')).toEqual({ kind: 'window', handle: 1324 });
    expect(parseCaptureSourceId('window:197150:1')).toEqual({ kind: 'window', handle: 197150 });
  });

  it('parses screen ids', () => {
    expect(parseCaptureSourceId('screen:0:0')).toEqual({ kind: 'screen', index: 0 });
    expect(parseCaptureSourceId('screen:2:0')).toEqual({ kind: 'screen', index: 2 });
  });

  it('rejects anything else', () => {
    expect(parseCaptureSourceId('')).toBeNull();
    expect(parseCaptureSourceId('window:0:0')).toBeNull();
    expect(parseCaptureSourceId('window:abc:0')).toBeNull();
    expect(parseCaptureSourceId('window:1324')).toBeNull();
    expect(parseCaptureSourceId('tab:1:0')).toBeNull();
    expect(parseCaptureSourceId('window:99999999999999999:0')).toBeNull();
    expect(parseCaptureSourceId(' window:1:0')).toBeNull();
  });
});
