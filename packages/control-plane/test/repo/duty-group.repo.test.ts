// DutyGroupRepo — the k8s duty ledger (real Postgres).
// Claims are CAS grants (first valid claim wins), renewal is holder-conditional
// and term-preserving, and applyReconcile applies the pure planner's output
// under a per-org advisory scope.
import { beforeEach, describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { planDutyReconcile, computeDutyComponents } from '../../src/orchestrator/dutyGroup.js'
import type { DutyGroupRecord } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { joinPool } from '../fakes/member-set.js'

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
  // The rendezvous is a claim path, so it takes the eligibility gate too — which means the agent
  // has to be placed on the pool AND the claimant has to be one of its members. Eligibility reads
  // membership from the ledger's own tables, so a claimant now has to be a real enrolled daemon.
  beforeEach(async () => {
    await prisma.daemon.createMany({
      data: [
        { id: M1, orgId: null, maxAgents: 8, status: 'ready' },
        { id: M2, orgId: null, maxAgents: 8, status: 'ready' }
      ]
    })
    const setId = await joinPool(prisma, M1, M2)
    await prisma.agent.create({
      data: { id: A1, orgId: DEFAULT_ORG_ID, name: 'pooled', runtime: 'claude', placementKind: 'set', setId }
    })
  })

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

  it('holdsAgent answers only for the live holder — the duty/fetch authorization', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)

    expect(await repo.holdsAgent(M1, AgentId(A1), T0)).toBe(true)
    // Another member holds nothing here, and neither does the holder for an agent
    // outside its groups — a member gets exactly the agents it has won.
    expect(await repo.holdsAgent(M2, AgentId(A1), T0)).toBe(false)
    expect(await repo.holdsAgent(M1, AgentId(A2), T0)).toBe(false)
    // A lapsed lease is not a holding.
    expect(await repo.holdsAgent(M1, AgentId(A1), after(LEASE_MS + 1))).toBe(false)
  })

  it('holdsAgent covers every agent of a multi-member group', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A2, botId: B1 }
      ],
      [],
      T0
    )
    await repo.claimVacant(M1, 10, T0, LEASE_MS)

    expect(await repo.holdsAgent(M1, AgentId(A1), T0)).toBe(true)
    expect(await repo.holdsAgent(M1, AgentId(A2), T0)).toBe(true)
  })

  it('holdersOf and heldAgentIds are the delivery/roster halves of holdsAgent', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A2, botId: B2 }
      ],
      [],
      T0
    )
    const [first] = await repo.listForOrg(ORG)
    await repo.claimVacant(M1, 1, T0, LEASE_MS)
    const heldAgent = first!.members.find((m) => m.kind === 'agent')!.refId

    expect(await repo.holdersOf(AgentId(heldAgent), T0)).toEqual([M1])
    expect(await repo.heldAgentIds(M1, T0)).toEqual([heldAgent])
    // A lapsed lease is not a holding on either side — the same fence as holdsAgent.
    expect(await repo.holdersOf(AgentId(heldAgent), after(LEASE_MS + 1))).toEqual([])
    expect(await repo.heldAgentIds(M1, after(LEASE_MS + 1))).toEqual([])
  })

  it('holdersOf survives the agent row it names — a delete must still reach the holder', async () => {
    const repo = new PgDutyGroupRepo(prisma, minter())
    await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)
    // No FK from membership to `agent`: the projection owns that lifecycle, so a
    // cascade cannot strand `agent/remove` with nowhere to send it.
    expect(await repo.holdersOf(AgentId(A1), T0)).toEqual([M1])
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

describe('DutyGroupRepo — the rollout barrier `newerGenerationLive` (real Postgres)', () => {
  const M3 = DaemonId('d3333333-3333-4333-8333-333333333333')
  const OTHER_SET_MEMBER = DaemonId('d4444444-4444-4444-8444-444444444444')

  async function member(id: string, generation: string | null, since: Date | null, lastSeenAt: Date | null) {
    await prisma.daemon.create({
      data: { id, orgId: null, maxAgents: 8, status: 'ready', generation, generationSince: since, lastSeenAt }
    })
  }

  it('an older generation is held back while a live member of a newer generation exists in its set', async () => {
    await member(M1, 'old', after(-600_000), T0)
    await member(M2, 'new', after(-60_000), T0)
    await joinPool(prisma, M1, M2)
    const repo = new PgDutyGroupRepo(prisma, minter())

    expect(await repo.newerGenerationLive(M1, T0, LEASE_MS)).toBe(true)
    // The newest generation itself is unaffected.
    expect(await repo.newerGenerationLive(M2, T0, LEASE_MS)).toBe(false)
  })

  it('a sole generation claims, and a claimant that has not beaten yet still counts as live', async () => {
    await member(M1, 'only', after(-600_000), null)
    await member(M2, 'only', after(-500_000), T0)
    await joinPool(prisma, M1, M2)
    const repo = new PgDutyGroupRepo(prisma, minter())

    expect(await repo.newerGenerationLive(M1, T0, LEASE_MS)).toBe(false)
  })

  it('a null-generation claimant is never held back, and null peers rank nothing', async () => {
    await member(M1, null, null, T0)
    await member(M2, 'new', after(-60_000), T0)
    await member(M3, null, null, T0)
    await joinPool(prisma, M1, M2, M3)
    const repo = new PgDutyGroupRepo(prisma, minter())

    expect(await repo.newerGenerationLive(M1, T0, LEASE_MS)).toBe(false)
    expect(await repo.newerGenerationLive(M2, T0, LEASE_MS)).toBe(false)
  })

  it('a newer member that stopped beating does not hold anyone back; a peer in another set never counts', async () => {
    await member(M1, 'old', after(-600_000), T0)
    // Newer, but its last beat is past the lease horizon: dead for the ledger's purposes.
    await member(M2, 'new', after(-60_000), after(-LEASE_MS - 1))
    await joinPool(prisma, M1, M2)
    // Newer and live — but in a different set.
    await member(OTHER_SET_MEMBER, 'newest', after(-1_000), T0)
    const other = await prisma.memberSet.create({
      data: { id: '55555555-5555-4555-8555-555555555555', orgId: DEFAULT_ORG_ID, name: 'other' }
    })
    await prisma.memberSetMember.create({ data: { setId: other.id, daemonId: OTHER_SET_MEMBER } })
    const repo = new PgDutyGroupRepo(prisma, minter())

    expect(await repo.newerGenerationLive(M1, T0, LEASE_MS)).toBe(false)
    // Its beat resumes ⇒ it holds the older generation back again.
    await prisma.daemon.update({ where: { id: M2 }, data: { lastSeenAt: T0 } })
    expect(await repo.newerGenerationLive(M1, T0, LEASE_MS)).toBe(true)
  })

  it('a re-register with the same generation keeps its first-seen stamp; a new value re-stamps it', async () => {
    await member(M1, null, null, T0)
    const daemons = new PgDaemonRepo(prisma)
    const reg = { host: 'm', capabilities: { platforms: [], runtimes: [], acp: true, features: [] }, maxAgents: 8 }
    await daemons.applyRegister(M1, { ...reg, generation: 'g1' }, T0)
    await daemons.applyRegister(M1, { ...reg, generation: 'g1' }, after(10_000))
    let row = await prisma.daemon.findUniqueOrThrow({ where: { id: M1 } })
    expect(row.generation).toBe('g1')
    expect(row.generationSince).toEqual(T0)
    await daemons.applyRegister(M1, { ...reg, generation: 'g2' }, after(20_000))
    row = await prisma.daemon.findUniqueOrThrow({ where: { id: M1 } })
    expect(row.generation).toBe('g2')
    expect(row.generationSince).toEqual(after(20_000))
  })
})
