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

  it('converges concurrent same-id, same-binding mints on one issued row', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)

    const results = await Promise.all([
      repo.mint(mintInput(delegation.id)),
      repo.mint(mintInput(delegation.id, { assertionHash: 'peppered:assertion-2' }))
    ])

    expect(results.every((result) => result.kind === 'issued')).toBe(true)
    expect(await prisma.mcpInvocation.count()).toBe(1)
    expect(['peppered:assertion-1', 'peppered:assertion-2']).toContain((await repo.get(INVOCATION))?.assertionHash)
  })

  it('allows one concurrent same-id, different-binding mint and conflicts the other', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)

    const results = await Promise.all([
      repo.mint(mintInput(delegation.id)),
      repo.mint(
        mintInput(delegation.id, {
          assertionHash: 'peppered:assertion-2',
          requestHash: 'different-request'
        })
      )
    ])

    expect(results.filter((result) => result.kind === 'issued')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1)
    expect(await prisma.mcpInvocation.count()).toBe(1)
  })

  it('allows one concurrent different-id mint for the same assertion hash and conflicts the other', async () => {
    const delegation = await fixtures()
    const repo = new PgMcpInvocationRepo(prisma)

    const results = await Promise.all([
      repo.mint(mintInput(delegation.id)),
      repo.mint(mintInput(delegation.id, { invocationId: OTHER_INVOCATION }))
    ])

    expect(results.filter((result) => result.kind === 'issued')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1)
    expect(await prisma.mcpInvocation.count()).toBe(1)
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

  it.each(['succeeded', 'failed'] as const)(
    'never rotates assertion or cached body when an identical %s invocation is minted again',
    async (status) => {
      const delegation = await fixtures()
      const repo = new PgMcpInvocationRepo(prisma)
      const responseBytes = Buffer.from(`cached-${status}`)
      await repo.mint(mintInput(delegation.id))
      await repo.claim({ invocationId: INVOCATION, assertionHash: 'peppered:assertion-1', now: at(1_000) })
      await repo.complete({
        invocationId: INVOCATION,
        status,
        responseStatus: status === 'succeeded' ? 200 : 400,
        responseBytes,
        completedAt: at(2_000)
      })

      const retry = await repo.mint(
        mintInput(delegation.id, {
          assertionHash: 'peppered:rotated',
          assertionExpires: at(60_000),
          now: at(3_000)
        })
      )

      expect(retry.kind).toBe('existing')
      const stored = await repo.get(INVOCATION)
      expect(stored).toMatchObject({
        status,
        assertionHash: 'peppered:assertion-1',
        assertionExpires: at(30_000),
        completedAt: at(2_000)
      })
      expect(Buffer.from(stored!.responseBytes!)).toEqual(responseBytes)
    }
  )

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
    await repo.mint(
      mintInput(liveDelegation!.id, {
        invocationId: OTHER_INVOCATION,
        now: at(11_000),
        assertionExpires: at(41_000)
      })
    )
    await repo.claim({
      invocationId: OTHER_INVOCATION,
      assertionHash: 'peppered:assertion-1',
      now: at(12_000)
    })
    await repo.complete({
      invocationId: OTHER_INVOCATION,
      status: 'failed',
      responseStatus: 400,
      responseBytes: Buffer.from('cached'),
      completedAt: at(13_000)
    })

    expect(await repo.reap(at(13_000 + MCP_INVOCATION_RESPONSE_CACHE_TTL_MS - 1))).toEqual({
      markedAmbiguous: 0,
      deleted: 0
    })
    expect(await repo.get(OTHER_INVOCATION)).not.toBeNull()
    expect(await repo.reap(at(13_000 + MCP_INVOCATION_RESPONSE_CACHE_TTL_MS))).toEqual({
      markedAmbiguous: 0,
      deleted: 1
    })
  })

  it('denies mint after an expired-delegation reaper wins the parent lock', async () => {
    const delegation = await fixtures(at(1_000))
    const reaped = barrier()
    const releaseReaper = barrier()
    const reaping = prisma.$transaction(
      async (tx) => {
        const count = await new PgWebchatMcpDelegationRepo(tx).reapExpired(at(1_000))
        reaped.release()
        await releaseReaper.promise
        return count
      },
      { timeout: 20_000 }
    )
    await reaped.promise

    const minting = new PgMcpInvocationRepo(prisma).mint(mintInput(delegation.id))
    await expectPending(minting)
    releaseReaper.release()

    expect(await reaping).toBe(1)
    expect(await minting).toEqual({ kind: 'denied' })
    expect(await prisma.mcpInvocation.count()).toBe(0)
  })

  it('keeps an expired delegation when mint wins its parent lock first', async () => {
    const delegation = await fixtures(at(1_000))
    const minted = barrier()
    const releaseMint = barrier()
    const minting = prisma.$transaction(
      async (tx) => {
        const result = await new PgMcpInvocationRepo(tx).mint(mintInput(delegation.id))
        minted.release()
        await releaseMint.promise
        return result
      },
      { timeout: 20_000 }
    )
    await minted.promise

    const reaping = new PgWebchatMcpDelegationRepo(prisma).reapExpired(at(1_000))
    await expectPending(reaping)
    releaseMint.release()

    expect((await minting).kind).toBe('issued')
    expect(await reaping).toBe(0)
    expect(await prisma.webchatMcpDelegation.findUnique({ where: { id: delegation.id } })).not.toBeNull()
    expect(await prisma.mcpInvocation.findUnique({ where: { id: INVOCATION } })).not.toBeNull()
  })

  it('denies mint cleanly when owner cascade deletion wins first', async () => {
    const delegation = await fixtures()
    const deleted = barrier()
    const releaseDelete = barrier()
    const deleting = prisma.$transaction(
      async (tx) => {
        await tx.user.delete({ where: { id: DEFAULT_OWNER_ID } })
        deleted.release()
        await releaseDelete.promise
      },
      { timeout: 20_000 }
    )
    await deleted.promise

    const minting = new PgMcpInvocationRepo(prisma).mint(mintInput(delegation.id))
    await expectPending(minting)
    releaseDelete.release()

    await deleting
    expect(await minting).toEqual({ kind: 'denied' })
  })

  it('may issue before daemon cascade deletion, then fails closed by losing authority and ledger', async () => {
    const delegation = await fixtures()
    const minted = barrier()
    const releaseMint = barrier()
    const minting = prisma.$transaction(
      async (tx) => {
        const result = await new PgMcpInvocationRepo(tx).mint(mintInput(delegation.id))
        minted.release()
        await releaseMint.promise
        return result
      },
      { timeout: 20_000 }
    )
    await minted.promise

    const deleting = prisma.daemon.delete({ where: { id: DAEMON } })
    await expectPending(deleting)
    releaseMint.release()

    expect((await minting).kind).toBe('issued')
    await deleting
    expect(await prisma.webchatMcpDelegation.findUnique({ where: { id: delegation.id } })).toBeNull()
    expect(await prisma.mcpInvocation.findUnique({ where: { id: INVOCATION } })).toBeNull()
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
