import { describe, expect, it } from 'vitest';
import { errorCode, toErrorMessage } from './concord';

describe('errorCode', () => {
  it('reads the code main attaches to IPC rejections', () => {
    const err = Object.assign(new Error('O Discord não está aberto.'), {
      code: 'discord_not_running',
    });
    expect(errorCode(err)).toBe('discord_not_running');
  });

  it('is null for errors without a usable code', () => {
    expect(errorCode(new Error('x'))).toBeNull();
    expect(errorCode(Object.assign(new Error('x'), { code: '' }))).toBeNull();
    expect(errorCode(Object.assign(new Error('x'), { code: 42 }))).toBeNull();
    expect(errorCode('texto')).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});

describe('toErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(toErrorMessage(new Error('Chave inválida.'))).toBe('Chave inválida.');
  });

  it('accepts plain strings and message-like objects', () => {
    expect(toErrorMessage('Sem conexão.')).toBe('Sem conexão.');
    expect(toErrorMessage({ message: 'Servidor indisponível.' })).toBe('Servidor indisponível.');
  });

  it('strips the Electron IPC wrapper', () => {
    expect(
      toErrorMessage(
        new Error("Error invoking remote method 'concord:login': Error: Chave inválida."),
      ),
    ).toBe('Chave inválida.');
    expect(
      toErrorMessage(new Error("Error invoking remote method 'concord:login': Acesso negado.")),
    ).toBe('Acesso negado.');
  });

  it('falls back when nothing usable was thrown', () => {
    expect(toErrorMessage(undefined)).toBe('Algo deu errado. Tente novamente.');
    expect(toErrorMessage(new Error(''), 'Falhou.')).toBe('Falhou.');
    expect(toErrorMessage({ message: 42 }, 'Falhou.')).toBe('Falhou.');
  });
});
