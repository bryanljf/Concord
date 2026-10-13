import type { UserInfo } from '@concord/shared';

/** True when every field the UI shows (name, avatar, Discord name, nickname, admin) matches. */
export function sameUser(a: UserInfo | null, b: UserInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.admin === b.admin &&
    (a.avatarUrl ?? null) === (b.avatarUrl ?? null) &&
    (a.discordName ?? null) === (b.discordName ?? null) &&
    (a.nickname ?? null) === (b.nickname ?? null)
  );
}
