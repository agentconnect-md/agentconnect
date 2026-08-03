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

/** True for the session-identity-only platforms, which have no persisted row. Lets a
 *  caller decide BEFORE reaching persistence — a read whose answer is "nothing is
 *  persisted for this platform" should return the empty answer, not raise. */
export function isSessionIdentityPlatform(p: ProtocolPlatform): p is 'webchat' | 'hook' | 'dream' {
  return p === 'webchat' || p === 'hook' || p === 'dream'
}

const DB_PLATFORMS: readonly DbPlatform[] = ['slack', 'telegram', 'discord', 'feishu']

/** Narrow a protocol platform to a persisted (DB) platform, or throw on the
 *  session-identity-only members (`webchat`, `hook`, `dream`) — and, now that
 *  platform fields read as open strings (S1a), on any id the DB enum does not
 *  hold. Fail-closed: an unknown id reaching a persistence write is a
 *  programming error until the Prisma enum opens to text (S1b). */
export function toDbPlatform(p: ProtocolPlatform): DbPlatform {
  if (isSessionIdentityPlatform(p)) {
    throw new Error(`${p} is a session-identity platform and is never persisted`)
  }
  if (!(DB_PLATFORMS as readonly string[]).includes(p)) {
    throw new Error(`unknown platform ${p} cannot be persisted`)
  }
  return p as DbPlatform
}
