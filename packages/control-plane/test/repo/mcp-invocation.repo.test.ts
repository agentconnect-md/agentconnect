import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import {
  MCP_INVOCATION_EXECUTION_TIMEOUT_MS,
  MCP_INVOCATION_MAX_RESPONSE_BYTES,
  MCP_INVOCATION_RESPONSE_CACHE_TTL_MS,
  PgMcpInvocationRepo
} from '../../src/persistence/repositories/mcp-invocation.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'
const AGENT = 'a1111111-1111-4111-8111-111111111111'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const INVOCATION = '11111111-1111-4111-8111-111111111111'
const OTHER_INVOCATION = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-07-30T00:00:00.000Z')

const at = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds)

async function fixtures(delegationExpiresAt = at(60 * 60_000)) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.webchatConversation.create({
    data: {
      id: CONVERSATION,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      userId: DEFAULT_OWNER_ID
    }
  })
  const delegation = await new PgWebchatMcpDelegationRepo(prisma).establish({
    conversationId: CONVERSATION,
    userId: DEFAULT_OWNER_ID,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(AGENT),
    daemonId: DaemonId(DAEMON),
    now: NOW,
    expiresAt: delegationExpiresAt
  })
  return delegation!
}

function mintInput(delegationId: string, extra: Record<string, unknown> = {}) {
  return {
    invocationId: INVOCATION,
    delegationId,
    assertionHash: 'peppered:assertion-1',
    requestHash: 'request-1',
    method: 'tools/call',
    toolName: 'agents.list',
    assertionExpires: at(30_000),
    now: NOW,
    ...extra
  }
}

