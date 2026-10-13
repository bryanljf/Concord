import type { UserInfo } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import { sameUser } from './user';

const bryan: UserInfo = { id: 'bryan', displayName: 'Bryan', admin: false };

describe('sameUser', () => {
  it('detects profile changes and treats missing fields as null', () => {
    expect(sameUser(null, null)).toBe(true);
    expect(sameUser(bryan, null)).toBe(false);
    expect(sameUser(bryan, { ...bryan, avatarUrl: null, nickname: null })).toBe(true);
    expect(sameUser(bryan, { ...bryan, displayName: 'Bry' })).toBe(false);
    expect(
      sameUser(bryan, { ...bryan, avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' }),
    ).toBe(false);
    expect(sameUser(bryan, { ...bryan, nickname: 'Bry' })).toBe(false);
    expect(sameUser(bryan, { ...bryan, admin: true })).toBe(false);
  });
});
