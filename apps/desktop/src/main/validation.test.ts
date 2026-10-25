import { JAM_SEARCH_LIMIT, JAM_SEARCH_MAX_LENGTH, NICKNAME_MAX_LENGTH } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import {
  expectJamItemId,
  expectJamQuery,
  expectNickname,
  expectOptionalTokenPurpose,
  expectPipResizeCorner,
  expectYouTubeVideoId,
  expectYouTubeVideoIds,
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

describe('jam IPC arguments', () => {
  it('accepts YouTube video ids only', () => {
    expect(expectYouTubeVideoId('4D7u5KF7SP8')).toBe('4D7u5KF7SP8');
    expect(expectYouTubeVideoId('a-b_c-d_e-f')).toBe('a-b_c-d_e-f');
    expect(() => expectYouTubeVideoId('4D7u5KF7SP')).toThrow(IpcValidationError);
    expect(() => expectYouTubeVideoId('https://youtu.be/4D7u5KF7SP8')).toThrow(IpcValidationError);
    expect(() => expectYouTubeVideoId('--exec=calc')).toThrow(IpcValidationError);
    expect(() => expectYouTubeVideoId(42)).toThrow(IpcValidationError);
  });

  it('accepts up to a search worth of video ids to prefetch', () => {
    expect(expectYouTubeVideoIds([])).toEqual([]);
    expect(expectYouTubeVideoIds(['4D7u5KF7SP8', 'a-b_c-d_e-f'])).toEqual([
      '4D7u5KF7SP8',
      'a-b_c-d_e-f',
    ]);
    const many = Array.from({ length: JAM_SEARCH_LIMIT + 1 }, () => '4D7u5KF7SP8');
    expect(() => expectYouTubeVideoIds(many)).toThrow(IpcValidationError);
    expect(() => expectYouTubeVideoIds(['4D7u5KF7SP8', '--exec=calc'])).toThrow(IpcValidationError);
    expect(() => expectYouTubeVideoIds('4D7u5KF7SP8')).toThrow(IpcValidationError);
    expect(() => expectYouTubeVideoIds(null)).toThrow(IpcValidationError);
  });

  it('accepts queue item ids of up to 64 safe characters', () => {
    expect(expectJamItemId('3f1c9a2e-77b0-4c1e-9d55-0a6c2b1e8f10')).toBe(
      '3f1c9a2e-77b0-4c1e-9d55-0a6c2b1e8f10',
    );
    expect(expectJamItemId('x'.repeat(64))).toBe('x'.repeat(64));
    expect(() => expectJamItemId('')).toThrow(IpcValidationError);
    expect(() => expectJamItemId('x'.repeat(65))).toThrow(IpcValidationError);
    expect(() => expectJamItemId('../skip')).toThrow(IpcValidationError);
    expect(() => expectJamItemId('a b')).toThrow(IpcValidationError);
    expect(() => expectJamItemId(null)).toThrow(IpcValidationError);
  });

  it('trims search queries and bounds them with pt-BR messages', () => {
    expect(expectJamQuery('  daft punk  ')).toBe('daft punk');
    expect(expectJamQuery('🎵'.repeat(JAM_SEARCH_MAX_LENGTH))).toBe(
      '🎵'.repeat(JAM_SEARCH_MAX_LENGTH),
    );
    expect(() => expectJamQuery('   ')).toThrow('Digite o nome de uma música para buscar.');
    expect(() => expectJamQuery('x'.repeat(JAM_SEARCH_MAX_LENGTH + 1))).toThrow(
      `A busca pode ter no máximo ${JAM_SEARCH_MAX_LENGTH} caracteres.`,
    );
    expect(() => expectJamQuery('x'.repeat(JAM_SEARCH_MAX_LENGTH + 1))).toThrow(UserFacingError);
    expect(() => expectJamQuery(undefined)).toThrow(IpcValidationError);
  });
});
