/**
 * `persistence/platform.ts` — the protocol↔DB platform boundary.
 *
 * The protocol `Platform` enum carries `webchat`, but webchat is the one
 * integration whose data plane IS the daemon↔CP control WS — its message content
 * stays on the wire and the CP persists NOTHING for it (body-locality, §1/§12).
 * So the DB `Platform` enum (the persisted platforms) is deliberately narrower:
 * only `slack` / `telegram`. This helper is the single place that asserts that
 * invariant when a protocol platform is about to be written to Postgres — a
 * `webchat` value reaching a persistence write is a programming error, not data.
 */
import type { Platform as ProtocolPlatform } from '@agentconnect.md/protocol'
import type { Platform as DbPlatform } from '../generated/prisma/enums.js'

/** Narrow a protocol platform to a persisted (DB) platform, or throw on the
 *  session-identity-only members (`webchat`, `hook`). */
export function toDbPlatform(p: ProtocolPlatform): DbPlatform {
  if (p === 'webchat' || p === 'hook') {
    throw new Error(`${p} is a session-identity platform and is never persisted`)
  }
  return p
}
