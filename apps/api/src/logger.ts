/**
 * Minimal structured-logging surface used outside request handlers. Fastify's pino logger
 * satisfies it, and tests can pass plain mocks.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
