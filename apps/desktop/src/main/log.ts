/**
 * Tiny stdout logger. Every line looks like `12:34:56.789 [main:tray] INFO message detail`.
 * Silent while running under Vitest so test output stays readable.
 */
export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

type Level = 'INFO' | 'WARN' | 'ERROR';

const silent = process.env.VITEST === 'true' || process.env.TELAO_LOG === 'silent';

function formatDetail(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, scope: string, message: string, details: unknown[]): void {
  if (silent) return;
  const time = new Date().toISOString().slice(11, 23);
  const extra = details.length > 0 ? ` ${details.map(formatDetail).join(' ')}` : '';
  process.stdout.write(`${time} [main:${scope}] ${level} ${message}${extra}\n`);
}

export function log(scope: string): Logger {
  return {
    info: (message, ...details) => write('INFO', scope, message, details),
    warn: (message, ...details) => write('WARN', scope, message, details),
    error: (message, ...details) => write('ERROR', scope, message, details),
  };
}
