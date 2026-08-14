// DutyGroupRepo — the k8s duty ledger (real Postgres).
// Claims are CAS grants (first valid claim wins), renewal is holder-conditional
// and term-preserving, and applyReconcile applies the pure planner's output
// under a per-org advisory scope.
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { planDutyReconcile, computeDutyComponents } from '../../src/orchestrator/dutyGroup.js'
import type { DutyGroupRecord } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const M1 = DaemonId('d1111111-1111-4111-8111-111111111111')
const M2 = DaemonId('d2222222-2222-4222-8222-222222222222')
const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

const T0 = new Date('2026-01-01T00:00:00Z')
const LEASE_MS = 120_000
const after = (ms: number) => new Date(T0.getTime() + ms)

/** Deterministic id mint: g-1, g-2, … as UUID-shaped strings. */
function minter() {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

const heldJudge = (now: Date) => (records: DutyGroupRecord[]) =>
  records.map((r) => ({
    groupId: r.groupId,
    held: r.holder !== null && r.expiresAt !== null && r.expiresAt > now,
    holder: r.holder,
    members: r.members
  }))

function reconcile(repo: PgDutyGroupRepo, edges: { agentId: string; botId: string }[], seeds: string[], now: Date) {
  const components = computeDutyComponents(
    edges,
    seeds.map((agentId) => ({ agentId }))
  )
  return repo.applyReconcile(ORG, (existing) => planDutyReconcile(heldJudge(now)(existing), components), {
    now,
    leaseMs: LEASE_MS
  })
}

describe('DutyGroupRepo — ledger writes (real Postgres)', () => {
  it('reconcile creates vacant groups; claimVacant grants them with a term bump', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [A2], T0)

    const rows = await repo.listForOrg(ORG)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.holder === null && r.term === 0n && r.expiresAt === null)).toBe(true)

    const grants = await repo.claimVacant(M1, 10, T0, LEASE_MS)
    expect(grants).toHaveLength(2)
    expect(grants.every((g) => g.term === 1n)).toBe(true)
    expect(grants.map((g) => g.members)).toContainEqual([
      { kind: 'agent', refId: A1 },
      { kind: 'bot', refId: B1 }
    ])
  })

  it('claimVacant respects max', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [A2], T0)

    expect(await repo.claimVacant(M1, 1, T0, LEASE_MS)).toHaveLength(1)
    expect(await repo.claimVacant(M2, 10, T0, LEASE_MS)).toHaveLength(1)
  })

  it('racing claimants never receive the same group', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [A2], T0)

    const [g1, g2] = await Promise.all([repo.claimVacant(M1, 2, T0, LEASE_MS), repo.claimVacant(M2, 2, T0, LEASE_MS)])
    const ids = [...g1, ...g2].map((g) => g.groupId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(2)
  })

  it('an expired lease is grantable again at a higher term', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)

    const late = after(LEASE_MS + 1)
    const regrants = await repo.claimVacant(M2, 1, late, LEASE_MS)
    expect(regrants).toHaveLength(1)
    expect(regrants[0]!.term).toBe(2n)
    const [row] = await repo.listHeldBy(M2)
    expect(row!.holder).toBe(M2)
  })

  it('renewHeld refreshes the horizon term-free; a reassigned group stops matching', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)

    const renewed = await repo.renewHeld(M1, after(10_000), LEASE_MS)
    expect(renewed).toHaveLength(1)
    const [row] = await repo.listHeldBy(M1)
    expect(row!.term).toBe(1n)
    expect(row!.expiresAt).toEqual(after(10_000 + LEASE_MS))

    // Lapse, reassign to M2, then the old holder's renewal matches nothing.
    const late = after(LEASE_MS * 2)
    await repo.claimVacant(M2, 1, late, LEASE_MS)
    expect(await repo.renewHeld(M1, after(LEASE_MS * 2 + 1000), LEASE_MS)).toEqual([])
  })

  it('a lapsed-but-unclaimed lease still renews at the same term (CP outage recovery)', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)

    const renewed = await repo.renewHeld(M1, after(LEASE_MS * 3), LEASE_MS)
    expect(renewed).toHaveLength(1)
    const [row] = await repo.listHeldBy(M1)
    expect(row!.term).toBe(1n)
  })

  it('release vacates immediately, keeps the term, and is holder-conditional', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)
    const [grant] = await repo.claimVacant(M1, 1, T0, LEASE_MS)

    await repo.release(M2, [grant!.groupId]) // not the holder — no-op
    expect(await repo.listHeldBy(M1)).toHaveLength(1)

    await repo.release(M1, [grant!.groupId])
    expect(await repo.listHeldBy(M1)).toHaveLength(0)
    const regrant = await repo.claimVacant(M2, 1, after(1), LEASE_MS)
    expect(regrant[0]!.term).toBe(2n)
  })

  it('reconcile re-grants the incumbent at a bumped term when a held group gains a bot', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)

    const plan = await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A1, botId: B2 }
      ],
      [],
      after(1000)
    )
    expect(plan.superseded).toEqual([])
    const [row] = await repo.listHeldBy(M1)
    expect(row!.term).toBe(2n)
    expect(row!.members).toHaveLength(3)
  })

  it('reconcile merge keeps the larger held group and reports the loser superseded', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [A2], T0)
    const grants1 = await repo.claimVacant(M1, 1, T0, LEASE_MS)
    const grants2 = await repo.claimVacant(M2, 1, T0, LEASE_MS)
    const bigHolder = grants1[0]!.members.length > grants2[0]!.members.length ? M1 : M2

    // A2 gains an integration on B1: the {A1,B1} pair and the {A2} singleton merge.
    const plan = await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A2, botId: B1 }
      ],
      [],
      after(1000)
    )
    expect(plan.superseded).toHaveLength(1)
    const survivors = await repo.listForOrg(ORG)
    expect(survivors).toHaveLength(1)
    expect(survivors[0]!.holder).toBe(bigHolder)
    expect(survivors[0]!.members).toHaveLength(3)
  })

  it('reconcile deletes groups whose edges vanished', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)

    const plan = await reconcile(repo, [], [], after(1000))
    expect(plan.deletes).toHaveLength(1)
    expect(plan.superseded).toEqual([{ groupId: plan.deletes[0]!, holder: M1 }])
    expect(await repo.listForOrg(ORG)).toEqual([])
  })

  it('a grant racing a reconcile is never silently destroyed', async () => {
    // The reconcile deletes the group (its edges vanished). Whichever side
    // commits first, the outcome must be coherent: a claimant that won the
    // grant must be named superseded by the plan; a claimant that skipped the
    // reconcile-locked row must get nothing and the plan supersedes nobody.
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)

    const [grants, plan] = await Promise.all([repo.claimVacant(M1, 1, T0, LEASE_MS), reconcile(repo, [], [], after(1))])
    expect(plan.deletes).toHaveLength(1)
    if (grants.length === 1) expect(plan.superseded).toEqual([{ groupId: grants[0]!.groupId, holder: M1 }])
    else expect(plan.superseded).toEqual([])
    expect(await repo.listForOrg(ORG)).toEqual([])
  })

  it('reconcile leaves an unchanged held group untouched (no term churn)', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)

    const plan = await reconcile(repo, [{ agentId: A1, botId: B1 }], [], after(1000))
    expect(plan.unchanged).toHaveLength(1)
    const [row] = await repo.listHeldBy(M1)
    expect(row!.term).toBe(1n)
  })
})

