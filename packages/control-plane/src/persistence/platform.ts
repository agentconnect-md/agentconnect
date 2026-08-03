/**
 * `persistence/platform.ts` — the protocol↔DB platform boundary.
 *
 * The protocol platform id also carries session-identity-only values (`webchat`,
 * `hook`, and background `dream` runs). They have no persisted integration row:
 * their message content stays daemon-local (body-locality, §1/§12).
 * The DB columns are open TEXT since S1b (integration-plugin-architecture.md §11) —
 * the dropped `Platform` enum's closed set lives on HERE, as the application-level
 * guard asserted when a protocol platform is about to be written to Postgres: a
 * `webchat` value (or an id this deployment does not serve) reaching a persistence
 * write is a programming error, not data. The platform registry replaces this list
 * when providers land (S3).
 */
import type { Platform as ProtocolPlatform } from '@agentconnect.md/protocol'
import { isSessionIdentityPlatform } from '@agentconnect.md/protocol'

/** True for the session-identity-only platforms, which have no persisted row. Lets a
 *  caller decide BEFORE reaching persistence — a read whose answer is "nothing is
 *  persisted for this platform" should return the empty answer, not raise. The
 *  classification itself lives in the protocol package (the S1a registry seed shared
 *  with the daemon's and relay's `coordsDecision`). */
export { isSessionIdentityPlatform }

/** The chat platforms this deployment currently serves — the closed set the dropped
 *  DB enum used to enforce. */
const DB_PLATFORMS = ['slack', 'telegram', 'discord', 'feishu'] as const
export type DbPlatform = (typeof DB_PLATFORMS)[number]

/** Narrow a protocol platform to a persisted (DB) platform, or throw on the
 *  session-identity-only members (`webchat`, `hook`, `dream`) and on any id outside
 *  the served set. Fail-closed: the DB column no longer enforces the set, so this
 *  helper is the fence. */
export function toDbPlatform(p: ProtocolPlatform): DbPlatform {
  if (isSessionIdentityPlatform(p)) {
    throw new Error(`${p} is a session-identity platform and is never persisted`)
  }
  if (!(DB_PLATFORMS as readonly string[]).includes(p)) {
    throw new Error(`unknown platform ${p} cannot be persisted`)
  }
  return p as DbPlatform
}
