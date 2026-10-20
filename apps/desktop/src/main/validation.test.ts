import { NICKNAME_MAX_LENGTH } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import {
  expectNickname,
  expectOptionalTokenPurpose,
  expectPipResizeCorner,
  IpcValidationError,
  UserFacingError,
} from './validation';

describe('expectNickname', () => {
  it('trims strings and keeps null', () => {
    expect(expectNickname(null)).toBeNull();
    expect(expectNickname('  Bryzinho  ')).toBe('Bryzinho');
    expect(expectNickname('x'.repeat(NICKNAME_MAX_LENGTH))).toBe('x'.repeat(NICKNAME_MAX_LENGTH));
    // Code points, like the server: 32 emoji are 64 UTF-16 units but still fit.
    expect(expectNickname('🎮'.repeat(NICKNAME_MAX_LENGTH))).toBe('🎮'.repeat(NICKNAME_MAX_LENGTH));
  });

  it('turns a blank string into null (back to the Discord name)', () => {
    expect(expectNickname('')).toBeNull();
    expect(expectNickname('   ')).toBeNull();
  });

  it('rejects other types and names that are too long', () => {
    expect(() => expectNickname(undefined)).toThrow(IpcValidationError);
    expect(() => expectNickname(42)).toThrow(IpcValidationError);
    expect(() => expectNickname({ nickname: 'x' })).toThrow(IpcValidationError);
    expect(() => expectNickname('x'.repeat(NICKNAME_MAX_LENGTH + 1))).toThrow(UserFacingError);
    expect(() => expectNickname('x'.repeat(NICKNAME_MAX_LENGTH + 1))).toThrow(
      `O nome pode ter no máximo ${NICKNAME_MAX_LENGTH} caracteres.`,
    );
  });
});

describe('expectOptionalTokenPurpose', () => {
  it('accepts main, popout, pip and undefined', () => {
    expect(expectOptionalTokenPurpose(undefined)).toBeUndefined();
    expect(expectOptionalTokenPurpose('main')).toBe('main');
    expect(expectOptionalTokenPurpose('popout')).toBe('popout');
    expect(expectOptionalTokenPurpose('pip')).toBe('pip');
    expect(() => expectOptionalTokenPurpose('camera')).toThrow(IpcValidationError);
    expect(() => expectOptionalTokenPurpose(null)).toThrow(IpcValidationError);
  });
});

describe('expectPipResizeCorner', () => {
  it('accepts the four corners only', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se'])
      expect(expectPipResizeCorner(corner)).toBe(corner);
    expect(() => expectPipResizeCorner('n')).toThrow(IpcValidationError);
    expect(() => expectPipResizeCorner(undefined)).toThrow(IpcValidationError);
  });
});
