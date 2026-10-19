import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgAhpSessionBindingRepo } from '../../src/persistence/repositories/ahp-session-binding.repo.js'
import { PgWebchatConversationRepo } from '../../src/persistence/repositories/webchat-conversation.repo.js'
import { AgentId } from '../../src/domain/ids.js'
import { DEF_ORG, seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

async function fixture() {
  const daemonId = randomUUID()
  const agentId = randomUUID()
  await seedDaemon(prisma, daemonId)
  await seedAgent(prisma, agentId, { daemonId })
  return {
    input: {
      orgId: DEF_ORG,
      agentId,
      userId: DEFAULT_OWNER_ID,
      sessionUri: 'ahp-session:/client-chosen',
      operationId: randomUUID(),
      writer: { daemonId }
    },
    repo: new PgAhpSessionBindingRepo(prisma)
  }
}

describe('AHP durable identity security (real Postgres)', () => {
  it('retains a URI tombstone after its conversation is deleted', async () => {
    const f = await fixture()
    const result = await f.repo.reserve(f.input)
    if (!result.ok) throw new Error(result.reason)
    await prisma.webchatConversation.delete({ where: { id: result.binding.conversationId } })
    expect(await f.repo.get(f.input.orgId, f.input.sessionUri)).toEqual(result.binding)
    expect(await f.repo.reserve({ ...f.input, operationId: randomUUID() })).toEqual({ ok: false, reason: 'collision' })
    expect(await prisma.webchatConversation.count()).toBe(0)
  })

  it('lazily binds a shared native conversation to its existing owner and outward session', async () => {
    const f = await fixture()
    const conversationId = randomUUID()
    const sessionId = randomUUID()
    await new PgWebchatConversationRepo(prisma).create({
      conversationId,
      orgId: DEF_ORG,
      agentId: AgentId(f.input.agentId),
      userId: DEFAULT_OWNER_ID
    })
    await seedSessionMeta(prisma, sessionId, f.input.agentId, {
      platform: 'webchat',
      channel: conversationId,
      daemonId: f.input.writer.daemonId
    })
    await prisma.webchatConversationAgent.updateMany({
      where: { conversationId },
      data: { currentSessionId: sessionId }
    })
    const result = await f.repo.reserve({ ...f.input, conversationId, userId: 'authorized-non-owner' })
    expect(result).toMatchObject({ ok: true, binding: { userId: DEFAULT_OWNER_ID, conversationId, sessionId } })
    expect(await f.repo.reserve({ ...f.input, conversationId, userId: 'another-authorized-resumer' })).toEqual(result)
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect(await prisma.sessionMeta.count()).toBe(1)
  })
})
