import { Prisma } from '../generated/prisma/client.js'
import type { AgentId, HookId } from '../domain/ids.js'

/** Shared outer scope for Agent/Hook/projection producers. Producers in one org
 * may converge concurrently, while organization deletion takes the exclusive
 * form of the same advisory key. */
export async function lockHookReviewOrgProducerScope(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const key = JSON.stringify(['hook-review-org-lifecycle', orgId])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

/** Exclusive outer fence for organization deletion versus all producers. */
export async function lockHookReviewOrgLifecycleScope(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const key = JSON.stringify(['hook-review-org-lifecycle', orgId])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

/**
 * Serialize Agent deletion with every HookDef create, rebind, and removal that
 * can add to or leave the agent-owned hook set.  Agent deletion takes this lock
 * before enumerating hooks and keeps it through projection tombstoning and the
 * cascading Agent delete, so the enumeration cannot miss a concurrent CRUD.
 *
 * Rebinding acquires both old and new agent ids in lexical order.  The global
 * lock order is optional org lifecycle -> agent lifecycle -> hook lifecycle ->
 * agent/repo -> natural key -> projection row.
 */
export async function lockHookReviewAgentLifecycleScope(tx: Prisma.TransactionClient, agentId: AgentId): Promise<void> {
  const key = JSON.stringify(['hook-review-agent-lifecycle', agentId])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

/**
 * Serialize every projection create/lifecycle mutation for one HookDef. This
 * closes the no-row window: a disable, re-enable, retarget, or delete either
 * observes and tombstones a concurrently-created projection, or commits its
 * new projection epoch before that create is allowed to continue.
 *
 * Lock order after any owning-agent lifecycle lock is always hook ->
 * agent/repo -> projection natural key -> row.
 */
export async function lockHookReviewLifecycleScope(tx: Prisma.TransactionClient, hookId: HookId): Promise<void> {
  const key = JSON.stringify(['hook-review-lifecycle', hookId])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

/**
 * Serialize creation and scope cleanup for one agent/repository projection
 * family, including the no-row case that a row-level lock cannot cover.
 *
 * Every producer that may create HookReviewProjection rows must take this lock
 * before its natural-key lock. Grant revocation takes it before scanning and
 * tombstoning rows, then deletes the grant in that same transaction.
 */
export async function lockHookReviewAgentRepoScope(
  tx: Prisma.TransactionClient,
  agentId: AgentId,
  repoId: bigint
): Promise<void> {
  const key = JSON.stringify(['hook-review-agent-repo', agentId, repoId.toString()])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}
