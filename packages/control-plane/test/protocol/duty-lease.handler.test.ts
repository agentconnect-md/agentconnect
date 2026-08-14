// The duty lease exchange over the WS edge (frames/duty.ts): a heartbeat's
// `duties` field renews held groups and is answered — only when there is
// something to say — with duty/grant and duty/revoke EVTs; duty/release
// vacates explicitly. A heartbeat without `duties` keeps the path dormant.
import { describe, it, expect, vi } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { PgDutyGroupRepo } from '../../src/persistence/index.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER = 'd2222222-2222-4222-8222-222222222222'
const GROUP = '00000000-0000-4000-8000-000000000001'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AGENT2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const GROUP2 = '00000000-0000-4000-8000-000000000002'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const REG_ID = '88888888-8888-4888-8888-888888888888'
const REL_ID = '77777777-7777-4777-8777-777777777777'

const LEASE_MS = 120_000

async function seedGroup(opts: { holder?: string; term?: bigint; expiresAt?: Date | null } = {}): Promise<void> {
  await prisma.dutyGroup.create({
    data: {
      id: GROUP,
      orgId: DEFAULT_ORG_ID,
      holder: opts.holder ?? null,
      term: opts.term ?? 0n,
      expiresAt: opts.expiresAt ?? null
    }
  })
  await prisma.dutyGroupMember.create({
    data: { kind: 'agent', refId: AGENT, groupId: GROUP, orgId: DEFAULT_ORG_ID }
  })
}

async function ready(h: ReturnType<typeof buildWsHarness>, opts: { orgScoped?: boolean } = {}) {
  const { conn, stub } = h.connect()
  if (opts.orgScoped) {
    const token = await h.mintToken(DAEMON)
    stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  } else {
    const saToken = await h.mintCloudDaemon(DAEMON)
    stub.inject('auth', { serviceAccountToken: saToken, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  }
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'member-1',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
      maxAgents: 8,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    },
    { id: REG_ID }
  )
  await stub.expectFrame('register/ok')
  return { conn, stub }
}

function heartbeat(duties?: { held: { groupId: string; term: string }[]; headroom: number }) {
  return {
    load: { cpu: 0.1, mem: 0.1, agents: 0 },
    health: 'ok',
    activeSessions: 0,
    ...(duties ? { duties } : {})
  }
}

