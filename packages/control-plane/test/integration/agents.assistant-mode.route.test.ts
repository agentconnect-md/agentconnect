// The assistant mode switch and its admission checks (assistant-mode.md §4.1, §5.1) over the REST surface and real Postgres.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { ASSISTANT_MODE_NOT_ADMITTED } from '../../src/agents/assistant-mode.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-ddddddddd0b1'
const MEMBER_A = 'd0d0d0d0-dddd-4ddd-8ddd-ddddddddd0b2'
const MEMBER_B = 'd0d0d0d0-dddd-4ddd-8ddd-ddddddddd0b3'
const STORE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a01'
const OTHER_STORE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a02'
const ON = { enabled: true, responsibleUserId: DEFAULT_OWNER_ID }

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records the spec pushes the routes make. */
class SpyControl {
  readonly upserts: AgentUpsert[] = []
  async agentUpsert(_daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async agentRemove(): Promise<void> {}
  async collaborationRoutes(): Promise<void> {}
}

function withSpy(): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  return { app, spy }
}

const patch = (app: HttpApp, agentId: string, payload: Record<string, unknown>) =>
  app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload })
const admission = (app: HttpApp, agentId: string) =>
  app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/assistant-mode/admission` })

/** A daemon group whose members report these stores (null ⇒ a private store). */
async function seedGroup(stores: Array<string | null>): Promise<string> {
  const setId = randomUUID()
  await prisma.memberSet.create({ data: { id: setId, orgId: DEFAULT_ORG_ID, name: `group-${setId}` } })
  for (const [i, store] of stores.entries()) {
    const id = [MEMBER_A, MEMBER_B][i]!
    await seedDaemon(prisma, id)
    const row = await prisma.daemon.findUniqueOrThrow({ where: { id }, select: { capabilities: true } })
    await prisma.daemon.update({
      where: { id },
      data: { capabilities: { ...(row.capabilities as object), ...(store ? { contentStore: store } : {}) } }
    })
    await prisma.memberSetMember.create({ data: { setId, daemonId: id } })
  }
  return setId
}

describe('assistant mode', () => {
  it('switches on for an admitted agent, persists, replicates, and switches off', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, runtime: 'claude-acp' })
    const { app, spy } = withSpy()

    expect((await admission(app, agentId)).json()).toEqual({ admitted: true, refusals: [] })
    const policy = { ...ON, limits: { maxConcurrentSubsessions: 3, permissionWaitHours: 24 } }
    const on = await patch(app, agentId, { assistantMode: policy })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json()).toMatchObject({ assistantMode: policy })
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).assistantMode).toEqual(policy)
    expect(spy.upserts.at(-1)?.spec).toMatchObject({ assistantMode: policy })

    // An unrelated edit keeps it.
    expect((await patch(app, agentId, { description: 'Helps the team.' })).json()).toMatchObject({
      assistantMode: policy
    })

    const off = await patch(app, agentId, { assistantMode: null })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ assistantMode: null })
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).assistantMode).toBeNull()
    expect(spy.upserts.at(-1)?.spec).toHaveProperty('assistantMode', null)
  })

  it('refuses an unlisted runtime and external memory with their reasons', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      runtime: 'codex-acp',
      runtimeOverrides: { memory: { provider: 'native' } }
    })
    const { app } = withSpy()
    expect((await admission(app, agentId)).json()).toEqual({
      admitted: false,
      refusals: ['runtime-not-admitted', 'memory-provider']
    })
    const refused = await patch(app, agentId, { assistantMode: ON })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: ASSISTANT_MODE_NOT_ADMITTED })
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).assistantMode).toBeNull()

    // Fixing both in the same edit admits it.
    const fixed = await patch(app, agentId, { runtime: 'claude-acp', memory: { provider: 'none' }, assistantMode: ON })
    expect(fixed.statusCode, fixed.body).toBe(200)
    expect(fixed.json()).toMatchObject({ assistantMode: ON })
  })

  it('keeps the definition admitted while it is on, but never refuses switching it off', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { runtime: 'claude-acp' })
    const { app } = withSpy()
    expect((await patch(app, agentId, { assistantMode: ON })).statusCode).toBe(200)
    const toCodex = await patch(app, agentId, { runtime: 'codex-acp' })
    expect(toCodex.statusCode).toBe(409)
    expect(toCodex.json()).toMatchObject({ code: ASSISTANT_MODE_NOT_ADMITTED })
    const toNative = await patch(app, agentId, { memory: { provider: 'native' } })
    expect(toNative.statusCode).toBe(409)
    const offAndSwitch = await patch(app, agentId, { runtime: 'codex-acp', assistantMode: { enabled: false } })
    expect(offAndSwitch.statusCode, offAndSwitch.body).toBe(200)
    expect(offAndSwitch.json()).toMatchObject({ runtime: 'codex-acp', assistantMode: { enabled: false } })
  })

  it('needs a responsible user or fallback conversation that belongs here', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { runtime: 'claude-acp' })
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { runtime: 'claude-acp' })
    const botId = randomUUID()
    await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `bot-${botId}` } })
    const own = randomUUID()
    const foreign = randomUUID()
    await prisma.integration.createMany({
      data: [
        { id: own, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'own' },
        { id: foreign, orgId: DEFAULT_ORG_ID, agentId: otherAgent, botId, platform: 'slack', name: 'foreign' }
      ]
    })
    const { app } = withSpy()

    expect((await patch(app, agentId, { assistantMode: { enabled: true } })).statusCode).toBe(400)
    expect(
      (await patch(app, agentId, { assistantMode: { enabled: true, responsibleUserId: 'usr_absent' } })).statusCode
    ).toBe(400)
    const foreignConversation = await patch(app, agentId, {
      assistantMode: { enabled: true, fallbackConversation: { integrationId: foreign, channelId: 'C1' } }
    })
    expect(foreignConversation.statusCode).toBe(400)
    const ownConversation = await patch(app, agentId, {
      assistantMode: { enabled: true, fallbackConversation: { integrationId: own, channelId: 'C1' } }
    })
    expect(ownConversation.statusCode, ownConversation.body).toBe(200)

    // The saved targets disappear; the console still sends them back when it switches the mode off.
    await prisma.integration.delete({ where: { id: own } })
    const offWithStaleTargets = await patch(app, agentId, {
      assistantMode: {
        enabled: false,
        responsibleUserId: 'usr_absent',
        fallbackConversation: { integrationId: own, channelId: 'C1' }
      }
    })
    expect(offWithStaleTargets.statusCode, offWithStaleTargets.body).toBe(200)
    expect(offWithStaleTargets.json()).toMatchObject({ assistantMode: { enabled: false } })
  })

  it('requires every member of a daemon group to share one store', async () => {
    const split = await seedGroup([STORE, OTHER_STORE])
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { runtime: 'claude-acp', setId: split })
    const { app } = withSpy()
    expect((await admission(app, agentId)).json()).toEqual({ admitted: false, refusals: ['store-not-shared'] })
    expect((await patch(app, agentId, { assistantMode: ON })).statusCode).toBe(409)

    await prisma.daemon.update({
      where: { id: MEMBER_B },
      data: {
        capabilities: {
          ...((await prisma.daemon.findUniqueOrThrow({ where: { id: MEMBER_B } })).capabilities as object),
          contentStore: STORE
        }
      }
    })
    expect((await admission(app, agentId)).json()).toEqual({ admitted: true, refusals: [] })
    expect((await patch(app, agentId, { assistantMode: ON })).statusCode).toBe(200)
  })

  it('refuses a group with a member on a private store', async () => {
    const mixed = await seedGroup([STORE, null])
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { runtime: 'claude-acp', setId: mixed })
    const { app } = withSpy()
    expect((await admission(app, agentId)).json()).toEqual({ admitted: false, refusals: ['store-not-shared'] })
  })
})
