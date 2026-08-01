/**
 * Advisory-lock scope for the (orgId, sourceName) skill-source binding key.
 *
 * Agents bind a source by NAME — every enable-ref is "<source>/<skill>" /
 * "<source>/*" / "<source>" — so the durable fence key is the name, not the row
 * id: lifecycle events on different rows under the same name (drop A, create B)
 * must serialize with each other and with agent enable-list writes, and an
 * id-keyed lock would die with its row and let a same-name recreate slip into
 * the window.
 *
 * Holders (each takes the lock inside its own transaction, so the fence works
 * across control-plane instances — e.g. the rolling-update overlap window):
 *
 * - skill-source CREATE (name-capture guard: agent-reference scan → insert),
 * - skill-source DELETE (reference scan → row drop),
 * - skill-source sharing writes (visibility flip vs in-flight enables),
 * - agent enable-list writes, one lock per submitted ref's source name
 *   ({@link lockSkillSourceNameScopes} — sorted, so two multi-name writers
 *   cannot deadlock waiting on each other's tails).
 *
 * The blocking form (not try-lock) preserves the queue semantics of the
 * in-process promise chain this replaces: contending writers serialize rather
 * than fail. Lock order inside a transaction that takes several lock families:
 * skill-source name locks come BEFORE membership/agent row locks and BEFORE the
 * external-memory try-locks (which never wait, so they cannot deadlock).
 */
import { Prisma } from '../generated/prisma/client.js'

export async function lockSkillSourceNameScope(
  tx: Prisma.TransactionClient,
  orgId: string,
  name: string
): Promise<void> {
  const key = JSON.stringify(['skill-source-name', orgId, name])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

/** Take the (orgId, name) scope for several names — deduplicated and sorted so
 *  concurrent multi-name writers acquire in one global order. */
export async function lockSkillSourceNameScopes(
  tx: Prisma.TransactionClient,
  orgId: string,
  names: readonly string[]
): Promise<void> {
  for (const name of [...new Set(names)].sort()) await lockSkillSourceNameScope(tx, orgId, name)
}
