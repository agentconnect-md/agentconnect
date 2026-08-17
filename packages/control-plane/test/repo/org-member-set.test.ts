/**
 * Org-scoped member sets — the eligibility matrix (docs/designs/daemon-groups.md §3, §6 PR 2).
 *
 * The point of the whole shape is that admitting org-scoped claimants into the ledger widens
 * NOTHING: `mayHold` stays one rule, and the tenancy narrowing follows from what membership is
 * allowed to mean. So this file is the matrix that proves it — one member of one org's set, and
 * every agent it must NOT be able to claim, each refused by the same predicate that grants it its
 * own. If any row here flips, an organization's machine can reach another organization's work.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PgMemberSetRepo } from '../../src/persistence/repositories/member-set.repo.js'
import {
  DaemonAlreadyInSet,
  DaemonHasPlacedAgents,
  DaemonHoldsDuty,
  DaemonPlacementInSet,
  MemberSetInUse
} from '../../src/persistence/errors.js'
import { onDaemon, onSet } from '../../src/domain/placement.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedPoolMember } from '../fakes/member-set.js'

const ORG_X = OrgId(DEFAULT_ORG_ID)
const MEMBER_G = 'd1111111-1111-4111-8111-111111111111' // org X, in set G
const MEMBER_H = 'd2222222-2222-4222-8222-222222222222' // org X, in set H
const PINNED = 'd3333333-3333-4333-8333-333333333333' // org X, in no set
const POOL_MEMBER = 'd4444444-4444-4444-8444-444444444444'
const T0 = new Date('2026-01-01T00:00:00Z')
const LEASE_MS = 120_000

const sets = () => new PgMemberSetRepo(prisma)
const agents = () => new PgAgentRepo(prisma)
const ledger = () => new PgDutyGroupRepo(prisma)

/** An agent of `orgId`, placed on `setId`, with its duty group materialized by a first claim. */
async function setAgent(orgId: string, setId: string, name: string): Promise<AgentId> {
  const id = AgentId(randomUUID())
  await agents().create({ id, orgId: OrgId(orgId), name, runtime: 'claude', placementKind: 'set', setId })
  return id
}

/** A second organization with a daemon and a set of its own. */
async function otherOrg(): Promise<{ orgId: string; setId: string; daemonId: string }> {
  const org = await prisma.org.create({ data: { slug: `org-set-${randomUUID().slice(0, 8)}` } })
  const setId = (await sets().createForOrg(org.id, 'their-group')).id
  const daemonId = randomUUID()
  await prisma.daemon.create({ data: { id: daemonId, orgId: org.id, maxAgents: 8, status: 'ready' } })
  await sets().enroll(setId, DaemonId(daemonId))
  return { orgId: org.id, setId, daemonId }
}

