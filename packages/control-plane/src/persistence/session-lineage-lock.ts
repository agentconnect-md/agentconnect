/**
 * Mutual fence for one session lineage (session-visibility.md §4.2 / §4.5).
 *
 * Both halves of visibility convergence read rows that MAY NOT EXIST YET: a child classifies
 * against its parent, and a parent's tightening scan walks its children. A row lock cannot
 * serialize two rows that are both still uncommitted — each transaction sees no counterpart and
 * commits its own view, which leaves a self-classifying child at its own wider tier underneath a
 * private parent. An advisory lock keyed on the session ID exists BEFORE either row, so one of
 * the two waits and then observes the other's committed state.
 *
 * Taken FIRST in every participating transaction, ahead of any row lock. A transaction may then
 * wait on rows while holding the fence, but never waits for the fence while holding rows — that
 * ordering is what keeps a BLOCKING advisory lock deadlock-free here (unlike the try-lock scopes
 * in `memory-connection-lock.ts`, whose callers answer 409 instead of waiting). Multi-id
 * acquisition sorts, so two transactions sharing both keys — a child that is itself a parent —
 * contend deterministically rather than deadlocking.
 *
 * Advisory locks are cluster-wide, not per database, and `hashtextextended` can collide: both
 * only ever cost extra serialization, never correctness.
 */
import { Prisma } from '../generated/prisma/client.js'

/** The lock key for one session's lineage. Exported so a test can hold it. */
export function sessionLineageLockKey(sessionId: string): string {
  return JSON.stringify(['session-lineage', sessionId])
}

/** Fence this transaction against concurrent writers of the same lineage (ids may be absent). */
export async function lockSessionLineage(
  tx: Prisma.TransactionClient,
  ids: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const present = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  for (const id of [...new Set(present)].sort()) {
    // `$executeRaw`, not `$queryRaw`: the lock function returns `void`, which Prisma's row
    // deserializer rejects as a column type.
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${sessionLineageLockKey(id)}, 0))
    `)
  }
}
