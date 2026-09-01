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

  it('the claim statements carry the barrier themselves: an older-generation claimant updates 0 rows, the sole generation claims', async () => {
    await member(M1, 'old', after(-600_000), T0)
    await member(M2, 'new', after(-60_000), T0)
    const setId = await joinPool(prisma, M1, M2)
    await prisma.agent.create({
      data: { id: A1, orgId: DEFAULT_ORG_ID, name: 'pooled', runtime: 'claude', placementKind: 'set', setId }
    })
    await prisma.agent.create({
      data: { id: A2, orgId: DEFAULT_ORG_ID, name: 'pooled-2', runtime: 'claude', placementKind: 'set', setId }
    })
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)

    // Vacancy claim: the older generation's UPDATE matches nothing while the newer live peer exists.
    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS)).toEqual([])
    // Rendezvous — taking an existing vacant home, and minting a new one — both refused the same way.
    expect((await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)).granted).toBe(false)
    expect((await repo.claimAgentHome(ORG, AgentId(A2), M1, T0, LEASE_MS)).granted).toBe(false)
    expect(await prisma.dutyGroup.count({ where: { holder: M1 } })).toBe(0)
    // The newest generation claims through every path.
    expect(await repo.claimVacant(M2, 10, T0, LEASE_MS)).toHaveLength(1)
    expect((await repo.claimAgentHome(ORG, AgentId(A2), M2, T0, LEASE_MS)).granted).toBe(true)

    // Once the newer peer is dead for the ledger, the same statements let the older member claim.
    await repo.release(
      M2,
      (await repo.listHeldBy(M2)).map((g) => g.groupId)
    )
    await prisma.daemon.update({ where: { id: M2 }, data: { lastSeenAt: after(-LEASE_MS - 1) } })
    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS)).toHaveLength(2)
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

