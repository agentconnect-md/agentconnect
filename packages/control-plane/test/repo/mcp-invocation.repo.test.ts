import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgUserRepo, type PrismaLike } from '../../src/persistence/index.js'
import {
  MCP_INVOCATION_EXECUTION_TIMEOUT_MS,
  MCP_INVOCATION_MAX_RESPONSE_BYTES,
  MCP_INVOCATION_REAP_BATCH_SIZE,
  MCP_INVOCATION_RESPONSE_CACHE_TTL_MS,
  PgMcpInvocationRepo
} from '../../src/persistence/repositories/mcp-invocation.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'
const AGENT = 'a1111111-1111-4111-8111-111111111111'
const OTHER_AGENT = 'a2222222-2222-4222-8222-222222222222'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON = 'd2222222-2222-4222-8222-222222222222'
const INVOCATION = '11111111-1111-4111-8111-111111111111'
const OTHER_INVOCATION = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-07-30T00:00:00.000Z')

const at = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds)
const DEFAULT_CLAIM_CLOCK = { now: () => at(1_000).getTime() }

function invocationUuid(prefix: number, index: number): string {
  return `${prefix.toString(16).padStart(8, '0')}-1111-4111-8111-${index.toString(16).padStart(12, '0')}`
}

function invocationRepo(db: PrismaLike = prisma, clock: { now(): number } = DEFAULT_CLAIM_CLOCK): PgMcpInvocationRepo {
  return new PgMcpInvocationRepo(db, clock)
}

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

async function expectDatabaseWait(minimumBlocked = 1): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<{ blocked: bigint }[]>`
      SELECT COUNT(*) AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
    `
    if (state && state.blocked >= BigInt(minimumBlocked)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`expected at least ${minimumBlocked} invocation authority operations to wait on a database lock`)
}

