import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { PgCapabilityRequestRepo } from '../../src/persistence/repositories/capability-request.repo.js'
import type { CapabilitySettlement, NewCapabilityOrigin } from '../../src/persistence/ports.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = AgentId('22222222-2222-4222-8222-222222222222')
const ORG_ID = OrgId(DEFAULT_ORG_ID)
const NOW = new Date('2026-10-20T00:00:00.000Z')

const origin = (sessionId: string): NewCapabilityOrigin => ({
  sessionId,
  sessionKey: `slack:C1:${sessionId}`,
  platform: 'slack',
  placeLabel: '#bugs',
  external: false,
  askers: {
    people: [{ kind: 'member', platform: 'slack', integrationId: 'i-1', userId: `U-${sessionId}` }],
    nobody: false
  }
})

const create = (repo: PgCapabilityRequestRepo, id = randomUUID(), sessionId = 's1') =>
  repo.create({
    id,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    kind: 'mcp-server',
    target: 'Linear',
    want: { server: 'Linear' },
    summary: 'add the MCP server "Linear"',
    reason: 'filing the bug needs Linear',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
    origin: origin(sessionId)
  })

const declined = (at: Date): CapabilitySettlement => ({
  status: 'declined',
  outcome: null,
  differs: false,
  note: 'not now',
  settledBy: { kind: 'console', userId: 'u-ben', name: 'Ben' },
  settledRevision: null,
  at
})

