/**
 * The minimal structured-log seam the relay's FSM depends on. The Fastify server
 * logger (pino) satisfies it, so `index.ts` passes `server.log`; tests pass a
 * no-op or a capturing fake. Deliberately narrow — nothing here ever logs a
 * credential, route, or message body (design §14).
 */
export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

/** A console-backed logger for standalone use; the server uses pino instead. */
export const consoleLogger: Logger = {
  debug: (m) => console.debug(m),
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m)
}