describe('an org set member’s eligibility (real Postgres)', () => {
  let setG: string
  let setH: string

  beforeEach(async () => {
    await prisma.daemon.createMany({
      data: [MEMBER_G, MEMBER_H, PINNED].map((id) => ({ id, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' }))
    })
    setG = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    setH = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-h')).id
    await sets().enroll(setG, DaemonId(MEMBER_G))
    await sets().enroll(setH, DaemonId(MEMBER_H))
  })

  it('claims a set-placed agent of its own org in its own set', async () => {
    const agentId = await setAgent(DEFAULT_ORG_ID, setG, 'ours')
    expect(await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)).toMatchObject({
      granted: true,
      holder: MEMBER_G
    })
  })

  it('is refused an agent of its own org in ANOTHER set', async () => {
    const agentId = await setAgent(DEFAULT_ORG_ID, setH, 'theirs')
    expect(await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)).toMatchObject({
      granted: false
    })
  })

  it('is refused a pool agent — a group never reaches the pool', async () => {
    const poolSet = await seedPoolMember(prisma, POOL_MEMBER)
    const agentId = await setAgent(DEFAULT_ORG_ID, poolSet, 'cloudy')
    expect(await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)).toMatchObject({
      granted: false
    })
    // …and the pool member holds it, which is what makes the refusal a fence and not an outage.
    expect(await ledger().claimAgentHome(ORG_X, agentId, DaemonId(POOL_MEMBER), T0, LEASE_MS)).toMatchObject({
      granted: true,
      holder: POOL_MEMBER
    })
  })

  it('is refused a machine-placed agent, even one on a machine of its own org', async () => {
    const agentId = AgentId(randomUUID())
    await agents().create({
      id: agentId,
      orgId: ORG_X,
      name: 'pinned',
      runtime: 'claude',
      daemonId: DaemonId(PINNED)
    })
    expect(await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)).toMatchObject({
      granted: false
    })
  })

  it('is refused every agent of another organization, whatever its placement', async () => {
    const other = await otherOrg()
    const theirs = await setAgent(other.orgId, other.setId, 'theirs')
    expect(await ledger().claimAgentHome(OrgId(other.orgId), theirs, DaemonId(MEMBER_G), T0, LEASE_MS)).toMatchObject({
      granted: false
    })
    // Their own member holds it — the refusal is tenancy, not a broken set.
    expect(
      await ledger().claimAgentHome(OrgId(other.orgId), theirs, DaemonId(other.daemonId), T0, LEASE_MS)
    ).toMatchObject({ granted: true, holder: other.daemonId })
  })

  it('a pool member is refused every org-set agent — the pool does not absorb groups', async () => {
    await seedPoolMember(prisma, POOL_MEMBER)
    const agentId = await setAgent(DEFAULT_ORG_ID, setG, 'ours')
    expect(await ledger().claimAgentHome(ORG_X, agentId, DaemonId(POOL_MEMBER), T0, LEASE_MS)).toMatchObject({
      granted: false
    })
    expect(await ledger().claimVacant(DaemonId(POOL_MEMBER), 5, T0, LEASE_MS)).toEqual([])
  })

  it('re-grants a stopped member’s agents to another member of the same set', async () => {
    // The rollout property, for a local set: a member goes away, its lease lapses, and a peer
    // takes the group over with nothing sent to make it happen. A daemon is in at most one set,
    // so the peer here is the one that was in none.
    await sets().enroll(setG, DaemonId(PINNED))
    const agentId = await setAgent(DEFAULT_ORG_ID, setG, 'failover')
    await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)

    const afterLapse = new Date(T0.getTime() + LEASE_MS + 1)
    const taken = await ledger().claimVacant(DaemonId(PINNED), 5, afterLapse, LEASE_MS)
    expect(taken).toHaveLength(1)
    expect(taken[0]!.members).toEqual([{ kind: 'agent', refId: agentId }])
  })
})

