/**
 * `persistence/platform.ts` — the protocol↔DB platform boundary.
 *
 * The protocol `Platform` enum also carries session-identity-only values
 * (`webchat`, `hook`, and background `dream` runs). They have no persisted
 * integration row: their message content stays daemon-local (body-locality,
 * §1/§12).
 * So the DB `Platform` enum (the persisted platforms) is deliberately narrower:
 * only actual integrations. This helper is the single place that asserts that
 * invariant when a protocol platform is about to be written to Postgres — a
 * `webchat` value reaching a persistence write is a programming error, not data.
 */
import type { Platform as ProtocolPlatform } from '@agentconnect.md/protocol'
import type { Platform as DbPlatform } from '../generated/prisma/enums.js'

/** Narrow a protocol platform to a persisted (DB) platform, or throw on the
 *  session-identity-only members (`webchat`, `hook`, `dream`). */
export function toDbPlatform(p: ProtocolPlatform): DbPlatform {
  if (p === 'webchat' || p === 'hook' || p === 'dream') {
    throw new Error(`${p} is a session-identity platform and is never persisted`)
  }
  return p
}