describe('DutyGroupRepo — pool telemetry (real Postgres)', () => {
  const MAX_MEMBERS = 1000
  /** An ORG-scoped daemon — the machine placement the pool must not read as its own demand. */
  const LOCAL = DaemonId('d4444444-4444-4444-8444-444444444444')
  /** The pool set's row, whatever the migration named it. */
  const poolRow = async (repo: PgDutyGroupRepo, now = T0, maxMembers = MAX_MEMBERS) =>
    (await repo.poolTelemetry(now, LEASE_MS, maxMembers)).find((r) => r.installWide)!

  async function liveMember(id: string, maxAgents = 8, lastSeenAt: Date | null = T0) {
    await prisma.daemon.create({ data: { id, orgId: null, maxAgents, status: 'ready', lastSeenAt } })
  }

  it('capacity is the live members budget; a member past the lease horizon leaves it', async () => {
    await liveMember(M1, 8)
    await liveMember(M2, 4, after(-LEASE_MS - 1))
    await joinPool(prisma, M1, M2)
    const repo = new PgDutyGroupRepo(prisma, minter())

    const row = await poolRow(repo)
    expect(row).toMatchObject({ liveMembers: 1, capacityAgents: 8, dutyAgents: 0 })

    // Its beat resumes ⇒ its budget is spendable again.
    await prisma.daemon.update({ where: { id: M2 }, data: { lastSeenAt: T0 } })
    expect(await poolRow(repo)).toMatchObject({ liveMembers: 2, capacityAgents: 12 })
  })

  // The property the whole alert rests on: `duty_group` holds one permanently-vacant singleton per
  // machine-placed agent (§6). Counting those as unmet demand would pin the alarm high forever.
  it('a machine-placed agent vacancy is not the pool unmet demand', async () => {
    await liveMember(M1)
    await joinPool(prisma, M1)
    await prisma.daemon.create({ data: { id: LOCAL, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    await prisma.agent.create({
      data: {
        id: A1,
        orgId: DEFAULT_ORG_ID,
        name: 'on-a-machine',
        runtime: 'claude',
        placementKind: 'daemon',
        daemonId: LOCAL
      }
    })
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)

    // The row exists and is vacant — and is invisible to the pool's demand.
    expect(await prisma.dutyGroup.count()).toBe(1)
    expect(await poolRow(repo, after(600_000))).toMatchObject({ vacantGroups: 0, oldestVacancySec: 0 })
  })

  it('a set-placed vacancy is demand, and ages from the moment its lease lapsed', async () => {
    await liveMember(M1)
    const setId = await joinPool(prisma, M1)
    await prisma.agent.create({
      data: { id: A1, orgId: DEFAULT_ORG_ID, name: 'pooled', runtime: 'claude', placementKind: 'set', setId }
    })
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [], [A1], T0)
    expect(await poolRow(repo)).toMatchObject({ vacantGroups: 1, dutyAgents: 0 })

    // Held: it leaves the demand and spends a unit of budget.
    await repo.claimVacant(M1, 10, T0, LEASE_MS)
    expect(await poolRow(repo, after(1000))).toMatchObject({ vacantGroups: 0, dutyAgents: 1, capacityAgents: 8 })

    // Lapsed: back to demand, aged from `expiresAt` — not from the read — and the budget is free.
    const lapsed = after(LEASE_MS + 60_000)
    expect(await poolRow(repo, lapsed)).toMatchObject({ vacantGroups: 1, dutyAgents: 0, oldestVacancySec: 60 })
  })

  // maxAgents <= 0 is the daemon's UNBOUNDED sentinel, not a ceiling of zero, and the wire schema
  // (z.number().int()) admits negatives too. Folding either into the sum would report a member
  // that accepts everything as contributing nothing.
  it('counts an unbounded member apart and keeps its sentinel out of the capacity sum', async () => {
    await liveMember(M1, 8)
    await liveMember(M2, 0)
    await joinPool(prisma, M1, M2)
    const repo = new PgDutyGroupRepo(prisma, minter())

    const row = await poolRow(repo)
    expect(row).toMatchObject({ liveMembers: 2, unboundedMembers: 1, capacityAgents: 8 })

    // A negative ceiling is the same sentinel, and must not subtract from the budget either.
    await prisma.daemon.update({ where: { id: M2 }, data: { maxAgents: -4 } })
    expect(await poolRow(repo)).toMatchObject({ unboundedMembers: 1, capacityAgents: 8 })

    // Give it a real ceiling and the set becomes bounded again, budget included.
    await prisma.daemon.update({ where: { id: M2 }, data: { maxAgents: 4 } })
    expect(await poolRow(repo)).toMatchObject({ unboundedMembers: 0, capacityAgents: 12 })
  })

  it('an unbounded member that has gone quiet stops making the set unbounded', async () => {
    await liveMember(M1, 8)
    await liveMember(M2, 0, after(-LEASE_MS - 1))
    await joinPool(prisma, M1, M2)
    const repo = new PgDutyGroupRepo(prisma, minter())

    // Liveness gates this exactly as it gates capacity: a dead member constrains nothing.
    expect(await poolRow(repo)).toMatchObject({ liveMembers: 1, unboundedMembers: 0, capacityAgents: 8 })
  })

  // An oversized group is undeliverable on the wire at ANY pool size (§5) — scaling the Deployment
  // would never clear it, so it must not be able to hold the capacity alert up.
  it('an oversized vacancy is reported apart from the claimable demand', async () => {
    await liveMember(M1)
    const setId = await joinPool(prisma, M1)
    await prisma.agent.createMany({
      data: [
        { id: A1, orgId: DEFAULT_ORG_ID, name: 'pooled', runtime: 'claude', placementKind: 'set', setId },
        { id: A2, orgId: DEFAULT_ORG_ID, name: 'pooled-2', runtime: 'claude', placementKind: 'set', setId }
      ]
    })
    const repo = new PgDutyGroupRepo(prisma, minter())
    // One group of two members (agent+bot), one singleton; a cap of 1 makes the pair oversized.
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [A2], T0)
    // The claimable singleton, lapsed 60s ago — the only age the pool should report.
    await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: 1 })
    // The undeliverable pair, made FAR older than that. A never-claimed group ages from
    // `updatedAt`, which only raw SQL can backdate past Prisma's @updatedAt.
    await prisma.$executeRaw`
      UPDATE "duty_group" SET "updatedAt" = ${after(-3_600_000)}
      WHERE (SELECT count(*) FROM "duty_group_member" m WHERE m."groupId" = "duty_group".id) > 1`

    const row = await poolRow(repo, after(LEASE_MS + 60_000), 1)
    expect(row).toMatchObject({ vacantGroups: 1, oversizedVacantGroups: 1 })
    // The age is the claimable one's; the hour-old undeliverable group cannot pin the alert up.
    expect(row.oldestVacancySec).toBe(60)
  })

  it('a group mixing a set-placed and a machine-placed agent is demand for nobody', async () => {
    await liveMember(M1)
    const setId = await joinPool(prisma, M1)
    await prisma.daemon.create({ data: { id: LOCAL, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    await prisma.agent.createMany({
      data: [
        { id: A1, orgId: DEFAULT_ORG_ID, name: 'pooled', runtime: 'claude', placementKind: 'set', setId },
        { id: A2, orgId: DEFAULT_ORG_ID, name: 'machined', runtime: 'claude', placementKind: 'daemon', daemonId: LOCAL }
      ]
    })
    const repo = new PgDutyGroupRepo(prisma, minter())
    // Two agents joined by one bot ⇒ ONE component holding both, claimable by neither side.
    await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A2, botId: B1 }
      ],
      [],
      T0
    )

    expect(await prisma.dutyGroup.count()).toBe(1)
    expect(await poolRow(repo, after(600_000))).toMatchObject({ vacantGroups: 0, oversizedVacantGroups: 0 })
  })
})

