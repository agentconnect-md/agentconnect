/**
 * Advisory-lock scope for one Linear CONNECTION IDENTITY — `(clientId, organizationId)`, the
 * deployment app plus the workspace (docs/designs/linear-integration.md §7.1).
 *
 * DELIBERATELY NOT ORG-SCOPED. Every other lock family in this repo keys on an organization because
 * the invariant it fences is tenant-local. This one is the opposite: the question it serializes is
 * global — "does ANY organization rely on this app's authorization of this workspace?" — because a
 * Linear `POST /oauth/revoke` acts on the app↔workspace grant, not on one tenant's copy of it. An
 * org-keyed lock would let two organizations answer that question at the same time and both act.
 *
 * TWO HOLDERS, and they must derive the key identically or the fence does not exist:
 *
 *  - the connect callback's §7.1 STEP 1 token upsert ({@link LinearTokenStore.put}), which is the
 *    first durable trace of an organization laying claim to an identity — and, because §7.1 fixes
 *    that write BEFORE the create tail, locking it also fences bot admission: no Bot can exist for
 *    an identity whose token row was not written first, under this same lock;
 *  - the orphan sweeper's revoke decision ({@link LinearTokenStore.withIdentityOwnership}), which
 *    re-asks the global question DURABLY, under the lock, and revokes only on a "no" that cannot
 *    have gone stale between the answer and the act.
 *
 * The sweeper deliberately holds the lock across its upstream call: releasing first would only
 * narrow the window rather than close it, since a winner admitted in between still loses its grant.
 * That call is bounded by its own request timeout, and contention is per-workspace — a sweep touches
 * only orphans, and a connect for the very same workspace at the very same moment is the rare case
 * this exists for.
 */
import { Prisma } from '../generated/prisma/client.js'

/** The ONE key derivation both holders use. Never inline this — a second spelling is a silent
 *  un-fencing, because two different strings hash to two different locks. */
export function linearIdentityLockKey(clientId: string, organizationId: string): string {
  return JSON.stringify(['linear-connection-identity', clientId, organizationId])
}

/** Blocking, transaction-scoped: contenders serialize rather than fail, and the lock is released
 *  when the surrounding transaction ends (including on rollback). */
export async function lockLinearIdentity(
  tx: Prisma.TransactionClient,
  clientId: string,
  organizationId: string
): Promise<void> {
  const key = linearIdentityLockKey(clientId, organizationId)
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}
