/** Avatars are only loaded from Discord's CDN (the CSP `img-src` allows nothing else remote). */
const AVATAR_HOST = 'cdn.discordapp.com';

export function isDiscordAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === AVATAR_HOST && url.port === '';
  } catch {
    return false;
  }
}

/**
 * Which image the avatar should show: `src` when it is a Discord CDN URL that has not failed to
 * load yet, otherwise null (the initials are shown instead).
 */
export function avatarImageSrc(
  src: string | null | undefined,
  failedSrc: string | null,
): string | null {
  if (!src || src === failedSrc) return null;
  return isDiscordAvatarUrl(src) ? src : null;
}
