import { describe, expect, it } from 'vitest';
import { JAM_BOT_IDENTITY, JAM_TRACK_NAME } from '@concord/shared';
import { Track } from 'livekit-client';
import {
  findMusicPublication,
  formatTrackTime,
  musicTrackOrigin,
  type MusicPublicationFields,
} from './music';

describe('formatTrackTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTrackTime(187_000)).toBe('3:07');
    expect(formatTrackTime(3_723_000)).toBe('1:02:03');
    expect(formatTrackTime(-5)).toBe('0:00');
  });
});

describe('musicTrackOrigin', () => {
  it('recognizes the Jam', () => {
    expect(musicTrackOrigin(JAM_BOT_IDENTITY, JAM_TRACK_NAME)).toEqual({ kind: 'jam' });
  });

  it('takes the Jam only from the jam bot, and only the Jam from it', () => {
    expect(musicTrackOrigin('ana', JAM_TRACK_NAME)).toBeNull();
    expect(musicTrackOrigin(JAM_BOT_IDENTITY, 'concord:music:other')).toBeNull();
    expect(musicTrackOrigin(JAM_BOT_IDENTITY, 'Valorant')).toBeNull();
    expect(musicTrackOrigin('ana', 'concord:music:other')).toBeNull();
    expect(musicTrackOrigin('ana', 'Valorant')).toBeNull();
  });
});

describe('findMusicPublication', () => {
  const publication = (
    trackName: string,
    source: Track.Source = Track.Source.Microphone,
    kind: Track.Kind = Track.Kind.Audio,
  ): MusicPublicationFields & { id: string } => ({ id: trackName, trackName, source, kind });

  it('finds the Jam among the jam bot\x27s tracks', () => {
    const jam = publication(JAM_TRACK_NAME);
    const found = findMusicPublication(JAM_BOT_IDENTITY, [publication('other'), jam]);
    expect(found?.publication).toBe(jam);
    expect(found?.origin).toEqual({ kind: 'jam' });
  });

  it('needs an audio track with the Microphone source', () => {
    expect(
      findMusicPublication(JAM_BOT_IDENTITY, [
        publication(JAM_TRACK_NAME, Track.Source.ScreenShareAudio),
        publication(JAM_TRACK_NAME, Track.Source.Microphone, Track.Kind.Video),
      ]),
    ).toBeNull();
    expect(findMusicPublication('ana', [publication(JAM_TRACK_NAME)])).toBeNull();
    expect(findMusicPublication('ana', [publication('concord:music:other')])).toBeNull();
    expect(findMusicPublication('ana', [])).toBeNull();
  });
});
