/**
 * Member sets — the write-time invariants that let the read path be one membership lookup
 * (docs/designs/daemon-groups.md §2/§3), plus the eligibility parity the fold rests on.
 *
 * Everything tenancy-shaped is enforced HERE, where the row is written. If any of these three
 * rejections stops working, `mayHold`'s single rule silently widens: an org-scoped daemon could
 * be enrolled in the pool and reach every organization's agents, or an agent could be pointed at
 * another org's set and be claimed by that org's members.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PgMemberSetRepo } from '../../src/persistence/repositories/member-set.repo.js'
import { AgentSetPlacementDenied, MemberSetTenancyMismatch } from '../../src/persistence/errors.js'
import { onSet, onDaemon } from '../../src/domain/placement.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const POOL_MEMBER = 'd1111111-1111-4111-8111-111111111111'
const LOCAL_DAEMON = 'd2222222-2222-4222-8222-222222222222'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const T0 = new Date('2026-01-01T00:00:00Z')
const LEASE_MS = 120_000

/** A second org with a set of its own — the shape PR 2 creates and PR 1 must already refuse to mix. */
async function otherOrgSet(): Promise<{ orgId: string; setId: string }> {
  const org = await prisma.org.create({ data: { slug: `member-set-other-${randomUUID().slice(0, 8)}` } })
  const set = await prisma.memberSet.create({ data: { id: randomUUID(), orgId: org.id, name: 'other-group' } })
  return { orgId: org.id, setId: set.id }
}

describe('member_set_member — the tenancy invariant on membership (real Postgres)', () => {
  beforeEach(async () => {
    await prisma.daemon.createMany({
      data: [
        { id: POOL_MEMBER, orgId: null, maxAgents: 8, status: 'ready' },
        { id: LOCAL_DAEMON, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' }
      ]
    })
  })

  it('refuses an org-scoped daemon in the org-less set — the pool never absorbs a local machine', async () => {
    const repo = new PgMemberSetRepo(prisma)
    await expect(repo.enroll(await poolSetId(prisma), DaemonId(LOCAL_DAEMON))).rejects.toBeInstanceOf(
      MemberSetTenancyMismatch
    )
    expect(await prisma.memberSetMember.count()).toBe(0)
  })

  it('refuses an org-less daemon in an org set — a group never reaches the pool', async () => {
    const repo = new PgMemberSetRepo(prisma)
    const { setId } = await otherOrgSet()
    await expect(repo.enroll(setId, DaemonId(POOL_MEMBER))).rejects.toBeInstanceOf(MemberSetTenancyMismatch)
    expect(await prisma.memberSetMember.count()).toBe(0)
  })

  it('accepts matching tenancy and is idempotent, because re-auth re-enrolls the same member', async () => {
    const repo = new PgMemberSetRepo(prisma)
    const setId = await poolSetId(prisma)
    await repo.enroll(setId, DaemonId(POOL_MEMBER))
    await repo.enroll(setId, DaemonId(POOL_MEMBER))
    expect(await repo.memberIdsOf(setId)).toEqual([POOL_MEMBER])
    expect(await repo.setIdOf(DaemonId(POOL_MEMBER))).toBe(setId)
    expect(await repo.setIdOf(DaemonId(LOCAL_DAEMON))).toBeNull()
  })

  it('enrolls an org-less row in the pool on auth, and never an org-scoped one', async () => {
    const daemons = new PgDaemonRepo(prisma)
    const sets = new PgMemberSetRepo(prisma)
    await daemons.upsertOnAuth({ daemonId: DaemonId(POOL_MEMBER), orgId: null, agentVersion: '1.0.0' })
    await daemons.upsertOnAuth({ daemonId: DaemonId(LOCAL_DAEMON), orgId: ORG, agentVersion: '1.0.0' })

    expect(await sets.setIdOf(DaemonId(POOL_MEMBER))).toBe(await poolSetId(prisma))
    expect(await sets.setIdOf(DaemonId(LOCAL_DAEMON))).toBeNull()
  })

  it('drops the membership with the daemon row a reaper retires', async () => {
    const setId = await joinPool(prisma, POOL_MEMBER)
    await prisma.daemon.delete({ where: { id: POOL_MEMBER } })
    expect(await new PgMemberSetRepo(prisma).memberIdsOf(setId)).toEqual([])
  })
})

describe('agent placement — the set an agent may reference (real Postgres)', () => {
  it('refuses a create pointed at another org’s set', async () => {
    const { setId } = await otherOrgSet()
    await expect(
      new PgAgentRepo(prisma).create({
        id: AgentId(AGENT),
        orgId: ORG,
        name: 'cross-org',
        runtime: 'claude',
        placementKind: 'set',
        setId
      })
    ).rejects.toBeInstanceOf(AgentSetPlacementDenied)
    expect(await prisma.agent.count()).toBe(0)
  })

  it('refuses a move onto another org’s set, and takes the org-less one', async () => {
    const repo = new PgAgentRepo(prisma)
    const { setId } = await otherOrgSet()
    await prisma.daemon.create({ data: { id: LOCAL_DAEMON, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' } })
    await repo.create({
      id: AgentId(AGENT),
      orgId: ORG,
      name: 'movable',
      runtime: 'claude',
      daemonId: DaemonId(LOCAL_DAEMON)
    })

    await expect(repo.setPlacement(AgentId(AGENT), onSet(setId))).rejects.toBeInstanceOf(AgentSetPlacementDenied)
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })).toMatchObject({
      placementKind: 'daemon',
      daemonId: LOCAL_DAEMON
    })

    // The org-less set is the one every org may reference — that is what "cross-org" means.
    const pool = await poolSetId(prisma)
    await repo.setPlacement(AgentId(AGENT), onSet(pool))
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })).toMatchObject({
      placementKind: 'set',
      setId: pool,
      daemonId: null
    })
  })

  it('fences the compare-and-set move onto another org’s set too', async () => {
    const repo = new PgAgentRepo(prisma)
    const { setId } = await otherOrgSet()
    const pool = await poolSetId(prisma)
    await repo.create({
      id: AgentId(AGENT),
      orgId: ORG,
      name: 'cas',
      runtime: 'claude',
      placementKind: 'set',
      setId: pool
    })
    await expect(repo.movePlacement(AgentId(AGENT), onSet(pool), onSet(setId))).rejects.toBeInstanceOf(
      AgentSetPlacementDenied
    )
  })
})

