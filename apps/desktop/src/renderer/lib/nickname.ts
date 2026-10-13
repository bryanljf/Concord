import { NICKNAME_MAX_LENGTH, type UserInfo } from '@concord/shared';

export type NicknameCheck =
  | { ok: true; nickname: string }
  /** `error` is pt-BR; null means "nothing to save" (unchanged draft), not a mistake. */
  | { ok: false; error: string | null };

/** What the display-name input starts with: the current resolved name. */
export function initialNicknameDraft(user: UserInfo): string {
  return user.nickname ?? user.displayName;
}

/** Validates the display-name draft before calling `setNickname`. */
export function checkNickname(draft: string, user: UserInfo): NicknameCheck {
  const nickname = draft.trim();
  if (nickname === '') return { ok: false, error: 'Digite um nome de exibição.' };
  // Counted in code points, like the server (an emoji is one character).
  if ([...nickname].length > NICKNAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `O nome pode ter no máximo ${NICKNAME_MAX_LENGTH} caracteres.`,
    };
  }
  if (nickname === user.displayName) return { ok: false, error: null };
  return { ok: true, nickname };
}
