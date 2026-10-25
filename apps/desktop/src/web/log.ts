/**
 * Console logger shaped like main's (`[web:presence] message detail`), so the browser's devtools
 * read like the desktop's log. Silent under Vitest so test output stays readable.
 */
export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

const silent = import.meta.env.MODE === 'test';

export function log(scope: string): Logger {
  if (silent) {
    const noop = (): void => undefined;
    return { info: noop, warn: noop, error: noop };
  }
  const prefix = `[web:${scope}]`;
  return {
    info: (message, ...details) => console.info(prefix, message, ...details),
    warn: (message, ...details) => console.warn(prefix, message, ...details),
    error: (message, ...details) => console.error(prefix, message, ...details),
  };
}
