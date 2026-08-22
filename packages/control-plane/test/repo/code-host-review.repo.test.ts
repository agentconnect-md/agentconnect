/**
 * Durable publication serialization for formal code-host reviews
 * (gitlab-com-integration.md §15.1, §15.2): the compare-and-swap lease with its
 * monotonic fence, the single-use operation ledger, and the body-free attempt
 * outcome store — against real Postgres, where the concurrency actually happens.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgCodeHostReviewLeaseRepo } from '../../src/persistence/repositories/code-host-review.repo.js'
import { AgentId, DaemonId, HookId } from '../../src/domain/ids.js'
import type { CodeHostReviewAcquireInput, CodeHostReviewSubject } from '../../src/persistence/ports.js'

const DAEMON_A = DaemonId('33333333-3333-4333-8333-333333333333')
const DAEMON_B = DaemonId('55555555-5555-4555-8555-555555555555')
const AGENT = AgentId('22222222-2222-4222-8222-222222222222')
const HOOK = HookId('11111111-1111-4111-8111-111111111111')
const HEAD = 'a'.repeat(40)

const repo = () => new PgCodeHostReviewLeaseRepo(prisma)

let nextProject = 4_400_000n
function subject(): CodeHostReviewSubject {
  return {
    provider: 'gitlab',
    projectExternalId: ++nextProject,
    mergeRequestIid: 42,
    serviceAccountExternalId: 99_001n
  }
}

function acquire(s: CodeHostReviewSubject, over: Partial<CodeHostReviewAcquireInput> = {}): CodeHostReviewAcquireInput {
  const now = over.now ?? new Date('2026-09-06T00:00:00.000Z')
  return {
    subject: s,
    orgId: DEFAULT_ORG_ID,
    attemptId: randomUUID(),
    daemonId: DAEMON_A,
    agentId: AGENT,
    hookId: HOOK,
    deliveryKey: 'delivery-1',
    event: 'COMMENT',
    verdict: 'pass',
    headSha: HEAD,
    leaseUntil: new Date(now.getTime() + 300_000),
    now,
    ...over
  }
}

describe('publication lease (§15.1)', () => {
  it('two daemons racing one merge request produce exactly one owner', async () => {
    const s = subject()
    const a = acquire(s, { daemonId: DAEMON_A })
    const b = acquire(s, { daemonId: DAEMON_B })
    const [first, second] = await Promise.all([repo().acquire(a), repo().acquire(b)])
    const owners = [first, second].filter((r) => r.outcome === 'acquired')
    const losers = [first, second].filter((r) => r.outcome === 'held')
    expect(owners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    const row = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(row.fence).toBe(1n)
    expect(row.phase).toBe('open')
    expect([a.attemptId, b.attemptId]).toContain(row.attemptId)
  })

  it('the fence is monotonic across acquisitions and never reused', async () => {
    const s = subject()
    const seen: bigint[] = []
    for (let i = 0; i < 3; i++) {
      const input = acquire(s)
      const acquired = await repo().acquire(input)
      expect(acquired.outcome).toBe('acquired')
      if (acquired.outcome !== 'acquired') return
      seen.push(acquired.lease.fence)
      // Release it cleanly so the next attempt may take it.
      await repo().recordOutcome({
        attemptId: input.attemptId,
        orgId: DEFAULT_ORG_ID,
        hookId: HOOK,
        deliveryKey: input.deliveryKey,
        provider: s.provider,
        projectExternalId: s.projectExternalId,
        mergeRequestIid: s.mergeRequestIid,
        daemonId: DAEMON_A,
        event: 'COMMENT',
        verdict: 'pass',
        headSha: HEAD,
        state: 'submitted',
        externalIds: [],
        now: new Date()
      })
    }
    expect(seen).toEqual([1n, 2n, 3n])
  })

  it('re-asking with the same attempt renews instead of minting a second fence', async () => {
    const s = subject()
    const input = acquire(s)
    await repo().acquire(input)
    const again = await repo().acquire({ ...input, leaseUntil: new Date('2026-09-06T00:20:00.000Z') })
    expect(again.outcome).toBe('idempotent')
    if (again.outcome !== 'idempotent') return
    expect(again.lease.fence).toBe(1n)
    expect(again.lease.leaseUntil?.toISOString()).toBe('2026-09-06T00:20:00.000Z')
  })

  it('renews only for the owning daemon at the current fence', async () => {
    const s = subject()
    const input = acquire(s)
    const acquired = await repo().acquire(input)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const until = new Date('2026-09-06T00:30:00.000Z')
    expect(
      await repo().renew({
        attemptId: input.attemptId,
        orgId: DEFAULT_ORG_ID,
        fence: 1n,
        daemonId: DAEMON_B,
        leaseUntil: until
      })
    ).toBeNull()
    expect(
      await repo().renew({
        attemptId: input.attemptId,
        orgId: DEFAULT_ORG_ID,
        fence: 99n,
        daemonId: DAEMON_A,
        leaseUntil: until
      })
    ).toBeNull()
    expect(
      await repo().renew({
        attemptId: input.attemptId,
        orgId: 'not-the-org',
        fence: 1n,
        daemonId: DAEMON_A,
        leaseUntil: until
      })
    ).toBeNull()
    const renewed = await repo().renew({
      attemptId: input.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: 1n,
      daemonId: DAEMON_A,
      leaseUntil: until
    })
    expect(renewed?.leaseUntil?.toISOString()).toBe(until.toISOString())
  })

  it('an expired lease with a started request locks the row indefinitely', async () => {
    const s = subject()
    const first = acquire(s)
    const acquired = await repo().acquire(first)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const issued = await repo().issueOperation({
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      kind: 'bulk_publish',
      method: 'POST',
      target: '/projects/1/merge_requests/42/draft_notes/bulk_publish',
      ordinal: 0,
      now: new Date()
    })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    await repo().startOperation({
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      recordId: issued.record.id,
      startToken: randomUUID(),
      now: new Date()
    })

    const wayLater = new Date('2027-09-06T00:00:00.000Z')
    const takeover = await repo().acquire(acquire(s, { daemonId: DAEMON_B, now: wayLater }))
    expect(takeover.outcome).toBe('locked')
    if (takeover.outcome === 'locked') expect(takeover.lock).toBe('records_outstanding')

    // Still locked a year further on: no timeout, no force unlock.
    const evenLater = new Date('2028-09-06T00:00:00.000Z')
    const retry = await repo().acquire(acquire(s, { daemonId: DAEMON_A, now: evenLater }))
    expect(retry.outcome).toBe('locked')
    const row = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(row.phase).toBe('ambiguous_locked')
    expect(row.attemptId).toBe(first.attemptId)
  })

  it('an expired lease whose permits were all returned unused transfers with a new fence', async () => {
    const s = subject()
    const first = acquire(s)
    const acquired = await repo().acquire(first)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const issued = await repo().issueOperation({
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      kind: 'draft_create',
      method: 'POST',
      target: '/projects/1/merge_requests/42/draft_notes',
      ordinal: 0,
      now: new Date()
    })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    await repo().returnOperationUnused({
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      recordId: issued.record.id,
      now: new Date()
    })
    const later = new Date('2026-09-06T01:00:00.000Z')
    const takeover = await repo().acquire(acquire(s, { daemonId: DAEMON_B, now: later }))
    expect(takeover.outcome).toBe('acquired')
    if (takeover.outcome !== 'acquired') return
    expect(takeover.condition).toBe('all_returned_unused')
    expect(takeover.lease.fence).toBe(2n)
  })
})

describe('single-use operation ledger (§15.1)', () => {
  async function owned() {
    const s = subject()
    const input = acquire(s)
    const acquired = await repo().acquire(input)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    return { s, attemptId: input.attemptId, fence: acquired.lease.fence }
  }

  const permit = {
    kind: 'draft_create' as const,
    method: 'POST' as const,
    target: '/projects/1/merge_requests/42/draft_notes',
    ordinal: 0
  }

  it('permits exactly one outbound request per record', async () => {
    const { attemptId, fence } = await owned()
    const base = { attemptId, orgId: DEFAULT_ORG_ID, fence, daemonId: DAEMON_A, now: new Date() }
    const issued = await repo().issueOperation({ ...base, ...permit })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    const token = randomUUID()
    const started = await repo().startOperation({ ...base, recordId: issued.record.id, startToken: token })
    expect('outcome' in started && started.record.state).toBe('request_started')
    // The same intended request retransmitted after a lost reply is idempotent…
    const again = await repo().startOperation({ ...base, recordId: issued.record.id, startToken: token })
    expect('outcome' in again && again.record.state).toBe('request_started')
    // …and a second, different one is refused, so no second request is ever permitted.
    const second = await repo().startOperation({ ...base, recordId: issued.record.id, startToken: randomUUID() })
    expect(second).toEqual({ failure: 'transition', reason: 'already_started' })
  })

  it('never hands a used permit back out under the same coordinates', async () => {
    const { attemptId, fence } = await owned()
    const base = { attemptId, orgId: DEFAULT_ORG_ID, fence, daemonId: DAEMON_A, now: new Date() }
    const issued = await repo().issueOperation({ ...base, ...permit })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    const retransmit = await repo().issueOperation({ ...base, ...permit })
    expect('outcome' in retransmit && retransmit.record.id).toBe(issued.record.id)
    // A different request under the same coordinates is a different operation.
    expect(await repo().issueOperation({ ...base, ...permit, method: 'DELETE' })).toEqual({
      failure: 'permit_conflict'
    })
    await repo().startOperation({ ...base, recordId: issued.record.id, startToken: randomUUID() })
    expect(await repo().issueOperation({ ...base, ...permit })).toEqual({ failure: 'permit_conflict' })
  })

  it('fences the ledger on the owning daemon, the current fence, and the organization', async () => {
    const { attemptId, fence } = await owned()
    const base = { attemptId, orgId: DEFAULT_ORG_ID, fence, daemonId: DAEMON_A, now: new Date() }
    expect(await repo().issueOperation({ ...base, ...permit, daemonId: DAEMON_B })).toEqual({ failure: 'not_owner' })
    expect(await repo().issueOperation({ ...base, ...permit, orgId: 'not-the-org' })).toEqual({
      failure: 'not_owner'
    })
    expect(await repo().issueOperation({ ...base, ...permit, fence: fence + 1n })).toEqual({
      failure: 'stale_fence'
    })
  })

  it('records an ambiguous response and lets a later marker identify it', async () => {
    const { attemptId, fence } = await owned()
    const base = { attemptId, orgId: DEFAULT_ORG_ID, fence, daemonId: DAEMON_A, now: new Date() }
    const issued = await repo().issueOperation({ ...base, ...permit, kind: 'bulk_publish' })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    await repo().startOperation({ ...base, recordId: issued.record.id, startToken: randomUUID() })
    const ambiguous = await repo().settleOperation({
      ...base,
      recordId: issued.record.id,
      outcome: { kind: 'ambiguous', code: 'response_ambiguous' }
    })
    expect('outcome' in ambiguous && ambiguous.record.state).toBe('ambiguous')
    const identified = await repo().settleOperation({
      ...base,
      recordId: issued.record.id,
      outcome: { kind: 'deterministic', status: 200, externalId: '778899' }
    })
    expect('outcome' in identified && identified.record.state).toBe('settled')
    const row = await prisma.codeHostReviewOperation.findUniqueOrThrow({ where: { id: issued.record.id } })
    // The ambiguity history survives its identification: it is a transfer condition.
    expect(row.ambiguousAt).not.toBeNull()
    expect(row.responseExternalId).toBe('778899')
  })
})

describe('attempt outcome store (§15.2)', () => {
  async function owned() {
    const s = subject()
    const input = acquire(s)
    const acquired = await repo().acquire(input)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    return { s, attemptId: input.attemptId, fence: acquired.lease.fence }
  }

  function outcome(s: CodeHostReviewSubject, attemptId: string, over: Record<string, unknown> = {}) {
    return {
      attemptId,
      orgId: DEFAULT_ORG_ID,
      hookId: HOOK,
      deliveryKey: 'delivery-1',
      provider: s.provider,
      projectExternalId: s.projectExternalId,
      mergeRequestIid: s.mergeRequestIid,
      daemonId: DAEMON_A,
      event: 'COMMENT',
      verdict: 'pass',
      headSha: HEAD,
      state: 'submitted' as const,
      externalIds: [] as string[],
      now: new Date(),
      ...over
    }
  }

  it('stores identifiers and normalized state only, and releases the lease', async () => {
    const { s, attemptId } = await owned()
    const recorded = await repo().recordOutcome(outcome(s, attemptId, { externalIds: ['note:778899'] }))
    expect(recorded).toEqual({ outcome: 'recorded', phase: 'settled' })
    const row = await prisma.codeHostReviewAttemptOutcome.findUniqueOrThrow({ where: { attemptId } })
    expect(row.externalIds).toEqual(['note:778899'])
    expect(row.state).toBe('submitted')
    // Nothing on this table can hold a body: every column is an identifier or an enum.
    expect(Object.keys(row).sort()).toEqual(
      [
        'attemptId',
        'deliveryKey',
        'event',
        'externalIds',
        'headSha',
        'hookId',
        'mergeRequestIid',
        'orgId',
        'projectExternalId',
        'provider',
        'recordedAt',
        'state',
        'updatedAt',
        'verdict'
      ].sort()
    )
    const lease = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(lease.phase).toBe('settled')
    expect(lease.attemptId).toBeNull()
  })

  it('refuses a published reference that is not a kind and a numeric id', async () => {
    const { s, attemptId } = await owned()
    expect(await repo().recordOutcome(outcome(s, attemptId, { externalIds: ['note:looks good to me'] }))).toEqual({
      outcome: 'conflict'
    })
    expect(await prisma.codeHostReviewAttemptOutcome.count({ where: { attemptId } })).toBe(0)
  })

  it('locks the merge request when the outcome proves nothing', async () => {
    const { s, attemptId } = await owned()
    expect(await repo().recordOutcome(outcome(s, attemptId, { state: 'ambiguous_locked' }))).toEqual({
      outcome: 'recorded',
      phase: 'ambiguous_locked'
    })
    const lease = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(lease.phase).toBe('ambiguous_locked')
    expect(lease.attemptId).toBe(attemptId)
  })

  it('is idempotent on a retransmit and refuses a second, different classification', async () => {
    const { s, attemptId } = await owned()
    await repo().recordOutcome(outcome(s, attemptId))
    expect(await repo().recordOutcome(outcome(s, attemptId))).toEqual({ outcome: 'idempotent', phase: 'settled' })
    expect(await repo().recordOutcome(outcome(s, attemptId, { state: 'not_submitted' }))).toEqual({
      outcome: 'not_owner'
    })
  })

  it('refuses a result whose reserved facts do not match the lease', async () => {
    const { s, attemptId } = await owned()
    expect(await repo().recordOutcome(outcome(s, attemptId, { headSha: 'b'.repeat(40) }))).toEqual({
      outcome: 'conflict'
    })
    expect(await repo().recordOutcome(outcome(s, attemptId, { daemonId: DAEMON_B }))).toEqual({
      outcome: 'not_owner'
    })
  })
})

describe('a result releases the lease only through the ledger (§15.1)', () => {
  const permit = {
    method: 'POST' as const,
    target: '/projects/1/merge_requests/42/draft_notes',
    ordinal: 0
  }

  async function withPermit(kind: 'draft_create' | 'bulk_publish' = 'bulk_publish') {
    const s = subject()
    const input = acquire(s)
    const acquired = await repo().acquire(input)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const base = {
      attemptId: input.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      now: new Date()
    }
    const issued = await repo().issueOperation({ ...base, ...permit, kind })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    return { s, base, attemptId: input.attemptId, recordId: issued.record.id }
  }

  function outcome(s: CodeHostReviewSubject, attemptId: string, over: Record<string, unknown> = {}) {
    return {
      attemptId,
      orgId: DEFAULT_ORG_ID,
      hookId: HOOK,
      deliveryKey: 'delivery-1',
      provider: s.provider,
      projectExternalId: s.projectExternalId,
      mergeRequestIid: s.mergeRequestIid,
      daemonId: DAEMON_A,
      event: 'COMMENT',
      verdict: 'pass',
      headSha: HEAD,
      state: 'submitted' as const,
      externalIds: [] as string[],
      now: new Date(),
      ...over
    }
  }

  it('records the outcome but keeps the attempt while a started request could still land', async () => {
    const { s, base, attemptId, recordId } = await withPermit()
    await repo().startOperation({ ...base, recordId, startToken: randomUUID() })
    expect(await repo().recordOutcome(outcome(s, attemptId))).toEqual({ outcome: 'recorded', phase: 'classifying' })

    // The classification is durable — it is ownership that is withheld.
    const stored = await prisma.codeHostReviewAttemptOutcome.findUniqueOrThrow({ where: { attemptId } })
    expect(stored.state).toBe('submitted')
    const lease = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(lease.phase).toBe('classifying')
    expect(lease.attemptId).toBe(attemptId)

    // The next attempt must meet the lock, never the `settled` fast path.
    const later = new Date('2027-09-06T00:00:00.000Z')
    const takeover = await repo().acquire(acquire(s, { daemonId: DAEMON_B, now: later }))
    expect(takeover.outcome).toBe('locked')
    if (takeover.outcome === 'locked') expect(takeover.lock).toBe('records_outstanding')
  })

  it('settling that record afterwards re-runs the release and admits the next attempt', async () => {
    const { s, base, attemptId, recordId } = await withPermit()
    await repo().startOperation({ ...base, recordId, startToken: randomUUID() })
    await repo().recordOutcome(outcome(s, attemptId))
    const settled = await repo().settleOperation({
      ...base,
      recordId,
      outcome: { kind: 'deterministic', status: 204 }
    })
    expect('outcome' in settled && settled.phase).toBe('settled')
    const lease = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(lease.attemptId).toBeNull()
    const next = await repo().acquire(acquire(s, { daemonId: DAEMON_B }))
    expect(next.outcome).toBe('acquired')
    if (next.outcome === 'acquired') expect(next.lease.fence).toBe(2n)
  })

  it('an ambiguous record holds the attempt until its marker is positively identified', async () => {
    const { s, base, attemptId, recordId } = await withPermit()
    await repo().startOperation({ ...base, recordId, startToken: randomUUID() })
    await repo().settleOperation({ ...base, recordId, outcome: { kind: 'ambiguous', code: 'response_ambiguous' } })
    expect(await repo().recordOutcome(outcome(s, attemptId))).toEqual({ outcome: 'recorded', phase: 'classifying' })
    const identified = await repo().settleOperation({
      ...base,
      recordId,
      outcome: { kind: 'deterministic', status: 200, externalId: '778899' }
    })
    expect('outcome' in identified && identified.phase).toBe('settled')
    const lease = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(lease.attemptId).toBeNull()
  })

  it('returning the last unused permit is the other way the lease settles', async () => {
    const { s, base, attemptId, recordId } = await withPermit('draft_create')
    expect(await repo().recordOutcome(outcome(s, attemptId, { state: 'not_submitted' }))).toEqual({
      outcome: 'recorded',
      phase: 'classifying'
    })
    const returned = await repo().returnOperationUnused({ ...base, recordId })
    expect('outcome' in returned && returned.phase).toBe('settled')
  })

  it('an attempt that issued no permit at all releases immediately', async () => {
    const s = subject()
    const input = acquire(s)
    await repo().acquire(input)
    expect(await repo().recordOutcome(outcome(s, input.attemptId))).toEqual({ outcome: 'recorded', phase: 'settled' })
  })
})

describe('a terminal operation stays idempotent after the lease is released (§15.1)', () => {
  const permit = { method: 'POST' as const, target: '/projects/1/merge_requests/42/draft_notes', ordinal: 0 }

  async function reported(kind: 'draft_create' | 'bulk_publish', state: 'submitted' | 'not_submitted') {
    const s = subject()
    const input = acquire(s)
    const acquired = await repo().acquire(input)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const base = {
      attemptId: input.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      now: new Date()
    }
    const issued = await repo().issueOperation({ ...base, ...permit, kind })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    if (kind === 'bulk_publish') {
      await repo().startOperation({ ...base, recordId: issued.record.id, startToken: randomUUID() })
    }
    await repo().recordOutcome({
      attemptId: input.attemptId,
      orgId: DEFAULT_ORG_ID,
      hookId: HOOK,
      deliveryKey: input.deliveryKey,
      provider: s.provider,
      projectExternalId: s.projectExternalId,
      mergeRequestIid: s.mergeRequestIid,
      daemonId: DAEMON_A,
      event: 'COMMENT',
      verdict: 'pass',
      headSha: HEAD,
      state,
      externalIds: [],
      now: new Date()
    })
    return { s, base, recordId: issued.record.id }
  }

  it('replays an identical settle after the release committed in the same transaction', async () => {
    const { s, base, recordId } = await reported('bulk_publish', 'submitted')
    const settle = { ...base, recordId, outcome: { kind: 'deterministic' as const, status: 204 } }
    const first = await repo().settleOperation(settle)
    expect('outcome' in first && first.phase).toBe('settled')
    // The release nulled `attemptId`, so only the record can answer the retransmit.
    const lease = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(lease.attemptId).toBeNull()
    const replay = await repo().settleOperation(settle)
    expect(replay).toEqual(first)
  })

  it('replays an identical return-unused after release', async () => {
    const { base, recordId } = await reported('draft_create', 'not_submitted')
    const ret = { ...base, recordId }
    const first = await repo().returnOperationUnused(ret)
    expect('outcome' in first && first.record.state).toBe('unused')
    expect('outcome' in first && first.phase).toBe('settled')
    expect(await repo().returnOperationUnused(ret)).toEqual(first)
  })

  it('refuses a different terminal request on the already-terminal record', async () => {
    const { base, recordId } = await reported('bulk_publish', 'submitted')
    await repo().settleOperation({ ...base, recordId, outcome: { kind: 'deterministic', status: 204 } })
    expect(
      await repo().settleOperation({ ...base, recordId, outcome: { kind: 'deterministic', status: 201 } })
    ).toEqual({ failure: 'transition', reason: 'outcome_conflict' })
    expect(await repo().returnOperationUnused({ ...base, recordId })).toEqual({
      failure: 'transition',
      reason: 'terminal'
    })
  })

  it('refuses a replay naming a foreign attempt, fence, or organization', async () => {
    const { base, recordId } = await reported('bulk_publish', 'submitted')
    const settle = { ...base, recordId, outcome: { kind: 'deterministic' as const, status: 204 } }
    await repo().settleOperation(settle)
    expect(await repo().settleOperation({ ...settle, attemptId: randomUUID() })).toEqual({ failure: 'no_lease' })
    expect(await repo().settleOperation({ ...settle, fence: settle.fence + 1n })).toEqual({ failure: 'no_lease' })
    expect(await repo().settleOperation({ ...settle, orgId: 'not-the-org' })).toEqual({ failure: 'no_lease' })
  })

  it('leaves a still-advanceable ambiguous record on the owned-lease path', async () => {
    const { base, recordId } = await reported('bulk_publish', 'submitted')
    await repo().settleOperation({ ...base, recordId, outcome: { kind: 'ambiguous', code: 'response_ambiguous' } })
    // Still owned: the outcome could not release while the record was ambiguous.
    const identified = await repo().settleOperation({
      ...base,
      recordId,
      outcome: { kind: 'deterministic', status: 200, externalId: '778899' }
    })
    expect('outcome' in identified && identified.record.state).toBe('settled')
    expect('outcome' in identified && identified.phase).toBe('settled')
  })
})

describe('a replayed terminal operation reports its own fence phase (§15.1)', () => {
  const permit = { method: 'POST' as const, target: '/projects/1/merge_requests/42/draft_notes', ordinal: 0 }

  it('does not dress a completed release in a successor attempt lifecycle', async () => {
    const s = subject()
    const first = acquire(s)
    const acquired = await repo().acquire(first)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const base = {
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      now: new Date()
    }
    const issued = await repo().issueOperation({ ...base, ...permit, kind: 'bulk_publish' })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    await repo().startOperation({ ...base, recordId: issued.record.id, startToken: randomUUID() })
    await repo().recordOutcome({
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      hookId: HOOK,
      deliveryKey: first.deliveryKey,
      provider: s.provider,
      projectExternalId: s.projectExternalId,
      mergeRequestIid: s.mergeRequestIid,
      daemonId: DAEMON_A,
      event: 'COMMENT',
      verdict: 'pass',
      headSha: HEAD,
      state: 'submitted',
      externalIds: [],
      now: new Date()
    })
    const settle = { ...base, recordId: issued.record.id, outcome: { kind: 'deterministic' as const, status: 204 } }
    const committed = await repo().settleOperation(settle)
    expect('outcome' in committed && committed.phase).toBe('settled')

    // A waiting attempt takes the freed subject and starts publishing at the next fence.
    const successor = acquire(s, { daemonId: DAEMON_B })
    const taken = await repo().acquire(successor)
    if (taken.outcome !== 'acquired') throw new Error('expected the successor to acquire')
    expect(taken.lease.fence).toBe(base.fence + 1n)
    await repo().issueOperation({
      attemptId: successor.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: taken.lease.fence,
      daemonId: DAEMON_B,
      kind: 'bulk_publish',
      method: 'POST',
      target: '/projects/1/merge_requests/42/draft_notes/bulk_publish',
      ordinal: 0,
      now: new Date()
    })
    const live = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(live.phase).toBe('publishing')

    // The lost acknowledgement replays with the OLD record's fence-coherent phase.
    const replay = await repo().settleOperation(settle)
    expect(replay).toEqual(committed)
    expect('outcome' in replay && replay.phase).toBe('settled')
    // …and the successor's live state is untouched by that read.
    const after = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(after).toMatchObject({
      attemptId: successor.attemptId,
      fence: taken.lease.fence,
      phase: 'publishing'
    })
  })

  it('reports settled for a record whose attempt was transferred away unreported', async () => {
    const s = subject()
    const first = acquire(s)
    const acquired = await repo().acquire(first)
    if (acquired.outcome !== 'acquired') throw new Error('expected a lease')
    const base = {
      attemptId: first.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: acquired.lease.fence,
      daemonId: DAEMON_A,
      now: new Date()
    }
    const issued = await repo().issueOperation({ ...base, ...permit, kind: 'draft_create' })
    if (!('outcome' in issued)) throw new Error('expected a permit')
    const returned = await repo().returnOperationUnused({ ...base, recordId: issued.record.id })
    expect('outcome' in returned && returned.record.state).toBe('unused')

    // All permits unused, so an expired lease transfers with no outcome ever recorded.
    const later = new Date('2026-09-06T01:00:00.000Z')
    const successor = acquire(s, { daemonId: DAEMON_B, now: later })
    const taken = await repo().acquire(successor)
    if (taken.outcome !== 'acquired') throw new Error('expected the successor to acquire')
    await repo().issueOperation({
      attemptId: successor.attemptId,
      orgId: DEFAULT_ORG_ID,
      fence: taken.lease.fence,
      daemonId: DAEMON_B,
      kind: 'bulk_publish',
      method: 'POST',
      target: '/projects/1/merge_requests/42/draft_notes/bulk_publish',
      ordinal: 0,
      now: later
    })

    const replay = await repo().returnOperationUnused({ ...base, recordId: issued.record.id })
    // Same record, and a phase that belongs to the old fence rather than the successor's.
    expect('outcome' in replay && replay.record).toEqual('outcome' in returned ? returned.record : undefined)
    expect('outcome' in replay && replay.phase).toBe('settled')
    const after = await prisma.codeHostReviewLease.findFirstOrThrow({
      where: { projectExternalId: s.projectExternalId }
    })
    expect(after).toMatchObject({ attemptId: successor.attemptId, phase: 'publishing' })
  })
})