function holdGeneralPresetLock(): {
  locked: Promise<void>
  release(): void
  completed: Promise<void>
} {
  const locked = barrier()
  const release = barrier()
  const completed = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT "orgId"
        FROM "preset_agent"
        WHERE "orgId" = ${DEFAULT_ORG_ID}
          AND "preset" = 'general'
        FOR UPDATE
      `
      locked.release()
      await release.promise
    },
    { timeout: 20_000 }
  )
  return { locked: locked.promise, release: release.release, completed }
}

async function fixtures(delegationExpiresAt = at(60 * 60_000)) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.presetAgent.create({
    data: { orgId: DEFAULT_ORG_ID, preset: 'general', agentId: AGENT, status: 'created' }
  })
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
    mintedAt: NOW,
    ...extra
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

function claimInput(delegation: { id: string; generation: number }, extra: Record<string, unknown> = {}) {
  return {
    invocationId: INVOCATION,
    assertionHash: 'peppered:assertion-1',
    delegationId: delegation.id,
    generation: delegation.generation,
    conversationId: CONVERSATION,
    userId: DEFAULT_OWNER_ID,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(AGENT),
    daemonId: DaemonId(DAEMON),
    ...extra
  }
}

type InvocationObservation = 'issued claim' | 'terminal replay'
type AgentDeleteWinner = 'invocation' | 'delete'

async function prepareObservation(
  repo: PgMcpInvocationRepo,
  delegation: { id: string; generation: number },
  observation: InvocationObservation
): Promise<void> {
  await repo.mint(mintInput(delegation.id))
  if (observation === 'issued claim') return
  expect((await repo.claim(claimInput(delegation))).kind).toBe('claimed')
  expect(
    await repo.complete({
      invocationId: INVOCATION,
      status: 'succeeded',
      responseStatus: 200,
      responseBytes: Buffer.from('cached'),
      completedAt: at(2_000)
    })
  ).toBe(true)
}

async function exerciseAuthorityRace(
  delegation: { id: string; generation: number },
  observation: InvocationObservation,
  authority: {
    write(db: PrismaLike): Promise<void>
    restore(): Promise<void>
  }
): Promise<void> {
  const repo = invocationRepo(prisma)
  await prepareObservation(repo, delegation, observation)

  const observed = barrier()
  const releaseObservation = barrier()
  const observing = prisma.$transaction(
    async (tx) => {
      const result = await invocationRepo(tx).claim(claimInput(delegation))
      observed.release()
      await releaseObservation.promise
      return result
    },
    { timeout: 20_000 }
  )
  await observed.promise

  const writingAfterObservation = authority.write(prisma)
  await expectDatabaseWait()
  releaseObservation.release()

  expect((await observing).kind).toBe(observation === 'issued claim' ? 'claimed' : 'existing')
  await writingAfterObservation

  await authority.restore()
  if (observation === 'issued claim') {
    await prisma.mcpInvocation.update({
      where: { id: INVOCATION },
      data: { status: 'issued', startedAt: null }
    })
  }

  const written = barrier()
  const releaseWrite = barrier()
  const writingFirst = prisma.$transaction(
    async (tx) => {
      await authority.write(tx)
      written.release()
      await releaseWrite.promise
    },
    { timeout: 20_000 }
  )
  await written.promise

  const observingAfterWrite = repo.claim(claimInput(delegation))
  await expectDatabaseWait()
  releaseWrite.release()

  await writingFirst
  expect(await observingAfterWrite).toEqual({ kind: 'denied' })
}

async function exerciseAgentDeleteRace(
  delegation: { id: string; generation: number },
  observation: InvocationObservation,
  winner: AgentDeleteWinner
): Promise<void> {
  const repo = invocationRepo(prisma)
  await prepareObservation(repo, delegation, observation)

  if (winner === 'invocation') {
    const observed = barrier()
    const releaseObservation = barrier()
    const observing = prisma.$transaction(
      async (tx) => {
        const result = await invocationRepo(tx).claim(claimInput(delegation))
        observed.release()
        await releaseObservation.promise
        return result
      },
      { timeout: 20_000 }
    )
    await observed.promise

    const deleting = new PgAgentRepo(prisma).delete(AgentId(AGENT))
    await expectDatabaseWait()
    releaseObservation.release()

    await expect(observing).resolves.toMatchObject({
      kind: observation === 'issued claim' ? 'claimed' : 'existing'
    })
    await expect(deleting).resolves.toEqual([])
  } else {
    const presetLock = holdGeneralPresetLock()
    await presetLock.locked

    const deleting = new PgAgentRepo(prisma).delete(AgentId(AGENT))
    await expectDatabaseWait()
    const observing = repo.claim(claimInput(delegation))
    await expectDatabaseWait(2)
    presetLock.release()

    await presetLock.completed
    await expect(deleting).resolves.toEqual([])
    await expect(observing).resolves.toEqual({ kind: 'denied' })
  }

  expect(await prisma.agent.findUnique({ where: { id: AGENT } })).toBeNull()
  expect(await prisma.mcpInvocation.findUnique({ where: { id: INVOCATION } })).toBeNull()
}

describe('PgMcpInvocationRepo (real Postgres)', () => {
  it('denies mint when the parent cannot cover the complete assertion lifetime', async () => {
    const delegation = await fixtures(at(29_999))

    expect(await invocationRepo(prisma).mint(mintInput(delegation.id))).toEqual({
      kind: 'denied'
    })
    expect(await prisma.mcpInvocation.count()).toBe(0)
  })

  it('rotates only assertion hash and expiry on an identical issued mint retry', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    const first = await repo.mint(mintInput(delegation.id))

    const retried = await repo.mint(
      mintInput(delegation.id, {
        assertionHash: 'peppered:assertion-2',
        assertionExpires: at(60_000),
        mintedAt: at(30_000)
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
    const repo = invocationRepo(prisma)
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
    const repo = invocationRepo(prisma)

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
    const repo = invocationRepo(prisma)

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
    const repo = invocationRepo(prisma)

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
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))

    const claims = await Promise.all([repo.claim(claimInput(delegation)), repo.claim(claimInput(delegation))])

    expect(claims.filter((result) => result.kind === 'claimed')).toHaveLength(1)
    expect(claims.filter((result) => result.kind === 'existing')).toHaveLength(1)
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'running', startedAt: at(1_000) })
  })

  it('rejects a claim whose assertion expires while it waits for the final authority lock', async () => {
    const delegation = await fixtures()
    const clock = new FakeClock(at(29_999).getTime())
    const repo = invocationRepo(prisma, clock)
    await repo.mint(mintInput(delegation.id))
    const presetLock = holdGeneralPresetLock()
    await presetLock.locked

    const claiming = repo.claim(claimInput(delegation))
    await expectDatabaseWait()
    clock.advance(1)
    presetLock.release()

    await presetLock.completed
    expect(await claiming).toEqual({ kind: 'expired' })
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'issued', startedAt: null })
  })

  it('rejects a claim whose delegation expires while it waits for the final authority lock', async () => {
    const delegation = await fixtures(at(30_000))
    const clock = new FakeClock(at(29_999).getTime())
    const repo = invocationRepo(prisma, clock)
    await repo.mint(mintInput(delegation.id))
    const presetLock = holdGeneralPresetLock()
    await presetLock.locked

    const claiming = repo.claim(claimInput(delegation))
    await expectDatabaseWait()
    clock.advance(1)
    presetLock.release()

    await presetLock.completed
    expect(await claiming).toEqual({ kind: 'denied' })
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'issued', startedAt: null })
  })

  it('claims at the repository clock sample one millisecond before the assertion deadline', async () => {
    const delegation = await fixtures()
    const clock = new FakeClock(at(29_998).getTime())
    const repo = invocationRepo(prisma, clock)
    await repo.mint(mintInput(delegation.id))
    const presetLock = holdGeneralPresetLock()
    await presetLock.locked

    const claiming = repo.claim(claimInput(delegation))
    await expectDatabaseWait()
    clock.advance(1)
    presetLock.release()

    await presetLock.completed
    const result = await claiming
    expect(result.kind).toBe('claimed')
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'running', startedAt: at(29_999) })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1])(
    'denies a claim when the repository clock cannot produce a valid Date: %s',
    async (now) => {
      const delegation = await fixtures()
      const repo = invocationRepo(prisma, { now: () => now })
      await repo.mint(mintInput(delegation.id))

      expect(await repo.claim(claimInput(delegation))).toEqual({ kind: 'denied' })
      expect(await repo.get(INVOCATION)).toMatchObject({ status: 'issued', startedAt: null })
    }
  )

  it.each(['issued claim', 'terminal replay'] as const)(
    'linearizes %s against membership removal in both lock orders',
    async (observation) => {
      const delegation = await fixtures()
      const transferOwner = await prisma.user.create({
        data: { id: 'mcp-invocation-transfer-owner', email: 'mcp-invocation-transfer-owner@example.com' }
      })
      await prisma.membership.create({
        data: { orgId: DEFAULT_ORG_ID, userId: transferOwner.id, role: 'owner' }
      })

      await exerciseAuthorityRace(delegation, observation, {
        async write(db) {
          await new PgUserRepo(db).removeMember(DEFAULT_ORG_ID, DEFAULT_OWNER_ID, transferOwner.id)
        },
        async restore() {
          await prisma.membership.create({
            data: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID, role: 'owner' }
          })
        }
      })
    }
  )

  it.each(['issued claim', 'terminal replay'] as const)(
    'linearizes %s against visibility tightening and sharedWith pruning in both lock orders',
    async (observation) => {
      const delegation = await fixtures()
      const resourceOwner = await prisma.user.create({
        data: { id: 'mcp-invocation-resource-owner', email: 'mcp-invocation-resource-owner@example.com' }
      })
      await prisma.membership.create({
        data: { orgId: DEFAULT_ORG_ID, userId: resourceOwner.id, role: 'collaborator' }
      })
      await prisma.agent.update({
        where: { id: AGENT },
        data: { ownerUserId: resourceOwner.id }
      })
      await new PgUserRepo(prisma).setMemberRole(DEFAULT_ORG_ID, DEFAULT_OWNER_ID, 'collaborator')
      await new PgAgentRepo(prisma).setSharing(AgentId(AGENT), {
        visibility: 'restricted',
        sharedWith: [DEFAULT_OWNER_ID]
      })

      await exerciseAuthorityRace(delegation, observation, {
        async write(db) {
          await new PgAgentRepo(db).setSharing(AgentId(AGENT), {
            visibility: 'restricted',
            sharedWith: []
          })
        },
        async restore() {
          await new PgAgentRepo(prisma).setSharing(AgentId(AGENT), {
            visibility: 'restricted',
            sharedWith: [DEFAULT_OWNER_ID]
          })
        }
      })
    }
  )

  it.each(['issued claim', 'terminal replay'] as const)(
    'linearizes %s against general-preset replacement in both lock orders',
    async (observation) => {
      const delegation = await fixtures()
      await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })

      await exerciseAuthorityRace(delegation, observation, {
        async write(db) {
          await db.presetAgent.update({
            where: { orgId_preset: { orgId: DEFAULT_ORG_ID, preset: 'general' } },
            data: { agentId: OTHER_AGENT }
          })
        },
        async restore() {
          await prisma.presetAgent.update({
            where: { orgId_preset: { orgId: DEFAULT_ORG_ID, preset: 'general' } },
            data: { agentId: AGENT }
          })
        }
      })
    }
  )

  it.each([
    ['issued claim', 'invocation'],
    ['terminal replay', 'invocation'],
    ['issued claim', 'delete'],
    ['terminal replay', 'delete']
  ] as const)(
    'linearizes %s against real agent deletion when %s wins without deadlock',
    async (observation, winner) => {
      const delegation = await fixtures()

      await exerciseAgentDeleteRace(delegation, observation, winner)
    }
  )

  it('never reissues running or terminal invocations', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim(claimInput(delegation))

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
    const repo = invocationRepo(prisma)
    const responseBytes = Buffer.from([0, 255, 13, 10, 123, 125])
    await repo.mint(mintInput(delegation.id))
    await repo.claim(claimInput(delegation))

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
      const repo = invocationRepo(prisma)
      const responseBytes = Buffer.from(`cached-${status}`)
      await repo.mint(mintInput(delegation.id))
      await repo.claim(claimInput(delegation))
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
          mintedAt: at(3_000)
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
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim(claimInput(delegation))

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

  it.each([
    [MCP_INVOCATION_EXECUTION_TIMEOUT_MS - 1, true],
    [MCP_INVOCATION_EXECUTION_TIMEOUT_MS, false],
    [MCP_INVOCATION_EXECUTION_TIMEOUT_MS + 1, false]
  ] as const)(
    'atomically accepts completion only before the durable deadline: elapsed=%d',
    async (elapsed, accepted) => {
      const delegation = await fixtures()
      const repo = invocationRepo(prisma)
      await repo.mint(mintInput(delegation.id))
      await repo.claim(claimInput(delegation))

      expect(
        await repo.complete({
          invocationId: INVOCATION,
          status: 'succeeded',
          responseStatus: 200,
          responseBytes: Buffer.from('boundary'),
          completedAt: at(1_000 + elapsed)
        })
      ).toBe(accepted)
      expect(await repo.get(INVOCATION)).toMatchObject({
        status: accepted ? 'succeeded' : 'running'
      })
    }
  )

  it('makes a late completion lose to running-to-ambiguous recovery', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim(claimInput(delegation))

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

  it('marks only the named running invocation ambiguous', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim(claimInput(delegation))
    await repo.mint(
      mintInput(delegation.id, {
        invocationId: OTHER_INVOCATION,
        assertionHash: 'peppered:assertion-2'
      })
    )
    await repo.claim(
      claimInput(delegation, {
        invocationId: OTHER_INVOCATION,
        assertionHash: 'peppered:assertion-2'
      })
    )

    expect(await repo.markAmbiguous(INVOCATION, at(122_000))).toBe(true)
    expect(await repo.markAmbiguous(INVOCATION, at(123_000))).toBe(false)
    expect(await repo.get(INVOCATION)).toMatchObject({
      status: 'ambiguous',
      completedAt: at(122_000)
    })
    expect(await repo.get(OTHER_INVOCATION)).toMatchObject({
      status: 'running',
      completedAt: null
    })
  })

  it('reaps unused assertions and cached terminals only in their own windows', async () => {
    const delegation = await fixtures(at(10_000))
    const repo = invocationRepo(prisma, { now: () => at(12_000).getTime() })
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
    await repo.claim(claimInput(liveDelegation!, { invocationId: OTHER_INVOCATION }))
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

    const minting = invocationRepo(prisma).mint(mintInput(delegation.id))
    await expectPending(minting)
    releaseReaper.release()

    expect(await reaping).toBe(1)
    expect(await minting).toEqual({ kind: 'denied' })
    expect(await prisma.mcpInvocation.count()).toBe(0)
  })

  it('denies without persisting when revocation wins against mint', async () => {
    const delegation = await fixtures()
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

    const minting = invocationRepo(prisma).mint(mintInput(delegation.id))
    await expectPending(minting)
    releaseRevoke.release()

    expect(await revoking).toBe(true)
    expect(await minting).toEqual({ kind: 'denied' })
    expect(await prisma.mcpInvocation.count()).toBe(0)
  })

  it('may issue before revocation, while holding a conflicting parent share lock', async () => {
    const delegation = await fixtures()
    const minted = barrier()
    const releaseMint = barrier()
    const minting = prisma.$transaction(
      async (tx) => {
        const result = await invocationRepo(tx).mint(mintInput(delegation.id))
        minted.release()
        await releaseMint.promise
        return result
      },
      { timeout: 20_000 }
    )
    await minted.promise

    const revoking = new PgWebchatMcpDelegationRepo(prisma).revoke(revokeInput(delegation))
    await expectPending(revoking)
    releaseMint.release()

    expect((await minting).kind).toBe('issued')
    expect(await revoking).toBe(true)
    expect(await prisma.mcpInvocation.count()).toBe(1)
  })

  it('denies claim when revocation wins the parent lock', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
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

    const claiming = repo.claim(claimInput(delegation))
    await expectPending(claiming)
    releaseRevoke.release()

    expect(await revoking).toBe(true)
    expect(await claiming).toEqual({ kind: 'denied' })
    expect(await repo.get(INVOCATION)).toMatchObject({ status: 'issued', startedAt: null })
  })

  it('claims before a concurrent revoke only while holding the parent share lock', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    const claimed = barrier()
    const releaseClaim = barrier()
    const claiming = prisma.$transaction(
      async (tx) => {
        const result = await invocationRepo(tx).claim(claimInput(delegation))
        claimed.release()
        await releaseClaim.promise
        return result
      },
      { timeout: 20_000 }
    )
    await claimed.promise

    const revoking = new PgWebchatMcpDelegationRepo(prisma).revoke(revokeInput(delegation))
    await expectPending(revoking)
    releaseClaim.release()

    expect((await claiming).kind).toBe('claimed')
    expect(await revoking).toBe(true)
  })

  it('denies claim when expiry shortening wins the parent lock', async () => {
    const delegation = await fixtures()
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    const shortened = barrier()
    const releaseShortening = barrier()
    const shortening = prisma.$transaction(
      async (tx) => {
        const result = await new PgWebchatMcpDelegationRepo(tx).establish({
          conversationId: CONVERSATION,
          userId: DEFAULT_OWNER_ID,
          orgId: OrgId(DEFAULT_ORG_ID),
          agentId: AgentId(AGENT),
          daemonId: DaemonId(DAEMON),
          now: at(500),
          expiresAt: at(999)
        })
        shortened.release()
        await releaseShortening.promise
        return result
      },
      { timeout: 20_000 }
    )
    await shortened.promise

    const claiming = repo.claim(claimInput(delegation))
    await expectPending(claiming)
    releaseShortening.release()

    expect((await shortening)?.expiresAt).toEqual(at(999))
    expect(await claiming).toEqual({ kind: 'denied' })
  })

  it('denies claim when placement change and delegation revocation win the agent lock', async () => {
    const delegation = await fixtures()
    await seedDaemon(prisma, OTHER_DAEMON)
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    const moved = barrier()
    const releaseMove = barrier()
    const moving = prisma.$transaction(
      async (tx) => {
        await new PgAgentRepo(tx).setPlacement(AgentId(AGENT), DaemonId(OTHER_DAEMON))
        moved.release()
        await releaseMove.promise
      },
      { timeout: 20_000 }
    )
    await moved.promise

    const claiming = repo.claim(claimInput(delegation))
    await expectPending(claiming)
    releaseMove.release()

    await moving
    expect(await claiming).toEqual({ kind: 'denied' })
  })

  it('denies without persisting when expiry shortening wins against mint', async () => {
    const delegation = await fixtures()
    const shortened = barrier()
    const releaseShorten = barrier()
    const shortening = prisma.$transaction(
      async (tx) => {
        const result = await new PgWebchatMcpDelegationRepo(tx).establish({
          conversationId: CONVERSATION,
          userId: DEFAULT_OWNER_ID,
          orgId: OrgId(DEFAULT_ORG_ID),
          agentId: AgentId(AGENT),
          daemonId: DaemonId(DAEMON),
          now: NOW,
          expiresAt: at(20_000)
        })
        shortened.release()
        await releaseShorten.promise
        return result
      },
      { timeout: 20_000 }
    )
    await shortened.promise

    const minting = invocationRepo(prisma).mint(mintInput(delegation.id))
    await expectPending(minting)
    releaseShorten.release()

    expect((await shortening)?.expiresAt).toEqual(at(20_000))
    expect(await minting).toEqual({ kind: 'denied' })
    expect(await prisma.mcpInvocation.count()).toBe(0)
  })

  it('may issue before expiry shortening, while holding a conflicting parent share lock', async () => {
    const delegation = await fixtures()
    const minted = barrier()
    const releaseMint = barrier()
    const minting = prisma.$transaction(
      async (tx) => {
        const result = await invocationRepo(tx).mint(mintInput(delegation.id))
        minted.release()
        await releaseMint.promise
        return result
      },
      { timeout: 20_000 }
    )
    await minted.promise

    const shortening = new PgWebchatMcpDelegationRepo(prisma).establish({
      conversationId: CONVERSATION,
      userId: DEFAULT_OWNER_ID,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      now: NOW,
      expiresAt: at(20_000)
    })
    await expectPending(shortening)
    releaseMint.release()

    expect((await minting).kind).toBe('issued')
    expect((await shortening)?.expiresAt).toEqual(at(20_000))
    expect(await prisma.mcpInvocation.count()).toBe(1)
  })

  it('keeps a delegation when an eligible mint wins its parent lock first', async () => {
    const delegation = await fixtures(at(60_000))
    const minted = barrier()
    const releaseMint = barrier()
    const minting = prisma.$transaction(
      async (tx) => {
        const result = await invocationRepo(tx).mint(mintInput(delegation.id))
        minted.release()
        await releaseMint.promise
        return result
      },
      { timeout: 20_000 }
    )
    await minted.promise

    const reaping = new PgWebchatMcpDelegationRepo(prisma).reapExpired(at(60_000))
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

    const minting = invocationRepo(prisma).mint(mintInput(delegation.id))
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
        const result = await invocationRepo(tx).mint(mintInput(delegation.id))
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
    const repo = invocationRepo(prisma)
    await repo.mint(mintInput(delegation.id))
    await repo.claim(claimInput(delegation))

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

  it('bounds every invocation reap class and drains each stable worklist across ticks', async () => {
    const delegation = await fixtures(at(60 * 60_000))
    const now = at(MCP_INVOCATION_RESPONSE_CACHE_TTL_MS + MCP_INVOCATION_EXECUTION_TIMEOUT_MS)
    const count = MCP_INVOCATION_REAP_BATCH_SIZE + 1
    await prisma.mcpInvocation.createMany({
      data: [
        ...Array.from({ length: count }, (_, index) => ({
          id: invocationUuid(0x10000001, index),
          delegationId: delegation.id,
          assertionHash: `batch-issued-${index}`,
          requestHash: 'request',
          method: 'tools/list',
          status: 'issued' as const,
          assertionExpires: now,
          createdAt: NOW
        })),
        ...Array.from({ length: count }, (_, index) => ({
          id: invocationUuid(0x20000002, index),
          delegationId: delegation.id,
          assertionHash: `batch-running-${index}`,
          requestHash: 'request',
          method: 'tools/list',
          status: 'running' as const,
          assertionExpires: NOW,
          startedAt: new Date(now.getTime() - MCP_INVOCATION_EXECUTION_TIMEOUT_MS),
          createdAt: NOW
        })),
        ...Array.from({ length: count }, (_, index) => ({
          id: invocationUuid(0x30000003, index),
          delegationId: delegation.id,
          assertionHash: `batch-terminal-${index}`,
          requestHash: 'request',
          method: 'tools/list',
          status: 'succeeded' as const,
          assertionExpires: NOW,
          startedAt: NOW,
          completedAt: new Date(now.getTime() - MCP_INVOCATION_RESPONSE_CACHE_TTL_MS),
          responseStatus: 200,
          responseBytes: Buffer.from('cached'),
          createdAt: NOW
        }))
      ]
    })

    expect(await invocationRepo(prisma).reap(now)).toEqual({
      markedAmbiguous: MCP_INVOCATION_REAP_BATCH_SIZE,
      deleted: MCP_INVOCATION_REAP_BATCH_SIZE * 2
    })
    expect(await prisma.mcpInvocation.groupBy({ by: ['status'], _count: true })).toEqual(
      expect.arrayContaining([
        { status: 'issued', _count: 1 },
        { status: 'running', _count: 1 },
        { status: 'ambiguous', _count: MCP_INVOCATION_REAP_BATCH_SIZE }
      ])
    )

    expect(await invocationRepo(prisma).reap(now)).toEqual({
      markedAmbiguous: 1,
      deleted: 2
    })
    expect(await prisma.mcpInvocation.groupBy({ by: ['status'], _count: true })).toEqual([
      { status: 'ambiguous', _count: count }
    ])
  })

  it('skips a locked oldest row without blocking or starving the rest of its bounded worklist', async () => {
    const delegation = await fixtures(at(60 * 60_000))
    const now = at(30_000)
    const count = MCP_INVOCATION_REAP_BATCH_SIZE + 1
    const ids = Array.from({ length: count }, (_, index) => invocationUuid(0x40000004, index))
    await prisma.mcpInvocation.createMany({
      data: ids.map((id, index) => ({
        id,
        delegationId: delegation.id,
        assertionHash: `locked-issued-${index}`,
        requestHash: 'request',
        method: 'tools/list',
        status: 'issued' as const,
        assertionExpires: now,
        createdAt: new Date(NOW.getTime() + index)
      }))
    })

    const locked = barrier()
    const release = barrier()
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "mcp_invocation" WHERE "id" = ${ids[0]} FOR UPDATE`
        locked.release()
        await release.promise
      },
      { timeout: 20_000 }
    )
    await locked.promise

    const first = await invocationRepo(prisma).reap(now)
    expect(first).toEqual({ markedAmbiguous: 0, deleted: MCP_INVOCATION_REAP_BATCH_SIZE })
    expect(await prisma.mcpInvocation.findUnique({ where: { id: ids[0]! } })).not.toBeNull()
    release.release()
    await holder

    expect(await invocationRepo(prisma).reap(now)).toEqual({ markedAmbiguous: 0, deleted: 1 })
    expect(await prisma.mcpInvocation.count()).toBe(0)
  })

  it('keeps an expired parent until every bounded child batch has been reaped', async () => {
    const delegation = await fixtures(at(10_000))
    const now = at(10_000)
    const count = MCP_INVOCATION_REAP_BATCH_SIZE + 1
    await prisma.mcpInvocation.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        id: invocationUuid(0x50000005, index),
        delegationId: delegation.id,
        assertionHash: `parent-issued-${index}`,
        requestHash: 'request',
        method: 'tools/list',
        status: 'issued' as const,
        assertionExpires: now,
        createdAt: NOW
      }))
    })
    const invocations = invocationRepo(prisma)
    const delegations = new PgWebchatMcpDelegationRepo(prisma)

    expect(await invocations.reap(now)).toEqual({
      markedAmbiguous: 0,
      deleted: MCP_INVOCATION_REAP_BATCH_SIZE
    })
    expect(await delegations.reapExpired(now)).toBe(0)
    expect(await prisma.webchatMcpDelegation.findUnique({ where: { id: delegation.id } })).not.toBeNull()

    expect(await invocations.reap(now)).toEqual({ markedAmbiguous: 0, deleted: 1 })
    expect(await delegations.reapExpired(now)).toBe(1)
    expect(await prisma.webchatMcpDelegation.findUnique({ where: { id: delegation.id } })).toBeNull()
  })

  it('migrates stable-order indexes for each bounded reaper worklist', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'mcp_invocation'
    `
    expect(indexes.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'mcp_invocation_status_assertionExpires_id_idx',
        'mcp_invocation_status_startedAt_id_idx',
        'mcp_invocation_status_completedAt_id_idx'
      ])
    )
  })
})
