import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { McpInvocationReaper } from '../../src/orchestrator/mcpInvocationReaper.js'
import { FakeClock } from '../fakes/fake-clock.js'

const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'
const AGENT = 'a1111111-1111-4111-8111-111111111111'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON = 'd2222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-07-30T00:00:00.000Z')

const at = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds)

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(settled).toBe(false)
}

async function expectDatabaseWait(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%webchat_mcp_delegation%'
      ) AS blocked
    `
    if (state?.blocked) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('expected a database operation to wait on the delegation row lock')
}

async function fixtures(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedDaemon(prisma, OTHER_DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.webchatConversation.create({
    data: {
      id: CONVERSATION,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      userId: DEFAULT_OWNER_ID
    }
  })
}

function establishInput(daemonId = DAEMON, expiresAt = at(60_000)) {
  return {
    conversationId: CONVERSATION,
    userId: DEFAULT_OWNER_ID,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(AGENT),
    daemonId: DaemonId(daemonId),
    now: NOW,
    expiresAt
  }
}

function revokeInput(delegation: { id: string; generation: number }) {
  return {
    delegationId: delegation.id,
    conversationId: CONVERSATION,
    generation: delegation.generation,
    userId: DEFAULT_OWNER_ID,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(AGENT),
    daemonId: DaemonId(DAEMON),
    revokedAt: at(5_000),
    reason: 'session_closed'
  }
}

describe('PgWebchatMcpDelegationRepo (real Postgres)', () => {
  it('serializes concurrent establishment so reconnects reuse one generation', async () => {
    await fixtures()
    const delegationMetric = vi.fn()
    const repo = new PgWebchatMcpDelegationRepo(prisma, { delegation: delegationMetric })

    const [left, right] = await Promise.all([repo.establish(establishInput()), repo.establish(establishInput())])

    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    expect(left).toMatchObject({ generation: 1, daemonId: DAEMON, revokedAt: null })
    expect(right).toMatchObject({ id: left?.id, generation: 1 })
    expect(await prisma.webchatMcpDelegation.count({ where: { conversationId: CONVERSATION } })).toBe(1)
    expect(
      await prisma.webchatConversation.findUnique({
        where: { id: CONVERSATION },
        select: { delegationGeneration: true }
      })
    ).toEqual({ delegationGeneration: 1 })
    expect(delegationMetric.mock.calls.map(([event]) => event).sort()).toEqual(['established', 'reused'])
  })

  it('atomically shortens a reusable delegation and never extends it again', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = (await repo.establish(establishInput(DAEMON, at(120_000))))!

    const shortened = (await repo.establish(establishInput(DAEMON, at(30_000))))!
    const laterCeiling = (await repo.establish(establishInput(DAEMON, at(90_000))))!

    expect(shortened).toMatchObject({
      id: first.id,
      generation: first.generation,
      expiresAt: at(30_000),
      revokedAt: null
    })
    expect(laterCeiling).toMatchObject({
      id: first.id,
      generation: first.generation,
      expiresAt: at(30_000),
      revokedAt: null
    })
    expect(await repo.get(first.id)).toMatchObject({
      generation: 1,
      expiresAt: at(30_000),
      revokedAt: null,
      revokedReason: null
    })
    expect(
      await prisma.webchatConversation.findUnique({
        where: { id: CONVERSATION },
        select: { delegationGeneration: true }
      })
    ).toEqual({ delegationGeneration: 1 })
  })

  it('concurrent reusable establishments converge durably on the earliest ceiling', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)

    const [later, earlier] = await Promise.all([
      repo.establish(establishInput(DAEMON, at(120_000))),
      repo.establish(establishInput(DAEMON, at(20_000)))
    ])

    expect(later).toMatchObject({ id: earlier?.id, generation: 1 })
    expect(await repo.get(later!.id)).toMatchObject({
      generation: 1,
      expiresAt: at(20_000),
      revokedAt: null
    })
    expect(await prisma.webchatMcpDelegation.count({ where: { conversationId: CONVERSATION } })).toBe(1)
  })

  it('rotates to a fresh generation after explicit revocation of the same authority', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = (await repo.establish(establishInput(DAEMON, at(120_000))))!

    expect(await repo.revoke(revokeInput(first))).toBe(true)
    const rotated = await repo.establish(establishInput(DAEMON, at(90_000)))

    expect(rotated).toMatchObject({
      conversationId: CONVERSATION,
      generation: first.generation + 1,
      revokedAt: null,
      expiresAt: at(90_000)
    })
    expect(rotated?.id).not.toBe(first.id)
    expect(await repo.get(first.id)).toMatchObject({
      generation: first.generation,
      revokedAt: at(5_000),
      revokedReason: 'session_closed'
    })
  })

  it('returns a delegation only when its generation is still current for the durable conversation', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = (await repo.establish(establishInput(DAEMON, at(120_000))))!
    expect(await repo.getCurrent(first.id)).toMatchObject({ id: first.id, generation: 1 })

    await repo.revoke(revokeInput(first))
    const rotated = (await repo.establish(establishInput(DAEMON, at(90_000))))!

    expect(await repo.get(first.id)).not.toBeNull()
    expect(await repo.getCurrent(first.id)).toBeNull()
    expect(await repo.getCurrent(rotated.id)).toMatchObject({ id: rotated.id, generation: 2 })
  })

  it('waits for a winning revocation, then rotates from the committed row', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const delegation = (await repo.establish(establishInput(DAEMON, at(120_000))))!
    const revoked = barrier()
    const releaseRevoke = barrier()
    const revoking = prisma.$transaction(
      async (tx) => {
        const result = await new PgWebchatMcpDelegationRepo(tx).revoke(revokeInput(delegation))
        revoked.release()
        await releaseRevoke.promise
        return result
      },
      { timeout: 20_000 }
    )
    await revoked.promise

    const establishing = repo.establish(establishInput(DAEMON, at(90_000)))
    await expectPending(establishing)
    releaseRevoke.release()

    expect(await revoking).toBe(true)
    const rotated = await establishing
    expect(rotated).toMatchObject({
      conversationId: CONVERSATION,
      generation: delegation.generation + 1,
      revokedAt: null,
      expiresAt: at(90_000)
    })
    expect(rotated?.id).not.toBe(delegation.id)
    expect(await repo.get(delegation.id)).toMatchObject({
      expiresAt: at(120_000),
      revokedAt: at(5_000)
    })
  })

  it('holds the latest delegation lock until a reusable establish commits', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const delegation = (await repo.establish(establishInput(DAEMON, at(120_000))))!
    const established = barrier()
    const releaseEstablish = barrier()
    const establishing = prisma.$transaction(
      async (tx) => {
        const result = await new PgWebchatMcpDelegationRepo(tx).establish(establishInput(DAEMON, at(120_000)))
        established.release()
        await releaseEstablish.promise
        return result
      },
      { timeout: 20_000 }
    )
    await established.promise

    const revoking = repo.revoke(revokeInput(delegation))
    await expectDatabaseWait()
    releaseEstablish.release()

    const returned = await establishing
    expect(returned).toMatchObject({
      id: delegation.id,
      generation: delegation.generation,
      expiresAt: at(120_000),
      revokedAt: null
    })
    expect(await revoking).toBe(true)
    expect(await repo.get(delegation.id)).toMatchObject({
      generation: returned?.generation,
      expiresAt: at(120_000),
      revokedAt: at(5_000)
    })
  })

  it('migrates the agent/revocation lookup index used by placement invalidation', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'webchat_mcp_delegation'
    `
    expect(indexes.map(({ indexname }) => indexname)).toContain('webchat_mcp_delegation_agentId_revokedAt_idx')
  })

  it('rotates placement by revoking the active row and incrementing the durable generation', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = await repo.establish(establishInput())

    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: OTHER_DAEMON } })
    const moved = await repo.establish(establishInput(OTHER_DAEMON))

    expect(moved).toMatchObject({ generation: 2, daemonId: OTHER_DAEMON, revokedAt: null })
    expect(await repo.get(first!.id)).toMatchObject({
      generation: 1,
      daemonId: DAEMON,
      revokedAt: NOW,
      revokedReason: 'placement_changed'
    })
  })

  it('rejects a caller-supplied daemon that is not the durable agent placement without mutating authority', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = (await repo.establish(establishInput()))!

    expect(await repo.establish(establishInput(OTHER_DAEMON))).toBeNull()
    expect(await repo.get(first.id)).toMatchObject({
      generation: 1,
      daemonId: DAEMON,
      revokedAt: null,
      revokedReason: null
    })
    expect(await prisma.webchatMcpDelegation.count({ where: { conversationId: CONVERSATION } })).toBe(1)
    expect(
      await prisma.webchatConversation.findUnique({
        where: { id: CONVERSATION },
        select: { delegationGeneration: true }
      })
    ).toEqual({ delegationGeneration: 1 })
  })

  it('rejects an unplaced agent without revoking or advancing its active delegation', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = (await repo.establish(establishInput()))!
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: null } })

    expect(await repo.establish(establishInput())).toBeNull()
    expect(await repo.get(first.id)).toMatchObject({
      generation: 1,
      daemonId: DAEMON,
      revokedAt: null,
      revokedReason: null
    })
    expect(await prisma.webchatMcpDelegation.count({ where: { conversationId: CONVERSATION } })).toBe(1)
    expect(
      await prisma.webchatConversation.findUnique({
        where: { id: CONVERSATION },
        select: { delegationGeneration: true }
      })
    ).toEqual({ delegationGeneration: 1 })
  })

  it('rotates an expired active row even when placement is unchanged', async () => {
    await fixtures()
    const delegationMetric = vi.fn()
    const assertionMetric = vi.fn()
    const invocationMetric = vi.fn()
    const metrics = { delegation: delegationMetric, assertion: assertionMetric, invocation: invocationMetric }
    const repo = new PgWebchatMcpDelegationRepo(prisma, metrics)
    const first = await repo.establish(establishInput(DAEMON, at(1_000)))

    const rotated = await repo.establish({ ...establishInput(DAEMON, at(120_000)), now: at(1_000) })
    expect(rotated).toMatchObject({ generation: 2, daemonId: DAEMON })
    expect(await repo.get(first!.id)).toMatchObject({
      revokedAt: at(1_000),
      revokedReason: 'expired'
    })

    const reaper = new McpInvocationReaper(
      { reap: async () => ({ markedAmbiguous: 0, deleted: 0, expiredAssertions: 0 }) },
      repo,
      new FakeClock(at(1_000).getTime()),
      undefined,
      metrics
    )
    await reaper.tick()

    expect(delegationMetric.mock.calls.map(([event]) => event)).toEqual(['established', 'rotated', 'expired'])
  })

  it('rejects a foreign owner binding instead of minting authority', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)

    expect(await repo.establish({ ...establishInput(), userId: 'foreign-user' })).toBeNull()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
  })

  it('revokes only when id, generation, and immutable authority all match', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const delegation = (await repo.establish(establishInput()))!
    const revoke = {
      delegationId: delegation.id,
      conversationId: CONVERSATION,
      generation: delegation.generation,
      userId: DEFAULT_OWNER_ID,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      revokedAt: at(500),
      reason: 'session_closed'
    }

    expect(await repo.revoke({ ...revoke, generation: delegation.generation + 1 })).toBe(false)
    expect(await repo.revoke({ ...revoke, daemonId: DaemonId(OTHER_DAEMON) })).toBe(false)
    expect((await repo.get(delegation.id))?.revokedAt).toBeNull()
    expect(await repo.revoke(revoke)).toBe(true)
    expect(await repo.revoke(revoke)).toBe(true)
    expect(await repo.get(delegation.id)).toMatchObject({
      revokedAt: at(500),
      revokedReason: 'session_closed'
    })
  })

  it('reaps at most 500 deterministic expired candidates and drains the remainder next', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const rows = Array.from({ length: 502 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      conversationId: CONVERSATION,
      generation: index + 1,
      userId: DEFAULT_OWNER_ID,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      daemonId: DAEMON,
      createdAt: at(index),
      expiresAt: at(1_000)
    }))
    await prisma.webchatMcpDelegation.createMany({ data: rows })
    await prisma.mcpInvocation.create({
      data: {
        id: '99999999-9999-4999-8999-999999999999',
        delegationId: rows[501]!.id,
        assertionHash: 'peppered:retained',
        requestHash: 'retained-request',
        method: 'tools/call',
        assertionExpires: at(2_000)
      }
    })

    expect(await repo.reapExpired(at(1_000))).toBe(500)
    expect(await repo.reapExpired(at(1_000))).toBe(1)
    expect(await prisma.webchatMcpDelegation.findMany({ orderBy: { id: 'asc' }, select: { id: true } })).toEqual([
      { id: rows[501]!.id }
    ])
  })
})
