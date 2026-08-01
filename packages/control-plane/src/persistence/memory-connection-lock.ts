/**
 * Fail-fast advisory-lock scopes for external-memory mutations.
 *
 * There is deliberately no database FK from an agent's JSON memory binding
 * (`runtimeOverrides.memory.connectionId`) to `external_memory_connection`, so
 * the check-then-write pairs on both sides of that edge — a connection DELETE's
 * "no agent bound" scan vs an agent write committing a binding, an installation
 * DELETE's reference scan vs a connection insert, and overlapping connection
 * definition/grant mutations — must serialize across control-plane instances
 * (the rolling-update overlap window included). Every participating transaction
 * try-acquires the scope of the resource ids it touches and surfaces `busy`
 * (HTTP 409) when another mutation holds one, preserving the fail-fast
 * semantics of the process-local ExclusiveMutationGate this replaces.
 *
 * `pg_try_advisory_xact_lock` never waits, so these locks cannot deadlock
 * regardless of what row locks the surrounding transaction already holds;
 * multi-id acquisition still sorts ids so concurrent multi-id writers contend
 * deterministically instead of livelocking.
 */
import { Prisma } from '../generated/prisma/client.js'

async function tryLock(tx: Prisma.TransactionClient, key: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS "locked"
  `)
  return rows[0]?.locked === true
}

/** One external-memory connection's mutation scope. */
export function tryLockMemoryConnectionScope(tx: Prisma.TransactionClient, connectionId: string): Promise<boolean> {
  return tryLock(tx, JSON.stringify(['external-memory-connection', connectionId]))
}

/** One memory-plugin installation's mutation scope (guards its reference set). */
export function tryLockMemoryInstallationScope(tx: Prisma.TransactionClient, installationId: string): Promise<boolean> {
  return tryLock(tx, JSON.stringify(['external-memory-installation', installationId]))
}

/** Try-acquire several connection scopes (deduplicated, sorted). False ⇒ at
 *  least one is held elsewhere; the caller aborts and answers 409. */
export async function tryLockMemoryConnectionScopes(
  tx: Prisma.TransactionClient,
  connectionIds: readonly string[]
): Promise<boolean> {
  for (const id of [...new Set(connectionIds)].sort()) {
    if (!(await tryLockMemoryConnectionScope(tx, id))) return false
  }
  return true
}
