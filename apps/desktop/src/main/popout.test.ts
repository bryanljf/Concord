import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '' },
  shell: { openExternal: vi.fn() },
  BrowserWindow: vi.fn(),
}));

import { MAX_PARTICIPANT_ID_LENGTH, parsePopoutTarget } from './popout';
import { IpcValidationError } from './validation';

describe('parsePopoutTarget', () => {
  it('accepts a room and a participant id', () => {
    expect(parsePopoutTarget({ room: 'jogos', participantId: 'ana' })).toEqual({
      room: 'jogos',
      participantId: 'ana',
    });
  });

  it('drops unknown fields', () => {
    expect(parsePopoutTarget({ room: 'jogos', participantId: 'ana', extra: 1 })).toEqual({
      room: 'jogos',
      participantId: 'ana',
    });
  });

  it('rejects bad shapes', () => {
    expect(() => parsePopoutTarget(null)).toThrow(IpcValidationError);
    expect(() => parsePopoutTarget('jogos')).toThrow(IpcValidationError);
    expect(() => parsePopoutTarget({ room: 'sala inválida', participantId: 'ana' })).toThrow(
      IpcValidationError,
    );
    expect(() => parsePopoutTarget({ room: 'jogos', participantId: '' })).toThrow(
      IpcValidationError,
    );
    expect(() => parsePopoutTarget({ room: 'jogos', participantId: 7 })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parsePopoutTarget({
        room: 'jogos',
        participantId: 'a'.repeat(MAX_PARTICIPANT_ID_LENGTH + 1),
      }),
    ).toThrow(IpcValidationError);
  });
});
