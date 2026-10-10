import { describe, expect, it } from 'vitest';
import { displayMediaErrorMessage, sourceKindFromId } from './capture';

function domError(name: string): { name: string; message: string } {
  return { name, message: `${name} happened` };
}

describe('displayMediaErrorMessage', () => {
  it('translates the DOMException names Chromium raises', () => {
    expect(displayMediaErrorMessage(domError('NotAllowedError'))).toMatch(/Permissão de captura/);
    expect(displayMediaErrorMessage(domError('NotFoundError'))).toMatch(/não está mais disponível/);
    expect(displayMediaErrorMessage(domError('NotReadableError'))).toMatch(/protegida/);
    expect(displayMediaErrorMessage(domError('OverconstrainedError'))).toMatch(/preset mais leve/);
    expect(displayMediaErrorMessage(domError('NotSupportedError'))).toMatch(/não está disponível/);
  });

  it('falls back to the thrown message or a generic text', () => {
    expect(displayMediaErrorMessage(new Error('Fonte inválida.'))).toBe('Fonte inválida.');
    expect(displayMediaErrorMessage(undefined)).toBe('Não foi possível iniciar a captura.');
  });
});

describe('sourceKindFromId', () => {
  it('reads the desktopCapturer id prefix', () => {
    expect(sourceKindFromId('screen:0:0')).toBe('screen');
    expect(sourceKindFromId('window:123456:0')).toBe('window');
    expect(sourceKindFromId('weird')).toBe('window');
  });
});