describe('PgCapabilityRequestRepo', () => {
  beforeEach(async () => {
    await seedDaemon(prisma, DAEMON_ID)
    await seedAgent(prisma, AGENT_ID, { daemonId: DAEMON_ID })
  })

  it('keeps one open request per key and lets other conversations join it', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const first = await create(repo)
    expect(first).toMatchObject({ status: 'open', generation: 1, origins: [{ sessionId: 's1', wakeState: 'none' }] })
    // The partial unique index refuses a second open row for the same key.
    await expect(create(repo, randomUUID(), 's2')).resolves.toBeNull()
    await expect(repo.addOrigin(first!.id, origin('s2'), NOW)).resolves.toBe(true)
    await expect(repo.addOrigin(first!.id, origin('s2'), NOW)).resolves.toBe(true)
    const open = await repo.open(AGENT_ID, 'mcp-server', 'Linear')
    expect(open?.origins.map((o) => [o.sessionId, o.askers.people[0]])).toEqual([
      ['s1', expect.objectContaining({ userId: 'U-s1' })],
      ['s2', expect.objectContaining({ userId: 'U-s2' })]
    ])
    await expect(repo.openForSession('s2')).resolves.toBe(1)
  })

  it('makes a join wait for a settlement in flight, so it never joins a request no wake will reach', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const row = (await create(repo))!
    let joined: Promise<boolean> | undefined
    await prisma.$transaction(async (tx) => {
      // The settling transaction holds the row; the join must wait for it, then see it settled.
      await tx.capabilityRequest.updateMany({ where: { id: row.id, status: 'open' }, data: { status: 'declined' } })
      joined = repo.addOrigin(row.id, origin('s2'), NOW)
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    await expect(joined!).resolves.toBe(false)
    expect((await repo.get(ORG_ID, row.id))!.origins.map((o) => o.sessionId)).toEqual(['s1'])
  })

  it('records an applied change per daemon, only for completions at or below the acknowledged revision', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const low = (await create(repo))!
    await repo.settle(low.id, 1, { ...declined(NOW), status: 'completed', note: null, settledRevision: 2n })
    await expect(repo.markChangeApplied(DAEMON_ID, [AGENT_ID], 1n, NOW)).resolves.toBe(0)
    await expect(repo.markChangeApplied(DAEMON_ID, [AGENT_ID], 2n, NOW)).resolves.toBe(1)
    await expect(repo.markChangeApplied(DAEMON_ID, [AGENT_ID], 2n, NOW)).resolves.toBe(0)
    // Another daemon's acknowledgement is recorded beside it, never in its place.
    await expect(repo.markChangeApplied('other-daemon', [AGENT_ID], null, NOW)).resolves.toBe(1)
    expect((await repo.get(ORG_ID, low.id))!.appliedBy).toEqual({
      [DAEMON_ID]: NOW.toISOString(),
      'other-daemon': NOW.toISOString()
    })
  })

  it('settles by compare-and-set on status and generation, making every wake pending', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const row = (await create(repo))!
    await repo.addOrigin(row.id, origin('s2'), NOW)
    await expect(repo.settle(row.id, 2, declined(NOW))).resolves.toBe(false)
    await expect(repo.settle(row.id, 1, declined(NOW))).resolves.toBe(true)
    await expect(repo.settle(row.id, 1, declined(NOW))).resolves.toBe(false)
    const settled = await repo.get(ORG_ID, row.id)
    expect(settled).toMatchObject({ status: 'declined', note: 'not now', settledBy: { name: 'Ben' } })
    expect(settled!.origins.map((o) => [o.wakeState, o.wakeGeneration])).toEqual([
      ['pending', 1],
      ['pending', 1]
    ])
    await expect(
      repo.declinedSince(AGENT_ID, 'mcp-server', 'Linear', new Date(NOW.getTime() - 1))
    ).resolves.toMatchObject({ id: row.id })
    // A new open request may take the key once the old one settled.
    await expect(create(repo, randomUUID(), 's3')).resolves.not.toBeNull()
    // …and then the declined one cannot be reopened onto it.
    await expect(repo.reopen(row.id, 1, NOW, NOW)).resolves.toBeNull()
  })

  it('claims a due wake once and finishes it only for its generation', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const row = (await create(repo))!
    await repo.settle(row.id, 1, declined(NOW))
    const owner = randomUUID()
    const until = new Date(NOW.getTime() + 60_000)
    const claimed = await repo.claimWake(owner, NOW, until)
    expect(claimed).toMatchObject({ request: { id: row.id }, origin: { sessionId: 's1', wakeGeneration: 1 } })
    await expect(repo.claimWake(randomUUID(), NOW, until)).resolves.toBeNull()
    await repo.finishWake(row.id, 's1', owner, 1, { state: 'delivered', reason: null, dueAt: null, attempts: 1 })
    expect((await repo.get(ORG_ID, row.id))!.origins[0]).toMatchObject({ wakeState: 'delivered', wakeAttempts: 1 })
  })

  it('reopens a declined request with the next generation and resets its wakes', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const row = (await create(repo))!
    await repo.settle(row.id, 1, declined(NOW))
    const reopened = await repo.reopen(row.id, 1, NOW, new Date(NOW.getTime() + 1000))
    expect(reopened).toMatchObject({ status: 'open', generation: 2, note: null, settledBy: null })
    expect(reopened!.origins[0]).toMatchObject({ wakeState: 'none', wakeGeneration: 2 })
    await expect(repo.reopen(row.id, 1, NOW, NOW)).resolves.toBeNull()
  })

  it('withdraws one origin, then the request', async () => {
    const repo = new PgCapabilityRequestRepo(prisma)
    const row = (await create(repo))!
    await repo.addOrigin(row.id, origin('s2'), NOW)
    await expect(repo.withdrawOrigin(row.id, 's9', NOW)).resolves.toBeNull()
    await expect(repo.withdrawOrigin(row.id, 's1', NOW)).resolves.toBe('left')
    await expect(repo.withdrawOrigin(row.id, 's2', NOW)).resolves.toBe('withdrawn')
    expect((await repo.get(ORG_ID, row.id))!.status).toBe('withdrawn')
    await expect(repo.expired(new Date(NOW.getTime() + 8 * 86_400_000), 10)).resolves.toEqual([])
  })
})