describe('duty lease exchange (protocol level, real Postgres)', () => {
  it('a heartbeat without duties stays dormant — no duty frames', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat())
    stub.inject('heartbeat', heartbeat()) // second beat: the first has fully dispatched by now
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type.startsWith('duty/'))).toEqual([])
  })

  it('headroom claims a vacant group and the grant EVT carries org, term, members', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toEqual([
      { groupId: GROUP, orgId: DEFAULT_ORG_ID, term: '1', members: [{ kind: 'agent', refId: AGENT }] }
    ])

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBe(DAEMON)
    expect(row.term).toBe(1n)
  })

  it('zero headroom claims nothing', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
  })

  it('within the recovery grace no vacancy grant flows; after it, grants resume', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma, { dutyLease: { recoveryGraceMs: 60_000 } })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])

    h.clock.advance(60_001)
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    await stub.expectFrame('duty/grant')
  })

  it('renewal is the heartbeat: the held digest refreshes expiresAt without a term bump', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + 5_000) })
    const { stub } = await ready(h)

    h.clock.advance(1_000)
    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    await new Promise((r) => setTimeout(r, 25))

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.term).toBe(1n)
    expect(row.expiresAt).toEqual(new Date(h.clock.now() + LEASE_MS))
    // Nothing to grant and nothing to revoke — only the confirmation that the renewal happened,
    // which is what the member anchors its self-fence on.
    expect(stub.sent.filter((f) => f.type.startsWith('duty/')).map((f) => f.type)).toEqual(['duty/renewed'])
  })

  it('every processed duty beat is answered with the renewal horizon it just wrote', async () => {
    const h = buildWsHarness(prisma, { dutyLease: { leaseMs: 90_000 } })
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + 5_000) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const renewed = await stub.expectFrame('duty/renewed')
    if (!isFrame('duty/renewed')(renewed)) throw new Error('expected duty/renewed')
    // Relative, never a timestamp: the member measures from receipt on its own clock.
    expect(renewed.payload).toEqual({ leaseMs: 90_000 })
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.expiresAt).toEqual(new Date(h.clock.now() + 90_000))
  })

  it('the renewal confirmation comes LAST, after the revocation it must never outrun', async () => {
    // The member's fence is global while renewal is per-group, so a delivered PREFIX of this
    // exchange must not extend the countdown without the revocation that makes it safe. Here
    // `renewHeld` renews nothing the member reported — the group belongs to OTHER now — and one
    // socket delivers in order, so a confirmation implies the supersession arrived first.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: OTHER, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    await stub.expectFrame('duty/renewed')

    expect(stub.sent.filter((f) => f.type.startsWith('duty/')).map((f) => f.type)).toEqual([
      'duty/revoke',
      'duty/renewed'
    ])
  })

  it('a digest entry the ledger granted elsewhere is revoked as superseded', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: OTHER, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const revoke = await stub.expectFrame('duty/revoke')
    if (!isFrame('duty/revoke')(revoke)) throw new Error('expected duty/revoke')
    expect(revoke.payload.revocations).toEqual([{ groupId: GROUP, reason: 'superseded' }])
  })

  it('a digest entry whose group no longer exists is revoked as gone', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const revoke = await stub.expectFrame('duty/revoke')
    if (!isFrame('duty/revoke')(revoke)) throw new Error('expected duty/revoke')
    expect(revoke.payload.revocations).toEqual([{ groupId: GROUP, reason: 'gone' }])
  })

  it('a stale digest term is answered by re-issuing the grant at the current term', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 3n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '2' }], headroom: 0 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '3' })
  })

  it('a held group missing from the digest is re-granted (lost grant EVT recovery)', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '1' })
  })

  it('duty/release acks and vacates immediately, keeping the term', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('duty/release', { groupIds: [GROUP] }, { id: REL_ID })
    const ack = await stub.expectFrame('ack')
    expect(ack.corr).toBe(REL_ID)

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
    expect(row.expiresAt).toBeNull()
    expect(row.term).toBe(2n)

    // Immediately grantable by a survivor at a bumped term.
    const repo = new PgDutyGroupRepo(prisma)
    const grants = await repo.claimVacant(DaemonId(OTHER), 1, new Date(h.clock.now()), LEASE_MS)
    expect(grants[0]).toMatchObject({ groupId: GROUP, orgId: OrgId(DEFAULT_ORG_ID), term: 3n })
  })
})

describe('duty lease exchange — scope gate and allocation coherence', () => {
  it('an org-scoped daemon sending duties is ignored: no frames, no ledger writes', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, { orgScoped: true })

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type.startsWith('duty/'))).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
  })

  it('an org-scoped daemon calling duty/release gets SCOPE_DENIED and vacates nothing', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h, { orgScoped: true })

    stub.inject('duty/release', { groupIds: [GROUP] }, { id: REL_ID })
    const err = await stub.expectFrame('error')
    if (!isFrame('error')(err)) throw new Error('expected error')
    expect(err.corr).toBe(REL_ID)
    expect(err.payload.code).toBe('SCOPE_DENIED')
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBe(DAEMON)
  })

  it('missing-from-digest regrants are charged against headroom before fresh claims', async () => {
    // The ledger already holds GROUP for this member; a second group sits vacant.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    // Restart shape: empty digest, headroom 1 — the missing regrant consumes the slot.
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toHaveLength(1)
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '1' })
    const vacant = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP2 } })
    expect(vacant.holder).toBeNull()
  })

  it('a vacant digest group re-claimed in the same beat is granted, never also revoked', async () => {
    // The member believes it holds GROUP, but the lease lapsed (e.g. a long partition).
    const h = buildWsHarness(prisma)
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(h.clock.now() - 1) })
    // renewHeld would refresh a still-holder row; simulate a release-then-nobody state instead.
    await prisma.dutyGroup.update({ where: { id: GROUP }, data: { holder: null, expiresAt: null } })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 1 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toEqual([
      { groupId: GROUP, orgId: DEFAULT_ORG_ID, term: '2', members: [{ kind: 'agent', refId: AGENT }] }
    ])
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type === 'duty/revoke')).toEqual([])
  })
})

