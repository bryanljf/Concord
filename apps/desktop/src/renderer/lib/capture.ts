import { toErrorMessage } from './concord';

/** pt-BR message for a failed `getDisplayMedia()` call. */
export function displayMediaErrorMessage(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permissão de captura negada. Escolha a fonte de novo e permita a captura.';
    case 'NotFoundError':
      return 'A janela ou tela escolhida não está mais disponível.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Não foi possível capturar essa fonte. Ela pode estar protegida ou minimizada.';
    case 'OverconstrainedError':
      return 'A fonte não suporta a qualidade escolhida. Tente um preset mais leve.';
    case 'NotSupportedError':
    case 'TypeError':
      return 'A captura de tela não está disponível nesta versão do aplicativo.';
    default:
      return toErrorMessage(err, 'Não foi possível iniciar a captura.');
  }
}

/** `window:<hwnd>:0` → "window", `screen:<n>:0` → "screen" (falls back to window). */
export function sourceKindFromId(sourceId: string): 'window' | 'screen' {
  return sourceId.startsWith('screen:') ? 'screen' : 'window';
}