describe('a set member is not a placement target (real Postgres)', () => {
  it('refuses pinning an agent to a machine that is in a set, on create and on move', async () => {
    await prisma.daemon.createMany({
      data: [MEMBER_G, PINNED].map((id) => ({ id, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' }))
    })
    const setG = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await sets().enroll(setG, DaemonId(MEMBER_G))

    // A member serves only what it holds a lease for, so a pinned agent there would be placed and
    // unservable at once — the converse of the invariant that lets `mayHold` stay one rule.
    await expect(
      agents().create({
        id: AgentId(randomUUID()),
        orgId: ORG_X,
        name: 'pinned-to-member',
        runtime: 'claude',
        daemonId: DaemonId(MEMBER_G)
      })
    ).rejects.toBeInstanceOf(DaemonPlacementInSet)

    const agentId = AgentId(randomUUID())
    await agents().create({ id: agentId, orgId: ORG_X, name: 'movable', runtime: 'claude', daemonId: DaemonId(PINNED) })
    await expect(agents().setPlacement(agentId, onDaemon(DaemonId(MEMBER_G)))).rejects.toBeInstanceOf(
      DaemonPlacementInSet
    )
    // The set itself is a legal target for the same agent — the refusal is about the machine.
    await agents().setPlacement(agentId, onSet(setG))
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      placementKind: 'set',
      setId: setG,
      daemonId: null
    })
  })
})

describe('org set lifecycle (real Postgres)', () => {
  it('lists, renames, and deletes only within the owning org, and never the pool', async () => {
    const repo = sets()
    const created = await repo.createForOrg(DEFAULT_ORG_ID, 'group-g')
    const other = await otherOrg()

    expect(await repo.listForOrg(DEFAULT_ORG_ID)).toEqual([{ id: created.id, orgId: DEFAULT_ORG_ID, name: 'group-g' }])
    expect(await repo.renameForOrg(other.orgId, created.id, 'stolen')).toBeNull()
    expect(await repo.renameForOrg(DEFAULT_ORG_ID, created.id, 'group-g2')).toMatchObject({ name: 'group-g2' })
    expect(await repo.deleteForOrg(other.orgId, created.id)).toBe(false)
    expect(await repo.deleteForOrg(DEFAULT_ORG_ID, created.id)).toBe(true)
  })

  it('refuses to delete a set that still has members or placed agents', async () => {
    const repo = sets()
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await repo.createForOrg(DEFAULT_ORG_ID, 'group-g')).id

    await repo.enroll(setId, DaemonId(MEMBER_G))
    await expect(repo.deleteForOrg(DEFAULT_ORG_ID, setId)).rejects.toBeInstanceOf(MemberSetInUse)

    await repo.withdraw(DaemonId(MEMBER_G), T0)
    await setAgent(DEFAULT_ORG_ID, setId, 'still-placed')
    // `Agent.setId` is SetNull, so deleting here would silently unplace the agent instead.
    await expect(repo.deleteForOrg(DEFAULT_ORG_ID, setId)).rejects.toBeInstanceOf(MemberSetInUse)
  })

  it('announces the set whole, so `auth/ok` can name it', async () => {
    const repo = sets()
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await repo.createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await repo.enroll(setId, DaemonId(MEMBER_G))

    expect(await repo.setOf(DaemonId(MEMBER_G))).toEqual({ id: setId, orgId: DEFAULT_ORG_ID, name: 'group-g' })
    expect(await repo.setOf(DaemonId(POOL_MEMBER))).toBeNull()
  })

  it('answers no shared-store members for an org set — its machines may keep private stores', async () => {
    const repo = sets()
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await repo.createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await repo.enroll(setId, DaemonId(MEMBER_G))

    expect(await repo.memberIdsOf(setId)).toEqual([MEMBER_G])
    expect(await repo.sharedStoreMemberIdsOf(setId)).toEqual([])
  })
})

