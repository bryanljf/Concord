import type { UpdateStatus } from '../../preload/api';

export type UpdateTone = 'muted' | 'info' | 'success' | 'error';

/** What the settings UI shows for an `UpdateStatus`. */
export interface UpdateView {
  label: string;
  tone: UpdateTone;
  /** A check or download is in progress. */
  busy: boolean;
  /** "Verificar atualizações" makes sense right now. */
  canCheck: boolean;
  /** "Reiniciar para atualizar" makes sense right now. */
  canInstall: boolean;
}

export const DEV_BUILD_REASON =
  'Atualização automática indisponível nesta versão de desenvolvimento.';

/** The web client has no updater: every deploy is the update. */
export const WEB_UPDATE_REASON = 'A versão web atualiza sozinha a cada publicação.';

export const WEB_UPDATE_STATUS: UpdateStatus = { state: 'unsupported', reason: WEB_UPDATE_REASON };

export function describeUpdateStatus(status: UpdateStatus): UpdateView {
  switch (status.state) {
    case 'idle':
      return {
        label: 'Nenhuma verificação feita ainda.',
        tone: 'muted',
        busy: false,
        canCheck: true,
        canInstall: false,
      };
    case 'checking':
      return {
        label: 'Verificando atualizações…',
        tone: 'info',
        busy: true,
        canCheck: false,
        canInstall: false,
      };
    case 'up_to_date':
      return {
        label: `Você já está na versão mais recente (${status.version}).`,
        tone: 'success',
        busy: false,
        canCheck: true,
        canInstall: false,
      };
    case 'available':
      return {
        label: `Nova versão ${status.version} disponível. Baixando em segundo plano…`,
        tone: 'info',
        busy: true,
        canCheck: false,
        canInstall: false,
      };
    case 'downloading':
      return {
        label: `Baixando a versão ${status.version}… ${Math.round(status.percent)}%`,
        tone: 'info',
        busy: true,
        canCheck: false,
        canInstall: false,
      };
    case 'ready':
      return {
        label: `Versão ${status.version} pronta para instalar.`,
        tone: 'success',
        busy: false,
        canCheck: false,
        canInstall: true,
      };
    case 'error':
      return {
        label: `Não foi possível verificar atualizações: ${status.message}`,
        tone: 'error',
        busy: false,
        canCheck: true,
        canInstall: false,
      };
    case 'unsupported':
      return {
        label: status.reason.trim() || DEV_BUILD_REASON,
        tone: 'muted',
        busy: false,
        canCheck: false,
        canInstall: false,
      };
  }
}