// The capability gate: a member may claim a group only when it advertises a module for every
// platform the group's active integrations name. A daemon fails CLOSED on an unregistered platform
// — it skips the integration and opens no connection — so an old image claiming a newly-integrated
// agent takes that surface dark silently. This is the rollout window every new platform opens.
describe('DutyGroupRepo — the platform-capability claim gate (real Postgres)', () => {
  const MAX_MEMBERS = 1000
  /** The image before a platform lands, and the one that carries it. */
  const OLD_IMAGE = ['slack', 'telegram', 'discord', 'feishu']
  const NEW_IMAGE = [...OLD_IMAGE, 'linear']
  const A3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
  const I1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
  const I2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'

  const poolRow = async (repo: PgDutyGroupRepo, now = T0) =>
    (await repo.poolTelemetry(now, LEASE_MS, MAX_MEMBERS)).find((r) => r.installWide)!

  async function member(id: string, platforms: string[], lastSeenAt: Date | null = T0) {
    await prisma.daemon.create({
      data: {
        id,
        orgId: null,
        maxAgents: 8,
        status: 'ready',
        lastSeenAt,
        capabilities: { platforms, runtimes: ['claude'], acp: true, features: [] }
      }
    })
  }

  async function pooledAgent(id: string, setId: string, name: string) {
    await prisma.agent.create({
      data: { id, orgId: DEFAULT_ORG_ID, name, runtime: 'claude', placementKind: 'set', setId }
    })
  }

  /** One active integration on its own bot — the edge the recompute reads and the platform requirement. */
  async function integrate(integrationId: string, agentId: string, botId: string, platform: string) {
    await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform, name: `${platform}-bot` } })
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform, name: `${platform}-bot` }
    })
  }

  it('a member whose image lacks the platform is passed over; the one that carries it claims', async () => {
    await member(M1, OLD_IMAGE)
    await member(M2, NEW_IMAGE)
    const setId = await joinPool(prisma, M1, M2)
    await pooledAgent(A1, setId, 'needs-linear')
    await integrate(I1, A1, B1, 'linear')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)

    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })).toEqual([])
    const granted = await repo.claimVacant(M2, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })
    expect(granted).toHaveLength(1)
    expect(await repo.holdsAgent(M2, AgentId(A1), T0)).toBe(true)
  })

  // Fail-closed is the point: unserved and visible beats served-and-silently-dead.
  it('stays vacant when NO live member advertises the platform, and the alert says why', async () => {
    await member(M1, OLD_IMAGE)
    const setId = await joinPool(prisma, M1)
    await pooledAgent(A1, setId, 'needs-linear')
    await integrate(I1, A1, B1, 'linear')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)

    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })).toEqual([])
    // Made an hour old, so "the alarm cannot be pinned by it" is an assertion rather than a tautology.
    await prisma.$executeRaw`UPDATE "duty_group" SET "updatedAt" = ${after(-3_600_000)}`

    // Reported apart from the claimable demand, like an oversized group: scaling the pool cannot
    // clear it, so it must not pin the capacity alarm — rolling the image forward is the fix.
    expect(await poolRow(repo, after(60_000))).toMatchObject({
      vacantGroups: 0,
      capabilityBlockedVacantGroups: 1,
      oldestVacancySec: 0
    })

    // A member that carries the platform joins: the same group becomes ordinary demand and places.
    await member(M2, NEW_IMAGE)
    await joinPool(prisma, M2)
    const row = await poolRow(repo, after(60_000))
    expect(row).toMatchObject({ vacantGroups: 1, capabilityBlockedVacantGroups: 0 })
    expect(row.oldestVacancySec).toBeGreaterThan(3_600)
    expect(await repo.claimVacant(M2, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })).toHaveLength(1)
  })

  // A quiet or scaled-to-zero set has no live member to prove an image gap against, so its
  // vacancies stay ordinary demand — "the pool is empty" is what `members` reports, not this.
  it('a set with no live member reports demand, not a capability gap', async () => {
    await member(M1, OLD_IMAGE)
    const setId = await joinPool(prisma, M1)
    await pooledAgent(A1, setId, 'needs-linear')
    await integrate(I1, A1, B1, 'linear')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)

    const quiet = after(LEASE_MS + 1)
    expect(await poolRow(repo, quiet)).toMatchObject({
      liveMembers: 0,
      vacantGroups: 1,
      capabilityBlockedVacantGroups: 0
    })
  })

  // The parity rule the pool gauges live under: the alert's eligibility must state what the claim
  // decides, or it alarms on work no pool size could take. With one live member the set-wise
  // predicate reduces to that member's own, so the two counts are directly comparable.
  it('parity: with one live member the alert counts exactly what that member claims and refuses', async () => {
    await member(M1, OLD_IMAGE)
    const setId = await joinPool(prisma, M1)
    await pooledAgent(A1, setId, 'needs-linear')
    await pooledAgent(A2, setId, 'needs-slack')
    await pooledAgent(A3, setId, 'botless')
    await integrate(I1, A1, B1, 'linear')
    await integrate(I2, A2, B2, 'slack')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A2, botId: B2 }
      ],
      [A3],
      T0
    )

    const before = await poolRow(repo)
    expect(before).toMatchObject({ vacantGroups: 2, capabilityBlockedVacantGroups: 1 })

    const granted = await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })
    expect(granted).toHaveLength(before.vacantGroups)
    expect(await poolRow(repo, after(1000))).toMatchObject({
      vacantGroups: 0,
      capabilityBlockedVacantGroups: before.capabilityBlockedVacantGroups
    })
  })

  // No behavior change where every member runs the same image — the pool's normal state.
  it('a homogeneous pool claims exactly what it claimed before the gate existed', async () => {
    await member(M1, NEW_IMAGE)
    await member(M2, NEW_IMAGE)
    const setId = await joinPool(prisma, M1, M2)
    await pooledAgent(A1, setId, 'needs-linear')
    await pooledAgent(A2, setId, 'needs-slack')
    await pooledAgent(A3, setId, 'botless')
    await integrate(I1, A1, B1, 'linear')
    await integrate(I2, A2, B2, 'slack')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(
      repo,
      [
        { agentId: A1, botId: B1 },
        { agentId: A2, botId: B2 }
      ],
      [A3],
      T0
    )

    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })).toHaveLength(3)
    expect(await poolRow(repo, after(1000))).toMatchObject({ vacantGroups: 0, capabilityBlockedVacantGroups: 0 })
  })

  // The gate reads the same rows the install-time one does: an integration that is no longer
  // active asks nothing of the member holding its agent.
  it('a revoked integration stops requiring its platform', async () => {
    await member(M1, OLD_IMAGE)
    const setId = await joinPool(prisma, M1)
    await pooledAgent(A1, setId, 'needs-linear')
    await integrate(I1, A1, B1, 'linear')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)
    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })).toEqual([])

    await prisma.integration.update({ where: { id: I1 }, data: { status: 'revoked' } })
    expect(await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })).toHaveLength(1)
  })

  // The rendezvous is a claim path too: a trigger reaching the wrong member is not authority to
  // serve a platform that member has no module for.
  it('the activation rendezvous takes the same gate', async () => {
    await member(M1, OLD_IMAGE)
    await member(M2, NEW_IMAGE)
    const setId = await joinPool(prisma, M1, M2)
    await pooledAgent(A1, setId, 'needs-linear')
    await integrate(I1, A1, B1, 'linear')
    const repo = new PgDutyGroupRepo(prisma, minter())

    expect(await repo.claimAgentHome(ORG, AgentId(A1), M1, T0, LEASE_MS)).toEqual({ granted: false, holder: null })
    expect(await prisma.dutyGroup.count()).toBe(0)
    expect((await repo.claimAgentHome(ORG, AgentId(A1), M2, T0, LEASE_MS)).granted).toBe(true)
  })

  // The claim's own diagnostic — negating the very predicate the claim carries, so it can only
  // ever name groups the claim actually refused, and only the platforms this member is missing.
  it('capabilityBlockedVacancies names the passed-over agent and only the platforms it lacks', async () => {
    await member(M1, OLD_IMAGE)
    const setId = await joinPool(prisma, M1)
    await pooledAgent(A1, setId, 'needs-both')
    await integrate(I1, A1, B1, 'linear')
    await integrate(I2, A1, B2, 'slack')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [], T0)

    const blocked = await repo.capabilityBlockedVacancies(M1, T0, { maxMembers: MAX_MEMBERS })
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({ agentId: A1, missingPlatforms: ['linear'] })

    // Nothing to report once the group is claimable — the member that carries the platform sees none.
    await member(M2, NEW_IMAGE)
    await joinPool(prisma, M2)
    expect(await repo.capabilityBlockedVacancies(M2, T0, { maxMembers: MAX_MEMBERS })).toEqual([])
  })

  // Fail-closed on the daemon read itself: a row whose capabilities carry no list advertises
  // nothing, rather than reading as "no restriction".
  it('a member whose capabilities name no platform list claims nothing that needs one', async () => {
    await prisma.daemon.create({ data: { id: M1, orgId: null, maxAgents: 8, status: 'ready', lastSeenAt: T0 } })
    const setId = await joinPool(prisma, M1)
    await pooledAgent(A1, setId, 'needs-slack')
    await pooledAgent(A2, setId, 'botless')
    await integrate(I1, A1, B1, 'slack')
    const repo = new PgDutyGroupRepo(prisma, minter())
    await reconcile(repo, [{ agentId: A1, botId: B1 }], [A2], T0)

    // Only the botless singleton, which requires nothing at all.
    const granted = await repo.claimVacant(M1, 10, T0, LEASE_MS, { maxMembers: MAX_MEMBERS })
    expect(granted).toHaveLength(1)
    expect(granted[0]!.members).toEqual([{ kind: 'agent', refId: A2 }])
  })
})