describe('the membership fences (real Postgres)', () => {
  it('serializes enrolment against a concurrent pin, so neither state can be half-committed', async () => {
    // The finding: both writers used to check and commit in separate transactions, so a placement
    // reading "in no set" and an enrolment reading "no pinned agents" could both win — leaving a
    // set member with an agent pinned to it and no way to serve it.
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    const agentId = AgentId(randomUUID())

    const outcomes = await Promise.allSettled([
      sets().enrollOperator(setId, DaemonId(MEMBER_G)),
      agents().create({
        id: agentId,
        orgId: ORG_X,
        name: 'racer',
        runtime: 'claude',
        daemonId: DaemonId(MEMBER_G)
      })
    ])
    // Exactly one wins — and whichever it is, the forbidden pair never exists.
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const enrolled = (await sets().setIdOf(DaemonId(MEMBER_G))) !== null
    const pinned = await prisma.agent.count({ where: { daemonId: MEMBER_G } })
    expect(enrolled && pinned > 0).toBe(false)
  })

  it('never answers success for the loser of two concurrent enrolments into different sets', async () => {
    // The insert is idempotent, so without a membership re-read under the lock the loser would
    // no-op and still return 200 naming a set the daemon never joined.
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const a = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-a')).id
    const b = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-b')).id

    const outcomes = await Promise.allSettled([
      sets().enrollOperator(a, DaemonId(MEMBER_G)),
      sets().enrollOperator(b, DaemonId(MEMBER_G))
    ])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const loser = outcomes.find((o) => o.status === 'rejected')
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyInSet)
    // And the winner is the one the surviving row actually names.
    const winner = outcomes[0]!.status === 'fulfilled' ? a : b
    expect(await sets().setIdOf(DaemonId(MEMBER_G))).toBe(winner)
  })

  it('is idempotent for the set the daemon is already in', async () => {
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await sets().enrollOperator(setId, DaemonId(MEMBER_G))
    await sets().enrollOperator(setId, DaemonId(MEMBER_G))
    expect(await sets().memberIdsOf(setId)).toEqual([MEMBER_G])
  })

  it('refuses withdrawal for a lease claimed concurrently, never committing over a live holder', async () => {
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await sets().enroll(setId, DaemonId(MEMBER_G))
    const agentId = await setAgent(DEFAULT_ORG_ID, setId, 'contended')

    const [claim, withdrawal] = await Promise.allSettled([
      ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS),
      sets().withdraw(DaemonId(MEMBER_G), T0)
    ])
    // Either the claim lost (no lease, withdrawal committed) or it won and the withdrawal was
    // refused — never "granted a live lease AND no longer a member".
    const granted = claim.status === 'fulfilled' && claim.value.granted
    const stillMember = (await sets().setIdOf(DaemonId(MEMBER_G))) !== null
    expect(granted && !stillMember).toBe(false)
    if (granted) expect(withdrawal.status).toBe('rejected')
  })

  it('refuses to delete a set a placement is landing on, rather than silently unplacing it', async () => {
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    const agentId = AgentId(randomUUID())

    const [placement, deletion] = await Promise.allSettled([
      agents().create({ id: agentId, orgId: ORG_X, name: 'landing', runtime: 'claude', placementKind: 'set', setId }),
      sets().deleteForOrg(DEFAULT_ORG_ID, setId)
    ])
    // `Agent.setId` is SetNull, so a delete that raced past the count would leave the agent
    // unplaced with no trace. The set survives whenever the placement did.
    const placed = placement.status === 'fulfilled'
    const deleted = deletion.status === 'fulfilled' && deletion.value === true
    expect(placed && deleted).toBe(false)
    if (placed) {
      expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({ setId })
    }
  })

  it('refuses enrolment while agents are pinned, and takes it once they are re-placed', async () => {
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    const agentId = AgentId(randomUUID())
    await agents().create({
      id: agentId,
      orgId: ORG_X,
      name: 'pinned',
      runtime: 'claude',
      daemonId: DaemonId(MEMBER_G)
    })

    await expect(sets().enrollOperator(setId, DaemonId(MEMBER_G))).rejects.toBeInstanceOf(DaemonHasPlacedAgents)
    await agents().setPlacement(agentId, onSet(setId))
    await sets().enrollOperator(setId, DaemonId(MEMBER_G))
    expect(await sets().setIdOf(DaemonId(MEMBER_G))).toBe(setId)
  })

  it('a renewal cannot revive a lapsed lease across a withdrawal', async () => {
    // Renewal carries no expiry predicate — it revives every row this holder still names — so it
    // is a lease-CREATING write as far as withdrawal is concerned. Both take the daemon fence, and
    // the commit vacates what is left, so a beat landing either side cannot resurrect the holding.
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await sets().enroll(setId, DaemonId(MEMBER_G))
    const agentId = await setAgent(DEFAULT_ORG_ID, setId, 'lapsing')
    await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)

    const afterLapse = new Date(T0.getTime() + LEASE_MS + 1)
    const [withdrawal] = await Promise.allSettled([
      sets().withdraw(DaemonId(MEMBER_G), afterLapse),
      ledger().renewHeld(DaemonId(MEMBER_G), afterLapse, LEASE_MS)
    ])
    // Whichever order they took, the forbidden pair — a live lease held by a non-member — is out.
    const stillMember = (await sets().setIdOf(DaemonId(MEMBER_G))) !== null
    const stillLive = (await ledger().listHeldBy(DaemonId(MEMBER_G))).filter(
      (g) => g.expiresAt !== null && g.expiresAt > afterLapse
    )
    expect(stillMember || stillLive.length === 0).toBe(true)
    if (withdrawal.status === 'fulfilled') expect(stillLive).toEqual([])
  })

  it('refuses withdrawal while a live lease is held, and takes it once the lease lapses', async () => {
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    await sets().enroll(setId, DaemonId(MEMBER_G))
    const agentId = await setAgent(DEFAULT_ORG_ID, setId, 'held')
    await ledger().claimAgentHome(ORG_X, agentId, DaemonId(MEMBER_G), T0, LEASE_MS)

    await expect(sets().withdraw(DaemonId(MEMBER_G), T0)).rejects.toBeInstanceOf(DaemonHoldsDuty)
    // A lapsed lease is strictly later than the member's own self-fence: it has stopped serving.
    await sets().withdraw(DaemonId(MEMBER_G), new Date(T0.getTime() + LEASE_MS + 1))
    expect(await sets().setIdOf(DaemonId(MEMBER_G))).toBeNull()
  })
})