describe('PgMcpInvocationRepo (real Postgres)', () => {
  it('rotates only assertion hash and expiry on an identical issued mint retry', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    const first = await repo.mint(mintInput(delegation.id))

    const retried = await repo.mint(
      mintInput(delegation.id, {
        assertionHash: 'peppered:assertion-2',
        assertionExpires: at(60_000),
        now: at(31_000)
      })
    )

    expect(first.kind).toBe('issued')
    expect(retried.kind).toBe('issued')
    if (retried.kind !== 'issued' || first.kind !== 'issued') throw new Error('expected issued')
    expect(retried.invocation).toMatchObject({
      id: INVOCATION,
      delegationId: delegation.id,
      assertionHash: 'peppered:assertion-2',
      assertionExpires: at(60_000),
      requestHash: 'request-1',
      method: 'tools/call',
      toolName: 'agents.list',
      status: 'issued',
      createdAt: first.invocation.createdAt
    })
    expect(await repo.getByAssertionHash('peppered:assertion-1')).toBeNull()
  })

  it('returns conflict when an invocation id is retried with a different immutable binding', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))

    const conflict = await repo.mint(mintInput(delegation.id, { requestHash: 'different-request' }))

    expect(conflict).toEqual({ kind: 'conflict' })
    expect(await repo.get(INVOCATION)).toMatchObject({
      requestHash: 'request-1',
      assertionHash: 'peppered:assertion-1'
    })
  })

  it('allows exactly one issued-to-running claim winner', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))

    const claims = await Promise.all([
      repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) }),
      repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })
    ])

    expect(claims.filter((result) => result.kind === 'claimed')).toHaveLength(1)
    expect(claims.filter((result) => result.kind === 'existing')).toHaveLength(1)
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'running', startedAt: at(1_000) })
  })

  it('never reissues running or terminal invocations', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })

    const retry = await repo.mint(
      mintInput(delegation.id, {
        assertionHash: 'peppered:assertion-2',
        assertionExpires: at(60_000)
      })
    )

    expect(retry.kind).toBe('existing')
    expect(await repo.get(INVOCATION)).toMatchObject({
      status: 'running',
      assertionHash: 'peppered:assertion-1',
      assertionExpires: at(30_000)
    })
  })

  it('stores and replays a terminal response byte-for-byte', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    const responseBytes = Buffer.from([0, 255, 13, 10, 123, 125])
    await repo.mint(mintInput(delegation.id))
    await repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })

    expect(
      await repo.complete({
        invocationId: INVOCATION,
        status: 'succeeded',
        responseStatus: 200,
        responseBytes,
        completedAt: at(2_000)
      })
    ).toBe(true)
    const replay = await repo.getByAssertionHash('peppered:assertion-1')

    expect(replay).toMatchObject({
      status: 'succeeded',
      responseStatus: 200,
      completedAt: at(2_000)
    })
    expect(Buffer.from(replay!.responseBytes!)).toEqual(responseBytes)
  })

  it('rejects an oversized terminal response before it reaches persistence', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })

    await expect(
      repo.complete({
        invocationId: INVOCATION,
        status: 'failed',
        responseStatus: 500,
        responseBytes: Buffer.alloc(MCP_INVOCATION_MAX_RESPONSE_BYTES + 1),
        completedAt: at(2_000)
      })
    ).rejects.toThrow(/256 KiB/)
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'running' })
  })

  it('makes a late completion lose to running-to-ambiguous recovery', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })

    expect(await repo.markAmbiguousBefore(at(121_000), at(122_000))).toBe(1)
    expect(
      await repo.complete({
        invocationId: INVOCATION,
        status: 'succeeded',
        responseStatus: 200,
        responseBytes: Buffer.from('late'),
        completedAt: at(123_000)
      })
    ).toBe(false)
    expect(await repo.get(INVOCATION)).toMatchObject({
      status: 'ambiguous',
      completedAt: at(122_000),
      responseStatus: null,
      responseBytes: null
    })
  })

  it('reaps unused assertions and cached terminals only in their own windows', async () => {
    const delegation = await fixtures(at(10_000))
    const repo = new PgMcpInvocationRepo(prisma)
    const delegations = new PgWebchatMcpDelegationRepo(prisma)

    await repo.mint(mintInput(delegation.id, { assertionExpires: at(5_000) }))
    expect(await delegations.reapExpired(at(10_000))).toBe(0)
    expect(await repo.reap(at(4_999))).toEqual({ markedAmbiguous: 0, deleted: 0 })
    expect(await repo.reap(at(5_000))).toEqual({ markedAmbiguous: 0, deleted: 1 })
    expect(await delegations.reapExpired(at(10_000))).toBe(1)

    const liveDelegation = await delegations.establish({
      conversationId: CONVERSATION,
      userId: DEFAULT_OWNER_ID,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      now: at(10_001),
      expiresAt: at(60 * 60_000)
    })
    await repo.mint(mintInput(liveDelegation!.id, { invocationId: OTHER_INVOCATION }))
    await repo.claim({
      invocationId: OTHER_INVOCATION,
      assertionHash: 'peppered:assertion-1',
      now: at(1_000)
    })
    await repo.complete({
      invocationId: OTHER_INVOCATION,
      status: 'failed',
      responseStatus: 400,
      responseBytes: Buffer.from('cached'),
      completedAt: at(2_000)
    })

    expect(await repo.reap(at(2_000 + MCP_INVOCATION_RESPONSE_CACHE_TTL_MS - 1))).toEqual({
      markedAmbiguous: 0,
      deleted: 0
    })
    expect(await repo.get(OTHER_INVOCATION)).not.toBeNull()
    expect(await repo.reap(at(2_000 + MCP_INVOCATION_RESPONSE_CACHE_TTL_MS))).toEqual({
      markedAmbiguous: 0,
      deleted: 1
    })
  })

  it('marks running invocations ambiguous only after the fixed execution window', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })

    expect(await repo.reap(at(1_000 + MCP_INVOCATION_EXECUTION_TIMEOUT_MS - 1))).toEqual({
      markedAmbiguous: 0,
      deleted: 0
    })
    expect(await repo.reap(at(1_000 + MCP_INVOCATION_EXECUTION_TIMEOUT_MS))).toEqual({
      markedAmbiguous: 1,
      deleted: 0
    })
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'ambiguous' })
  })
})
