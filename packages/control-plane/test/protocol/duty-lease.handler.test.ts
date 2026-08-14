// The duty lease exchange over the WS edge (frames/duty.ts): a heartbeat's
// `duties` field renews held groups and is answered — only when there is
// something to say — with duty/grant and duty/revoke EVTs; duty/release
// vacates explicitly. A heartbeat without `duties` keeps the path dormant.
import { describe, it, expect } from 'vitest'
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

async function ready(h: ReturnType<typeof buildWsHarness>) {
  const token = await h.mintToken(DAEMON)
  const { conn, stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
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
    expect(stub.sent.filter((f) => f.type.startsWith('duty/'))).toEqual([])
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
