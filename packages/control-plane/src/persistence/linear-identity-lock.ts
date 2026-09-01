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
 *  - the orphan sweeper's whole collection step ({@link LinearTokenStore.withIdentityLock}), which
 *    claims the stale row, asks the global ownership question, and revokes upstream — all inside
 *    ONE hold. Splitting those was a bug: with the claim outside, a same-org retry could re-grant
 *    in the gap and, because the ownership query excludes the caller's own organization, the sweep
 *    read "unowned" and revoked the authorization backing that fresh grant.
 *
 * The sweeper deliberately holds the lock across its upstream call: releasing first would only
 * narrow the window rather than close it, since a winner admitted in between still loses its grant.
 * That call is bounded by its own request timeout, and contention is per-workspace — a sweep touches
 * only orphans, and a connect for the very same workspace at the very same moment is the rare case
 * this exists for.
 */
import { Prisma } from '../generated/prisma/client.js'

/**
 * THE COUPLING, in one place because it is an ordering between three numbers and a silent drift
 * between them is a spent OAuth code:
 *
 *   LINEAR_API_REQUEST_TIMEOUT_MS  <  LOCK_MAX_HOLD_MS  <  LOCK_WAIT_BUDGET_MS
 *
 *  - the sweeper HOLDS this lock across its upstream revoke, so its transaction's ceiling is the
 *    longest anyone can be kept waiting. The Linear client's per-request timeout sits under it so a
 *    hung provider surfaces as `unreachable` rather than as an expired transaction;
 *  - the connect callback's step-1 `put` may have to WAIT that long for the lock, and it waits
 *    INSIDE its transaction (`pg_advisory_xact_lock` blocks), so its budget is a transaction
 *    ceiling, not a pool `maxWait`. Left at Prisma's default it would expire while queued behind a
 *    sweep — and it expires having already spent the authorization code, which is not retryable.
 *
 * `linear-identity-lock.budgets.test.ts` asserts the ordering, so the numbers cannot drift apart
 * without a failing test.
 */
export const LINEAR_IDENTITY_LOCK_MAX_HOLD_MS = 20_000
export const LINEAR_IDENTITY_LOCK_WAIT_BUDGET_MS = 45_000
/** Pool-acquisition budgets. Distinct from the above: this is time to GET a connection, before the
 *  transaction (and therefore the lock wait) begins. */
export const LINEAR_IDENTITY_LOCK_MAX_WAIT_MS = 10_000

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
