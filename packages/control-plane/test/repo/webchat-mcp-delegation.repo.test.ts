import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'
const AGENT = 'a1111111-1111-4111-8111-111111111111'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON = 'd2222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-07-30T00:00:00.000Z')

const at = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds)

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

describe('PgWebchatMcpDelegationRepo (real Postgres)', () => {
  it('serializes concurrent establishment so reconnects reuse one generation', async () => {
    await fixtures()
    const repo = new PgWebchatMcpDelegationRepo(prisma)

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
    const repo = new PgWebchatMcpDelegationRepo(prisma)
    const first = await repo.establish(establishInput(DAEMON, at(1_000)))

    const rotated = await repo.establish({ ...establishInput(DAEMON, at(120_000)), now: at(1_000) })

    expect(rotated).toMatchObject({ generation: 2, daemonId: DAEMON })
    expect(await repo.get(first!.id)).toMatchObject({
      revokedAt: at(1_000),
      revokedReason: 'expired'
    })
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
})