describe('DutyGroupRepo — agent-home claims (real Postgres)', () => {
  it('claiming creates the lease for an unmapped agent', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    const claim = await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)
    expect(claim).toMatchObject({ granted: true, term: 1n, holder: M1 })
    const rows = await repo.listForOrg(ORG)
    expect(rows[0]!.members).toEqual([{ kind: 'agent', refId: A1 }])
  })

  it('is idempotent for the current holder — horizon refreshed, term kept', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)
    const again = await repo.claimAgentHome(ORG, AgentId(A1), M1, after(10_000), LEASE_MS)
    expect(again).toMatchObject({ granted: true, term: 1n, holder: M1 })
    const [row] = await repo.listHeldBy(M1)
    expect(row!.expiresAt).toEqual(after(10_000 + LEASE_MS))
  })

  it('names the incumbent instead of granting while the home is live', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    const won = await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)
    const lost = await repo.claimAgentHome(ORG, AgentId(A1), M2, after(1000), LEASE_MS)
    expect(lost).toEqual({ granted: false, groupId: won.groupId, term: 1n, holder: M1 })
  })

  it('grants an expired home to the new claimant at a bumped term', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)
    const claim = await repo.claimAgentHome(ORG, AgentId(A1), M2, after(LEASE_MS + 1), LEASE_MS)
    expect(claim).toMatchObject({ granted: true, term: 2n, holder: M2 })
  })

  it('racing first claims resolve to exactly one home and one winner', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    const [c1, c2] = await Promise.all([
      repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS),
      repo.claimAgentHome(ORG, AgentId(A1), M2, T0, LEASE_MS)
    ])
    expect([c1.granted, c2.granted].filter(Boolean)).toHaveLength(1)
    expect(c1.groupId).toBe(c2.groupId)
    expect(await prisma.dutyGroup.count()).toBe(1)
  })
})