describe('duty lease exchange — wire safety', () => {
  it('reconnect regrants are chunked so no duty/grant frame exceeds the emission budget', async () => {
    const h = buildWsHarness(prisma, { dutyLease: { grantsPerFrame: 2 } })
    const start = new Date(h.clock.now())
    const horizon = new Date(start.getTime() + LEASE_MS)
    for (let i = 0; i < 3; i++) {
      const gid = `00000000-0000-4000-8000-00000000001${i}`
      await prisma.dutyGroup.create({
        data: { id: gid, orgId: DEFAULT_ORG_ID, holder: DAEMON, term: 1n, expiresAt: horizon }
      })
      await prisma.dutyGroupMember.create({
        data: { kind: 'agent', refId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa1${i}`, groupId: gid, orgId: DEFAULT_ORG_ID }
      })
    }
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 3 }))
    const first = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(first)) throw new Error('expected duty/grant')
    await vi.waitFor(() => {
      const frames = stub.sent.filter((f) => f.type === 'duty/grant')
      expect(frames).toHaveLength(2)
    })
    const sizes = stub.sent
      .filter((f) => f.type === 'duty/grant')
      .map((f) => (f.payload as { grants: unknown[] }).grants.length)
      .sort()
    expect(sizes).toEqual([1, 2])
  })

  it('an oversized vacancy is never claimed and never starves the valid one behind it', async () => {
    // 1001 members exceeds DutyGrantEntry.members.max — excluded at the claim
    // boundary. GROUP sorts BEFORE GROUP2, so without the size gate it would
    // consume the claim budget every beat.
    await prisma.dutyGroup.create({ data: { id: GROUP, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        kind: 'agent' as const,
        refId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        groupId: GROUP,
        orgId: DEFAULT_ORG_ID
      }))
    })
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toHaveLength(1)
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP2 })
    const oversized = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(oversized.holder).toBeNull()
    expect(oversized.term).toBe(0n)
  })

  it('an oversized lease the member does not serve vacates instead of renewing forever', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await prisma.dutyGroup.create({
      data: {
        id: GROUP,
        orgId: DEFAULT_ORG_ID,
        holder: DAEMON,
        term: 1n,
        expiresAt: new Date(start.getTime() + LEASE_MS)
      }
    })
    await prisma.dutyGroupMember.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        kind: 'agent' as const,
        refId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        groupId: GROUP,
        orgId: DEFAULT_ORG_ID
      }))
    })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    await new Promise((r) => setTimeout(r, 100))
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
    expect(row.expiresAt).toBeNull()
    expect(row.term).toBe(1n)
  })

  it('a held group grown past the cap at a stale term is superseded and vacated, not renewed', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await prisma.dutyGroup.create({
      data: {
        id: GROUP,
        orgId: DEFAULT_ORG_ID,
        holder: DAEMON,
        term: 2n,
        expiresAt: new Date(start.getTime() + LEASE_MS)
      }
    })
    await prisma.dutyGroupMember.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        kind: 'agent' as const,
        refId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        groupId: GROUP,
        orgId: DEFAULT_ORG_ID
      }))
    })
    const { stub } = await ready(h)

    // The daemon still serves the pre-growth composition at term 1.
    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const revoke = await stub.expectFrame('duty/revoke')
    if (!isFrame('duty/revoke')(revoke)) throw new Error('expected duty/revoke')
    expect(revoke.payload.revocations).toEqual([{ groupId: GROUP, reason: 'superseded' }])
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
    expect(row.expiresAt).toBeNull()
  })

  it('an overlapping beat cannot double-spend headroom (single-flight per daemon)', async () => {
    // Two vacant groups, headroom 1: back-to-back beats dispatched without
    // awaiting must yield at most one grant — the second beat is dropped.
    await seedGroup()
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    await stub.expectFrame('duty/grant')
    await new Promise((r) => setTimeout(r, 50))

    const grantedTotal = stub.sent
      .filter((f) => f.type === 'duty/grant')
      .reduce((n, f) => n + (f.payload as { grants: unknown[] }).grants.length, 0)
    expect(grantedTotal).toBe(1)
    const holders = await prisma.dutyGroup.findMany({ where: { holder: DAEMON } })
    expect(holders).toHaveLength(1)
  })
})

describe('duty lease exchange — drain barrier', () => {
  it('a release behind a granting beat queues: the grant reaches the wire before the ack', async () => {
    // The daemon holds GROUP; a beat that grants GROUP2 is immediately followed
    // by its drain's duty/release for GROUP. Lane order is frame order (the
    // lane is reserved synchronously at dispatch), so this is deterministic:
    // the exchange's grant is emitted BEFORE the release's ack, GROUP is
    // vacated, and GROUP2 is coherently held — never a grant after the ack.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 1 }))
    stub.inject('duty/release', { groupIds: [GROUP] }, { id: REL_ID })
    const ack = await stub.expectFrame('ack')
    expect(ack.corr).toBe(REL_ID)

    const grantIdx = stub.sent.findIndex((f) => f.type === 'duty/grant')
    const ackIdx = stub.sent.findIndex((f) => f.type === 'ack')
    expect(grantIdx).toBeGreaterThanOrEqual(0)
    expect(grantIdx).toBeLessThan(ackIdx)

    const released = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(released.holder).toBeNull()
    const granted = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP2 } })
    expect(granted.holder).toBe(DAEMON)
  })
})

describe('duty/claim — the activation rendezvous (real Postgres)', () => {
  const CLAIM_ID = '66666666-6666-4666-8666-666666666666'

  async function seedAgentRow(): Promise<void> {
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'agent-1', runtime: 'claude' }
    })
  }

  it('an unheld agent is claimed on the spot and the grant comes back installable', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const ok = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(ok)) throw new Error('expected duty/claim/ok')
    expect(ok.corr).toBe(CLAIM_ID)
    expect(ok.payload.granted).toBe(true)
    expect(ok.payload.grant).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      term: '1',
      members: [{ kind: 'agent', refId: AGENT }]
    })

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: ok.payload.grant!.groupId } })
    expect(row.holder).toBe(DAEMON)
  })

  it('a claim lost to a live incumbent names the winner instead', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await prisma.dutyGroup.create({
      data: {
        id: GROUP,
        orgId: DEFAULT_ORG_ID,
        holder: OTHER,
        term: 4n,
        expiresAt: new Date(start.getTime() + LEASE_MS)
      }
    })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT, groupId: GROUP, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const ok = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(ok)) throw new Error('expected duty/claim/ok')
    expect(ok.payload).toEqual({ granted: false, holder: OTHER })
  })

  it('re-claiming what this member already holds is idempotent — no term churn', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const first = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(first)) throw new Error('expected duty/claim/ok')
    const groupId = first.payload.grant!.groupId

    stub.inject('duty/claim', { agentId: AGENT }, { id: REL_ID })
    const second = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(second)) throw new Error('expected duty/claim/ok')
    expect(second.payload.granted).toBe(true)
    expect(second.payload.grant).toMatchObject({ groupId, term: '1' })
  })

  it('an unknown agent is refused without naming anyone', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const ok = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(ok)) throw new Error('expected duty/claim/ok')
    expect(ok.payload).toEqual({ granted: false })
  })

  it('an org-scoped connection cannot claim at all', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, { orgScoped: true })

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const err = await stub.expectFrame('error')
    if (!isFrame('error')(err)) throw new Error('expected error')
    expect(err.payload.code).toBe('SCOPE_DENIED')
    expect(await prisma.dutyGroup.count()).toBe(0)
  })
})
