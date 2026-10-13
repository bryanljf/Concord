import { NICKNAME_MAX_LENGTH, type UserInfo } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import { checkNickname, initialNicknameDraft } from './nickname';

const discordOnly: UserInfo = {
  id: 'bryan',
  displayName: 'Bryan',
  admin: false,
  discordName: 'Bryan',
  nickname: null,
};
const withNickname: UserInfo = { ...discordOnly, displayName: 'Bry', nickname: 'Bry' };

describe('initialNicknameDraft', () => {
  it('starts from the nickname, else the resolved display name', () => {
    expect(initialNicknameDraft(withNickname)).toBe('Bry');
    expect(initialNicknameDraft(discordOnly)).toBe('Bryan');
    expect(initialNicknameDraft({ id: 'x', displayName: 'Xis', admin: false })).toBe('Xis');
  });
});

describe('checkNickname', () => {
  it('accepts a trimmed new name', () => {
    expect(checkNickname('  Bryzinho ', discordOnly)).toEqual({ ok: true, nickname: 'Bryzinho' });
    expect(checkNickname('x'.repeat(NICKNAME_MAX_LENGTH), discordOnly)).toEqual({
      ok: true,
      nickname: 'x'.repeat(NICKNAME_MAX_LENGTH),
    });
  });

  it('counts code points like the server', () => {
    expect(checkNickname('🎮'.repeat(NICKNAME_MAX_LENGTH), discordOnly).ok).toBe(true);
    expect(checkNickname('🎮'.repeat(NICKNAME_MAX_LENGTH + 1), discordOnly).ok).toBe(false);
  });

  it('rejects blank and too long names with pt-BR messages', () => {
    expect(checkNickname('   ', discordOnly)).toEqual({
      ok: false,
      error: 'Digite um nome de exibição.',
    });
    expect(checkNickname('x'.repeat(NICKNAME_MAX_LENGTH + 1), discordOnly)).toEqual({
      ok: false,
      error: `O nome pode ter no máximo ${NICKNAME_MAX_LENGTH} caracteres.`,
    });
  });

  it('has nothing to save when the name did not change', () => {
    expect(checkNickname('Bryan', discordOnly)).toEqual({ ok: false, error: null });
    expect(checkNickname(' Bry ', withNickname)).toEqual({ ok: false, error: null });
  });
});
