import { describe, expect, it } from 'vitest';
import { parseAvatarUrl, parseProfileName } from './profile';

describe('parseAvatarUrl', () => {
  it('accepts https URLs on cdn.discordapp.com', () => {
    const url = 'https://cdn.discordapp.com/avatars/123/abc.png?size=128';
    expect(parseAvatarUrl(url)).toBe(url);
    expect(parseAvatarUrl('https://cdn.discordapp.com/embed/avatars/0.png')).toBe(
      'https://cdn.discordapp.com/embed/avatars/0.png',
    );
  });

  it('rejects other hosts, schemes, ports, credentials and non-strings', () => {
    expect(parseAvatarUrl(undefined)).toBeNull();
    expect(parseAvatarUrl(null)).toBeNull();
    expect(parseAvatarUrl(42)).toBeNull();
    expect(parseAvatarUrl('')).toBeNull();
    expect(parseAvatarUrl('not a url')).toBeNull();
    expect(parseAvatarUrl('http://cdn.discordapp.com/avatars/1/a.png')).toBeNull();
    expect(parseAvatarUrl('https://media.discordapp.net/avatars/1/a.png')).toBeNull();
    expect(parseAvatarUrl('https://cdn.discordapp.com.evil.example/a.png')).toBeNull();
    expect(parseAvatarUrl('https://evil.example/?cdn.discordapp.com')).toBeNull();
    expect(parseAvatarUrl('https://cdn.discordapp.com:8443/a.png')).toBeNull();
    expect(parseAvatarUrl('https://user:pw@cdn.discordapp.com/a.png')).toBeNull();
    expect(parseAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(parseAvatarUrl(`https://cdn.discordapp.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('parseProfileName', () => {
  it('keeps non-blank strings and drops everything else', () => {
    expect(parseProfileName('Bryan')).toBe('Bryan');
    expect(parseProfileName('  ')).toBeNull();
    expect(parseProfileName('')).toBeNull();
    expect(parseProfileName(null)).toBeNull();
    expect(parseProfileName(undefined)).toBeNull();
    expect(parseProfileName(7)).toBeNull();
    expect(parseProfileName('x'.repeat(101))).toBeNull();
  });
});
