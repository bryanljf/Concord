import { describe, expect, it } from 'vitest';
import { DEV_BUILD_REASON, describeUpdateStatus } from './updates';

describe('describeUpdateStatus', () => {
  it('lets the user check again when idle, up to date or after an error', () => {
    expect(describeUpdateStatus({ state: 'idle' })).toMatchObject({
      canCheck: true,
      canInstall: false,
      busy: false,
    });
    expect(describeUpdateStatus({ state: 'up_to_date', version: '0.1.0' })).toMatchObject({
      label: 'Você já está na versão mais recente (0.1.0).',
      tone: 'success',
      canCheck: true,
    });
    expect(describeUpdateStatus({ state: 'error', message: 'sem rede' })).toMatchObject({
      label: 'Não foi possível verificar atualizações: sem rede',
      tone: 'error',
      canCheck: true,
    });
  });

  it('is busy while checking, available or downloading', () => {
    expect(describeUpdateStatus({ state: 'checking' })).toMatchObject({
      label: 'Verificando atualizações…',
      busy: true,
      canCheck: false,
    });
    expect(describeUpdateStatus({ state: 'available', version: '0.2.0' })).toMatchObject({
      busy: true,
      canCheck: false,
      canInstall: false,
    });
    expect(
      describeUpdateStatus({ state: 'downloading', version: '0.2.0', percent: 42.4 }),
    ).toMatchObject({ label: 'Baixando a versão 0.2.0… 42%', busy: true });
  });

  it('offers the restart only when ready', () => {
    expect(describeUpdateStatus({ state: 'ready', version: '0.2.0' })).toMatchObject({
      label: 'Versão 0.2.0 pronta para instalar.',
      canInstall: true,
      canCheck: false,
    });
  });

  it('explains development builds and keeps the reason from main', () => {
    expect(describeUpdateStatus({ state: 'unsupported', reason: '' })).toMatchObject({
      label: DEV_BUILD_REASON,
      canCheck: false,
      canInstall: false,
      tone: 'muted',
    });
    expect(
      describeUpdateStatus({ state: 'unsupported', reason: 'Sem atualizador nesta plataforma.' })
        .label,
    ).toBe('Sem atualizador nesta plataforma.');
  });
});
