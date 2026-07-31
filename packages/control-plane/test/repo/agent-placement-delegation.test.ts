import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'
const OTHER_CONVERSATION = 'c2222222-2222-4222-8222-222222222222'
const AGENT = AgentId('a1111111-1111-4111-8111-111111111111')
const DAEMON = DaemonId('d1111111-1111-4111-8111-111111111111')
const OTHER_DAEMON = DaemonId('d2222222-2222-4222-8222-222222222222')
const NOW = new Date('2026-07-30T00:00:00.000Z')

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

async function fixtures() {
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
  const input = {
    conversationId: CONVERSATION,
    userId: DEFAULT_OWNER_ID,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AGENT,
    daemonId: DAEMON,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000)
  }
  return { input }
}

describe('agent placement and webchat MCP delegation serialization (real Postgres)', () => {
  it('lets agent deletion win without deadlocking a conversation-first establishment', async () => {
    const { input } = await fixtures()
    const agentLocked = barrier()
    const releaseDelete = barrier()
    const deleting = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "agent" WHERE "id" = ${AGENT} FOR UPDATE`
        agentLocked.release()
        await releaseDelete.promise
        await tx.agent.delete({ where: { id: AGENT } })
      },
      { timeout: 20_000 }
    )
    await agentLocked.promise

    const establishment = new PgWebchatMcpDelegationRepo(prisma).establish(input)
    await expectPending(establishment)
    releaseDelete.release()

    await expect(deleting).resolves.toBeUndefined()
    await expect(establishment).resolves.toBeNull()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
  })

  it('lets establishment win before agent deletion, which then cascades the new authority', async () => {
    const { input } = await fixtures()
    const established = barrier()
    const releaseEstablishment = barrier()
    const establishment = prisma.$transaction(
      async (tx) => {
        const delegation = await new PgWebchatMcpDelegationRepo(tx).establish(input)
        established.release()
        await releaseEstablishment.promise
        return delegation
      },
      { timeout: 20_000 }
    )
    await established.promise

    const deleting = prisma.agent.delete({ where: { id: AGENT } })
    await expectPending(deleting)
    releaseEstablishment.release()

    expect(await establishment).not.toBeNull()
    await expect(deleting).resolves.toBeDefined()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
  })

  it('does not exclusively serialize independent conversations for the same agent', async () => {
    const { input } = await fixtures()
    await prisma.webchatConversation.create({
      data: {
        id: OTHER_CONVERSATION,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        userId: DEFAULT_OWNER_ID
      }
    })
    const firstEstablished = barrier()
    const releaseFirst = barrier()
    const first = prisma.$transaction(
      async (tx) => {
        const delegation = await new PgWebchatMcpDelegationRepo(tx).establish(input)
        firstEstablished.release()
        await releaseFirst.promise
        return delegation
      },
      { timeout: 20_000 }
    )
    await firstEstablished.promise

    const second = new PgWebchatMcpDelegationRepo(prisma).establish({
      ...input,
      conversationId: OTHER_CONVERSATION
    })
    let timeout!: ReturnType<typeof setTimeout>
    const outcome = await Promise.race([
      second.then((value) => ({ kind: 'settled' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 2_000)
      })
    ])
    clearTimeout(timeout)
    releaseFirst.release()

    expect(await first).not.toBeNull()
    expect(await second).not.toBeNull()
    expect(outcome.kind).toBe('settled')
  })

  it('denies stale establishment when setPlacement wins the agent lock first', async () => {
    const { input } = await fixtures()
    const placed = barrier()
    const releasePlacement = barrier()
    const placement = prisma.$transaction(
      async (tx) => {
        await new PgAgentRepo(tx).setPlacement(AGENT, OTHER_DAEMON)
        placed.release()
        await releasePlacement.promise
      },
      { timeout: 20_000 }
    )
    await placed.promise

    const establishment = new PgWebchatMcpDelegationRepo(prisma).establish(input)
    await expectPending(establishment)
    releasePlacement.release()

    await placement
    expect(await establishment).toBeNull()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
    expect((await prisma.agent.findUnique({ where: { id: AGENT } }))?.daemonId).toBe(OTHER_DAEMON)
  })

  it('lets establish finish first, then movePlacement revokes the newly committed delegation', async () => {
    const { input } = await fixtures()
    const established = barrier()
    const releaseEstablishment = barrier()
    const establishment = prisma.$transaction(
      async (tx) => {
        const delegation = await new PgWebchatMcpDelegationRepo(tx).establish(input)
        established.release()
        await releaseEstablishment.promise
        return delegation
      },
      { timeout: 20_000 }
    )
    await established.promise

    const movement = new PgAgentRepo(prisma).movePlacement(AGENT, DAEMON, OTHER_DAEMON)
    await expectPending(movement)
    releaseEstablishment.release()

    const delegation = (await establishment)!
    expect(await movement).not.toBeNull()
    expect(await new PgWebchatMcpDelegationRepo(prisma).get(delegation.id)).toMatchObject({
      revokedReason: 'agent_placement_changed',
      revokedAt: expect.any(Date)
    })
  })

  it('revokes on a real setPlacement change but not on setPlacement or movePlacement no-ops', async () => {
    const { input } = await fixtures()
    const delegations = new PgWebchatMcpDelegationRepo(prisma)
    const agents = new PgAgentRepo(prisma)
    const delegation = (await delegations.establish(input))!

    await agents.setPlacement(AGENT, DAEMON)
    expect((await delegations.get(delegation.id))?.revokedAt).toBeNull()
    expect(await agents.movePlacement(AGENT, DAEMON, DAEMON)).not.toBeNull()
    expect((await delegations.get(delegation.id))?.revokedAt).toBeNull()

    await agents.setPlacement(AGENT, OTHER_DAEMON)
    expect(await delegations.get(delegation.id)).toMatchObject({
      revokedReason: 'agent_placement_changed',
      revokedAt: expect.any(Date)
    })
  })

  it('revokes every active delegation for the agent in one movePlacement transaction', async () => {
    const { input } = await fixtures()
    await prisma.webchatConversation.create({
      data: {
        id: OTHER_CONVERSATION,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        userId: DEFAULT_OWNER_ID
      }
    })
    const delegations = new PgWebchatMcpDelegationRepo(prisma)
    const first = (await delegations.establish(input))!
    const second = (await delegations.establish({
      ...input,
      conversationId: OTHER_CONVERSATION
    }))!

    expect(await new PgAgentRepo(prisma).movePlacement(AGENT, DAEMON, OTHER_DAEMON)).not.toBeNull()

    for (const id of [first.id, second.id]) {
      expect(await delegations.get(id)).toMatchObject({
        revokedReason: 'agent_placement_changed',
        revokedAt: expect.any(Date)
      })
    }
  })

  it('rolls placement and delegation revocation back together on transaction failure', async () => {
    const { input } = await fixtures()
    const delegations = new PgWebchatMcpDelegationRepo(prisma)
    const delegation = (await delegations.establish(input))!

    await expect(
      prisma.$transaction(async (tx) => {
        await new PgAgentRepo(tx).setPlacement(AGENT, OTHER_DAEMON)
        throw new Error('forced placement rollback')
      })
    ).rejects.toThrow('forced placement rollback')

    expect((await prisma.agent.findUnique({ where: { id: AGENT } }))?.daemonId).toBe(DAEMON)
    expect(await delegations.get(delegation.id)).toMatchObject({
      daemonId: DAEMON,
      revokedAt: null,
      revokedReason: null
    })
  })
})