describe('the fold is behaviour-preserving: a pool agent’s claimants (real Postgres)', () => {
  it('is claimable by the pool’s members and by nobody else', async () => {
    await prisma.daemon.createMany({
      data: [
        { id: POOL_MEMBER, orgId: null, maxAgents: 8, status: 'ready' },
        { id: LOCAL_DAEMON, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' }
      ]
    })
    const setId = await joinPool(prisma, POOL_MEMBER)
    const agents = new PgAgentRepo(prisma)
    await agents.create({
      id: AgentId(AGENT),
      orgId: ORG,
      name: 'pooled',
      runtime: 'claude',
      placementKind: 'set',
      setId
    })

    const ledger = new PgDutyGroupRepo(prisma)
    // A local daemon is not in the pool's set, so it may not claim what the pool serves…
    expect(await ledger.claimAgentHome(ORG, AgentId(AGENT), DaemonId(LOCAL_DAEMON), T0, LEASE_MS)).toMatchObject({
      granted: false
    })
    // …and a member of it may, which is the same pair of answers `placementKind = 'pool'` gave.
    expect(await ledger.claimAgentHome(ORG, AgentId(AGENT), DaemonId(POOL_MEMBER), T0, LEASE_MS)).toMatchObject({
      granted: true,
      holder: POOL_MEMBER
    })

    // Moving it onto the machine flips both answers, through the same one predicate.
    await agents.setPlacement(AgentId(AGENT), onDaemon(DaemonId(LOCAL_DAEMON)))
    expect(await ledger.vacateIneligible(ORG)).toHaveLength(1)
    expect(await ledger.claimVacant(DaemonId(POOL_MEMBER), 5, new Date(T0.getTime() + LEASE_MS + 1), LEASE_MS)).toEqual(
      []
    )
    expect(
      await ledger.claimVacant(DaemonId(LOCAL_DAEMON), 5, new Date(T0.getTime() + LEASE_MS + 1), LEASE_MS)
    ).toHaveLength(1)
  })
})
