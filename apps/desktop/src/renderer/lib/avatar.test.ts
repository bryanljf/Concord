import { describe, expect, it } from 'vitest';
import { avatarImageSrc, isDiscordAvatarUrl } from './avatar';

const url = 'https://cdn.discordapp.com/avatars/1/a.png';

describe('isDiscordAvatarUrl', () => {
  it('only accepts https on cdn.discordapp.com', () => {
    expect(isDiscordAvatarUrl(url)).toBe(true);
    expect(isDiscordAvatarUrl('http://cdn.discordapp.com/a.png')).toBe(false);
    expect(isDiscordAvatarUrl('https://cdn.discordapp.com:444/a.png')).toBe(false);
    expect(isDiscordAvatarUrl('https://evil.example/a.png')).toBe(false);
    expect(isDiscordAvatarUrl('nope')).toBe(false);
  });
});

describe('avatarImageSrc', () => {
  it('shows the image until it fails, then falls back to initials (null)', () => {
    expect(avatarImageSrc(url, null)).toBe(url);
    expect(avatarImageSrc(url, url)).toBeNull();
    // A new avatar URL gets a fresh chance even after the previous one failed.
    const next = 'https://cdn.discordapp.com/avatars/1/b.png';
    expect(avatarImageSrc(next, url)).toBe(next);
  });

  it('falls back to initials when there is no usable src', () => {
    expect(avatarImageSrc(undefined, null)).toBeNull();
    expect(avatarImageSrc(null, null)).toBeNull();
    expect(avatarImageSrc('', null)).toBeNull();
    expect(avatarImageSrc('https://evil.example/a.png', null)).toBeNull();
  });
});