describe('enrolling a daemon that still has agents pinned to it (real Postgres)', () => {
  it('re-places them onto the set and writes the membership row in ONE transaction', async () => {
    // §3: a pinned agent does not BLOCK the join, it comes with it. Either half alone is a state
    // the invariants forbid — a member with a pinned agent, or agents on a set with nothing in it.
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    const a1 = AgentId(randomUUID())
    const a2 = AgentId(randomUUID())
    for (const [id, name] of [
      [a1, 'pinned-1'],
      [a2, 'pinned-2']
    ] as const) {
      await agents().create({ id, orgId: ORG_X, name, runtime: 'claude', daemonId: DaemonId(MEMBER_G) })
    }

    await sets().enrollWithPlacedAgents(setId, DaemonId(MEMBER_G), [a1, a2])

    expect(await sets().setIdOf(DaemonId(MEMBER_G))).toBe(setId)
    for (const id of [a1, a2]) {
      expect(await prisma.agent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        placementKind: 'set',
        setId,
        daemonId: null
      })
    }
    // And the machine can now hold their duty, which is the point of the whole transition.
    const claim = await ledger().claimAgentHome(ORG_X, a1, DaemonId(MEMBER_G), T0, LEASE_MS)
    expect(claim).toMatchObject({ granted: true, holder: MEMBER_G })
  })

  it('refuses when an agent was pinned mid-transition rather than leaving it unservable', async () => {
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const setId = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    const named = AgentId(randomUUID())
    const unnamed = AgentId(randomUUID())
    await agents().create({ id: named, orgId: ORG_X, name: 'named', runtime: 'claude', daemonId: DaemonId(MEMBER_G) })
    await agents().create({ id: unnamed, orgId: ORG_X, name: 'late', runtime: 'claude', daemonId: DaemonId(MEMBER_G) })

    // The caller only knew about one; the other would be placed and unservable the moment the
    // membership row landed, so nothing commits.
    await expect(sets().enrollWithPlacedAgents(setId, DaemonId(MEMBER_G), [named])).rejects.toBeInstanceOf(
      DaemonHasPlacedAgents
    )
    expect(await sets().setIdOf(DaemonId(MEMBER_G))).toBeNull()
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: named } })).toMatchObject({ placementKind: 'daemon' })
  })

  it('is idempotent for a daemon already in the set, and refuses one in another', async () => {
    await prisma.daemon.create({ data: { id: MEMBER_G, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    const g = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-g')).id
    const h = (await sets().createForOrg(DEFAULT_ORG_ID, 'group-h')).id
    await sets().enrollWithPlacedAgents(g, DaemonId(MEMBER_G), [])
    await sets().enrollWithPlacedAgents(g, DaemonId(MEMBER_G), [])
    expect(await sets().memberIdsOf(g)).toEqual([MEMBER_G])
    await expect(sets().enrollWithPlacedAgents(h, DaemonId(MEMBER_G), [])).rejects.toBeInstanceOf(DaemonAlreadyInSet)
  })
})
