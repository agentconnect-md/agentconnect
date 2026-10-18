import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgAhpSessionBindingRepo } from '../../src/persistence/repositories/ahp-session-binding.repo.js'
import { PgWebchatConversationRepo } from '../../src/persistence/repositories/webchat-conversation.repo.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEF_ORG, seedAgent, seedDaemon, seedDutyGroup } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

async function fixture() {
  const daemonId = randomUUID()
  const agentId = randomUUID()
  await seedDaemon(prisma, daemonId)
  await seedAgent(prisma, agentId, { daemonId })
  const input = {
    orgId: DEF_ORG,
    agentId,
    userId: DEFAULT_OWNER_ID,
    sessionUri: 'ahp-session:/client-chosen',
    operationId: randomUUID(),
    writer: { daemonId }
  }
  return { input, repo: new PgAhpSessionBindingRepo(prisma) }
}

async function reserved(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.repo.reserve(f.input)
  if (!result.ok) throw new Error(result.reason)
  return result.binding
}

function finalizeInput(f: Awaited<ReturnType<typeof fixture>>, reservationId: string, sessionId = randomUUID()) {
  return { ...f.input, reservationId, sessionId }
}

describe('AHP session registry (real Postgres)', () => {
  it('arbitrates an org-wide URI race across agents without leaking the winning binding', async () => {
    const a = await fixture()
    const b = await fixture()
    const results = await Promise.all([a.repo.reserve(a.input), b.repo.reserve(b.input)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'collision' })
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect(await prisma.webchatConversationAgent.count()).toBe(1)
    expect(await prisma.ahpSessionBinding.count()).toBe(1)
  })

  it('retries one internal operation through separate repositories without allocating another conversation', async () => {
    const f = await fixture()
    const peer = new PgAhpSessionBindingRepo(prisma)
    const [first, second] = await Promise.all([f.repo.reserve(f.input), peer.reserve(f.input)])
    expect(first).toEqual(second)
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect(await peer.reserve({ ...f.input, sessionUri: 'ahp-session:/different' })).toEqual({
      ok: false,
      reason: 'conflict'
    })
    expect(await peer.reserve({ ...f.input, operationId: randomUUID() })).toEqual({ ok: false, reason: 'collision' })
  })

  it('keeps an interrupted reservation occupied and invisible to discovery', async () => {
    const f = await fixture()
    const binding = await reserved(f)
    await prisma.ahpSessionBinding.update({
      where: { reservationId: binding.reservationId },
      data: { createdAt: new Date(0) }
    })
    expect(await f.repo.listOwned({ ...f.input, limit: 10 })).toEqual([])
    expect(await f.repo.reserve({ ...f.input, operationId: randomUUID() })).toEqual({ ok: false, reason: 'collision' })
    expect((await f.repo.get(f.input.orgId, f.input.sessionUri))?.conversationId).toBe(binding.conversationId)
  })

  it('finalizes once, tolerates a lost success reply, and never rebinds a different outward identity', async () => {
    const f = await fixture()
    const binding = await reserved(f)
    const input = finalizeInput(f, binding.reservationId)
    const first = await f.repo.finalize(input)
    expect(first.ok).toBe(true)
    expect(await new PgAhpSessionBindingRepo(prisma).finalize(input)).toEqual(first)
    expect(await f.repo.finalize({ ...input, sessionId: randomUUID() })).toEqual({ ok: false, reason: 'conflict' })
    expect(await f.repo.finalize({ ...input, reservationId: randomUUID() })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(await f.repo.listOwned({ ...f.input, limit: 10 })).toMatchObject([{ sessionId: input.sessionId }])
    expect(await f.repo.listOwned({ ...f.input, userId: 'another-user', limit: 10 })).toEqual([])
    expect(await f.repo.get('other-org', f.input.sessionUri)).toBeNull()
  })

  it('preserves the Webchat ownership row and empty roster slot before the first turn', async () => {
    const f = await fixture()
    const binding = await reserved(f)
    await f.repo.finalize(finalizeInput(f, binding.reservationId))
    const conversations = new PgWebchatConversationRepo(prisma)
    expect(await conversations.resumeBinding(binding.conversationId, OrgId(f.input.orgId))).toEqual({
      primaryAgentId: f.input.agentId,
      ownerUserId: DEFAULT_OWNER_ID,
      currentSessionIds: [null]
    })
    expect(await conversations.ownedBy(binding.conversationId, OrgId(f.input.orgId), 'another-user')).toBeNull()
  })

  it('rejects stale placement and prevents two reservations from claiming one outward ID', async () => {
    const f = await fixture()
    const binding = await reserved(f)
    const input = finalizeInput(f, binding.reservationId)
    expect(await f.repo.finalize({ ...input, writer: { daemonId: randomUUID() } })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    await f.repo.finalize(input)
    const second = await f.repo.reserve({ ...f.input, sessionUri: 'ahp-session:/other', operationId: randomUUID() })
    if (!second.ok) throw new Error(second.reason)
    expect(await f.repo.finalize({ ...input, reservationId: second.binding.reservationId })).toEqual({
      ok: false,
      reason: 'conflict'
    })
    await prisma.agent.update({ where: { id: f.input.agentId }, data: { daemonId: null } })
    expect(await f.repo.finalize(input)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('reuses only the authorized existing browser conversation', async () => {
    const f = await fixture()
    const conversationId = randomUUID()
    await new PgWebchatConversationRepo(prisma).create({
      conversationId,
      orgId: OrgId(f.input.orgId),
      agentId: AgentId(f.input.agentId),
      userId: DEFAULT_OWNER_ID
    })
    const result = await f.repo.reserve({ ...f.input, conversationId })
    expect(result).toMatchObject({ ok: true, binding: { conversationId } })
    expect(await prisma.webchatConversation.count()).toBe(1)
    expect(await f.repo.forConversation(f.input.orgId, f.input.agentId, conversationId)).toMatchObject({
      conversationId
    })
    const foreign = await f.repo.reserve({
      ...f.input,
      sessionUri: 'ahp-session:/foreign',
      operationId: randomUUID(),
      conversationId: randomUUID()
    })
    expect(foreign).toEqual({ ok: false, reason: 'unavailable' })
    expect(await prisma.webchatConversation.count()).toBe(1)
  })

  it('fences member-set writes by current lease term and database expiry', async () => {
    const f = await fixture()
    const setId = randomUUID()
    const groupId = randomUUID()
    await prisma.memberSet.create({ data: { id: setId, orgId: DEF_ORG, name: 'AHP group' } })
    await prisma.memberSetMember.create({ data: { setId, daemonId: f.input.writer.daemonId } })
    await prisma.agent.update({ where: { id: f.input.agentId }, data: { placementKind: 'set', setId, daemonId: null } })
    await seedDutyGroup(prisma, groupId, f.input.writer.daemonId, [f.input.agentId], { term: 2n })
    const writer = { ...f.input.writer, duty: { groupId, term: 2 } }
    expect(await f.repo.reserve(f.input)).toEqual({ ok: false, reason: 'unavailable' })
    const result = await f.repo.reserve({ ...f.input, writer })
    if (!result.ok) throw new Error(result.reason)
    const input = { ...finalizeInput(f, result.binding.reservationId), writer }
    expect(await f.repo.finalize({ ...input, writer: { ...writer, duty: { groupId, term: 1 } } })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    await prisma.dutyGroup.update({ where: { id: groupId }, data: { expiresAt: new Date(0) } })
    expect(await f.repo.finalize(input)).toEqual({ ok: false, reason: 'unavailable' })
    expect((await f.repo.get(DEF_ORG, f.input.sessionUri))?.sessionId).toBeNull()
  })
})
