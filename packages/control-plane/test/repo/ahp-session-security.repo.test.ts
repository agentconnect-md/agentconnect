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
  it('registers historical metadata once across readers without creating another outward identity', async () => {
    const f = await fixture()
    const sessionId = randomUUID()
    await seedSessionMeta(prisma, sessionId, f.input.agentId, { platform: 'slack', daemonId: f.input.writer.daemonId })
    const input = { ...f.input, sessionId, sessionUri: `ahp-session:/session/${sessionId}` }
    const [a, b] = await Promise.all([
      f.repo.registerExisting(input),
      new PgAhpSessionBindingRepo(prisma).registerExisting(input)
    ])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ ok: true, binding: { sessionId } })
    expect(await prisma.sessionMeta.count()).toBe(1)
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect((await prisma.webchatConversation.findFirst())?.targetSessionId).toBe(sessionId)
    await prisma.sessionMeta.update({ where: { id: sessionId }, data: { contentPurgedAt: new Date() } })
    expect(await f.repo.registerExisting(input)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('registers only current native history against its original owner rather than the discovering member', async () => {
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
    const retiredId = randomUUID()
    await seedSessionMeta(prisma, retiredId, f.input.agentId, { platform: 'webchat', channel: conversationId })
    expect(await f.repo.registerExisting({ ...f.input, sessionId: retiredId })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    const result = await f.repo.registerExisting({
      ...f.input,
      userId: 'authorized-observer',
      sessionId,
      sessionUri: `ahp-session:/session/${sessionId}`
    })
    expect(result).toMatchObject({ ok: true, binding: { userId: DEFAULT_OWNER_ID, conversationId, sessionId } })
    expect(await prisma.webchatConversation.count()).toBe(1)
  })

  it('pages metadata and finalized slots once, omitting pending and foreign-agent candidates', async () => {
    const f = await fixture()
    const peer = await fixture()
    const native = await f.repo.reserve(f.input)
    if (!native.ok) throw new Error(native.reason)
    await f.repo.finalize({ ...f.input, reservationId: native.binding.reservationId, sessionId: 'b-empty' })
    await seedSessionMeta(prisma, 'a-history', f.input.agentId, { platform: 'slack' })
    await seedSessionMeta(prisma, 'b-empty', f.input.agentId, { platform: 'webchat' })
    await seedSessionMeta(prisma, 'c-peer', peer.input.agentId, { platform: 'slack' })
    await peer.repo.reserve({ ...peer.input, sessionUri: 'ahp-session:/pending' })
    expect(await f.repo.listCandidates({ ...f.input, limit: 1 })).toEqual(['a-history'])
    expect(await f.repo.listCandidates({ ...f.input, after: 'a-history', limit: 100 })).toEqual(['b-empty'])
    expect(await f.repo.listCandidates({ ...f.input, orgId: 'foreign', limit: 100 })).toEqual([])
  })

  it('skips an occupied history URI without creating a continuation row', async () => {
    const f = await fixture()
    await f.repo.reserve(f.input)
    const sessionId = randomUUID()
    await seedSessionMeta(prisma, sessionId, f.input.agentId, { platform: 'slack' })
    expect(await f.repo.registerExisting({ ...f.input, sessionId, operationId: randomUUID() })).toEqual({
      ok: false,
      reason: 'collision'
    })
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect(await prisma.ahpSessionBinding.count()).toBe(1)
  })
  it('converges concurrent browser binding and history discovery on the original native slot', async () => {
    const f = await fixture()
    const conversationId = randomUUID()
    const sessionId = randomUUID()
    await new PgWebchatConversationRepo(prisma).create({
      conversationId,
      orgId: DEF_ORG,
      agentId: AgentId(f.input.agentId),
      userId: DEFAULT_OWNER_ID
    })
    await seedSessionMeta(prisma, sessionId, f.input.agentId, { platform: 'webchat', channel: conversationId })
    await prisma.webchatConversationAgent.updateMany({
      where: { conversationId },
      data: { currentSessionId: sessionId }
    })
    const [browser, catalog] = await Promise.all([
      f.repo.reserve({
        ...f.input,
        conversationId,
        sessionUri: `ahp-session:/webchat/${conversationId}/${f.input.agentId}`
      }),
      new PgAhpSessionBindingRepo(prisma).registerExisting({
        ...f.input,
        operationId: randomUUID(),
        sessionId,
        sessionUri: `ahp-session:/session/${sessionId}`
      }),
      prisma.$transaction(async (tx) => {
        // Native milestone lock order: conversation, metadata, then the reporting roster pointer.
        await tx.webchatConversation.update({ where: { id: conversationId }, data: { currentSessionId: sessionId } })
        await tx.sessionMeta.update({ where: { id: sessionId }, data: { title: 'Current session' } })
        await tx.webchatConversationAgent.updateMany({
          where: { conversationId },
          data: { currentSessionId: sessionId }
        })
      })
    ])
    expect(browser).toEqual(catalog)
    expect(browser).toMatchObject({ ok: true, binding: { conversationId, sessionId, userId: DEFAULT_OWNER_ID } })
    expect(await prisma.ahpSessionBinding.count()).toBe(1)
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect(await prisma.sessionMeta.count()).toBe(1)
  })
})
