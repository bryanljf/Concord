import { describe, expect, it } from 'vitest';
import { isMusicAppId, MUSIC_APP_IDS, MUSIC_APPS, musicAppFromAumid } from './music-apps';
import { expectMusicAppId, IpcValidationError } from './validation';

describe('musicAppFromAumid', () => {
  it('recognises the spotify.com installer and the Microsoft Store build', () => {
    expect(musicAppFromAumid('Spotify.exe')).toBe('spotify');
    expect(musicAppFromAumid('spotify.exe')).toBe('spotify');
    expect(musicAppFromAumid('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')).toBe('spotify');
    expect(musicAppFromAumid('spotifyab.spotifymusic_ABC123!spotify')).toBe('spotify');
  });

  it('ignores other apps and look-alikes', () => {
    for (const aumid of [
      'Chrome',
      'MSEdge',
      '308046B0AF4A39CB',
      'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic',
      'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Other',
      'NotSpotify.exe',
      'Spotify.exe.bak',
      '',
    ]) {
      expect(musicAppFromAumid(aumid)).toBeNull();
    }
  });
});

describe('music app ids', () => {
  it('lists Spotify with its process name and label', () => {
    expect(MUSIC_APP_IDS).toEqual(['spotify']);
    expect(MUSIC_APPS.spotify).toMatchObject({ label: 'Spotify', processNames: ['Spotify.exe'] });
  });

  it('validates ids from the renderer', () => {
    expect(isMusicAppId('spotify')).toBe(true);
    expect(isMusicAppId('toString')).toBe(false);
    expect(isMusicAppId(1)).toBe(false);
    expect(expectMusicAppId('spotify')).toBe('spotify');
    expect(() => expectMusicAppId('tidal')).toThrow(IpcValidationError);
    expect(() => expectMusicAppId(undefined)).toThrow(IpcValidationError);
  });
});
