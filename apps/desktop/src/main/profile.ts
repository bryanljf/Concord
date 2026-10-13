/**
 * Parsing of the optional Discord profile fields (avatar, names) that newer servers send in
 * `/api/me` and presence. Anything missing or malformed becomes null, so older servers and
 * stale `settings.json` files keep working.
 */

/** The only host avatars may be loaded from (also allowed by the renderer CSP `img-src`). */
export const AVATAR_HOST = 'cdn.discordapp.com';

const MAX_AVATAR_URL_LENGTH = 2048;
/** Generous cap for names coming from the server (Discord itself allows 32). */
const MAX_PROFILE_NAME_LENGTH = 100;

/** `https://cdn.discordapp.com/...` (no credentials, default port) or null. */
export function parseAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_AVATAR_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== AVATAR_HOST) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

/** A non-blank string of reasonable length, else null. */
export function parseProfileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === '' || value.length > MAX_PROFILE_NAME_LENGTH) return null;
  return value;
}
