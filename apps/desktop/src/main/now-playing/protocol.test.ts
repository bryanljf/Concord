import { describe, expect, it } from 'vitest';
import { ART_ID_PATTERN, artIdOf, parseMainMessage, parseWorkerMessage } from './protocol';

describe('artIdOf', () => {
  it('is a stable 16-hex-digit hash of the bytes', () => {
    const id = artIdOf(new Uint8Array([1, 2, 3]));
    expect(id).toMatch(ART_ID_PATTERN);
    expect(artIdOf(Buffer.from([1, 2, 3]))).toBe(id);
    expect(artIdOf(new Uint8Array([1, 2, 4]))).not.toBe(id);
  });
});

describe('parseWorkerMessage', () => {
  it('sanitises session snapshots', () => {
    expect(
      parseWorkerMessage({
        type: 'sessions',
        sessions: [
          {
            sourceAppId: 'Spotify.exe',
            title: 'Song',
            artist: 7,
            album: 'Album',
            playbackStatus: 4,
            positionSec: -1,
            durationSec: Number.NaN,
            lastUpdatedTime: 5,
            artId: 'not-an-id',
          },
          { title: 'no app id' },
        ],
      }),
    ).toEqual({
      type: 'sessions',
      sessions: [
        {
          sourceAppId: 'Spotify.exe',
          title: 'Song',
          artist: '',
          album: 'Album',
          playbackStatus: 4,
          positionSec: 0,
          durationSec: 0,
          lastUpdatedTime: 5,
          artId: null,
        },
      ],
    });
  });

  it('accepts art, unavailable and log messages; rejects the rest', () => {
    const bytes = new Uint8Array([1]);
    expect(parseWorkerMessage({ type: 'art', artId: '0123456789abcdef', bytes })).toEqual({
      type: 'art',
      artId: '0123456789abcdef',
      bytes,
    });
    expect(parseWorkerMessage({ type: 'art', artId: '0123456789abcdef', bytes: [1] })).toBeNull();
    expect(
      parseWorkerMessage({ type: 'art', artId: '0123456789abcdef', bytes: new Uint8Array(0) }),
    ).toBeNull();
    expect(parseWorkerMessage({ type: 'unavailable', reason: 'x' })).toEqual({
      type: 'unavailable',
      reason: 'x',
    });
    expect(parseWorkerMessage({ type: 'log', level: 'error', message: 'm' })).toEqual({
      type: 'log',
      level: 'info',
      message: 'm',
    });
    expect(parseWorkerMessage({ type: 'eval' })).toBeNull();
    expect(parseWorkerMessage('sessions')).toBeNull();
  });
});

describe('parseMainMessage', () => {
  it('only knows forget-art with a valid id', () => {
    expect(parseMainMessage({ type: 'forget-art', artId: '0123456789abcdef' })).toEqual({
      type: 'forget-art',
      artId: '0123456789abcdef',
    });
    expect(parseMainMessage({ type: 'forget-art', artId: 'zz' })).toBeNull();
    expect(parseMainMessage({ type: 'quit' })).toBeNull();
  });
});
