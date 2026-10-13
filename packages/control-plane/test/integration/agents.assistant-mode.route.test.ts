// The assistant mode switch and its admission checks (assistant-mode.md §4.1, §5.1) over the REST surface and real Postgres.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentUpsert, IntegrationSpec } from '@agentconnect.md/protocol'
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
const ON = { enabled: true }

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records the spec pushes the routes make. */
class SpyControl {
  readonly upserts: AgentUpsert[] = []
  readonly integrations: IntegrationSpec[] = []
  async agentUpsert(_daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationUpsert(_daemonId: string, spec: IntegrationSpec): Promise<void> {
    this.integrations.push(spec)
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

  // #2979 B7: the switch keys places on one session and gates nothing; the Off row stays Off.
  it("re-projects the agent's integrations as it switches, never gating them or rewriting the stored rows", async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, runtime: 'claude-acp' })
    const botId = randomUUID()
    await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `bot-${botId}` } })
    await prisma.botSecret.create({ data: { botId, botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' } })
    const integrationId = randomUUID()
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'acme-bot' }
    })
    const stored = [
      { channelId: 'C1', kind: 'channel', trigger: 'mention', sessionMode: 'createNew' },
      { channelId: 'C2', kind: 'channel', trigger: 'off', sessionMode: 'createNew' },
      { channelId: 'D1', kind: 'im', trigger: 'any', sessionMode: 'createNew' },
      { channelId: 'G1', kind: 'mpim', trigger: 'mention', sessionMode: 'createNew' }
    ] as const
    await prisma.integrationChannel.createMany({
      data: stored.map((row) => ({ integrationId, name: row.channelId.toLowerCase(), ...row }))
    })
    const rows = () =>
      prisma.integrationChannel.findMany({
        where: { integrationId },
        orderBy: { channelId: 'asc' },
        select: { channelId: true, kind: true, trigger: true, sessionMode: true }
      })
    const byChannel = <T extends { channel?: string }>(list: readonly T[]) =>
      [...list].sort((a, b) => (a.channel ?? '').localeCompare(b.channel ?? ''))
    const { app, spy } = withSpy()

    const on = await patch(app, agentId, { assistantMode: ON })
    expect(on.statusCode, on.body).toBe(200)
    const projected = spy.integrations.at(-1)!
    expect(projected.integrationId).toBe(integrationId)
    // The Everyone defaults still answer every conversation; the Off nobody chose stays muted and keeps its notice.
    expect(projected.core.gated).toBe(false)
    expect(projected.core.mutedChannels).toEqual(['C2'])
    expect(projected.core.pendingChannels).toEqual(['C2'])
    expect(projected.core.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
    // One session per room and Slack DM; a group DM keeps the platform's own keying, listed so no default overrides it.
    expect(byChannel(projected.core.sessionModes)).toEqual([
      { channel: 'C1', mode: 'append' },
      { channel: 'C2', mode: 'append' },
      { channel: 'D1', mode: 'append' },
      { channel: 'G1', mode: 'createNew' }
    ])
    expect(await rows()).toEqual(stored)

    // An edit that leaves the mode alone projects nothing new.
    const pushed = spy.integrations.length
    expect((await patch(app, agentId, { description: 'Helps the team.' })).statusCode).toBe(200)
    expect(spy.integrations).toHaveLength(pushed)

    const off = await patch(app, agentId, { assistantMode: { enabled: false } })
    expect(off.statusCode, off.body).toBe(200)
    const open = spy.integrations.at(-1)!
    expect(spy.integrations).toHaveLength(pushed + 1)
    expect(open.core.gated).toBe(false)
    expect(open.core.sessionModes).toEqual([])
    expect(open.core.mutedChannels).toEqual(['C2'])
    expect(open.core.pendingChannels).toEqual(['C2'])
    expect(await rows()).toEqual(stored)
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

  // assistant-mode.md §1.8: background work nobody watches should not stop for approval, so turning on defaults the mode.
  it("moves an asking permission mode to the runtime's auto mode as it turns on, and keeps later choices", async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId: DAEMON,
      runtime: 'claude-acp',
      runtimeOverrides: { permissionMode: 'default', chatActions: 'talk', model: 'sonnet' }
    })
    const { app, spy } = withSpy()
    const overrides = async () =>
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).runtimeOverrides as Record<string, unknown>

    const on = await patch(app, agentId, { assistantMode: ON })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json()).toMatchObject({ assistantMode: ON, permissionMode: 'auto' })
    expect(await overrides()).toEqual({ permissionMode: 'auto', chatActions: 'talk', model: 'sonnet' })
    expect(spy.upserts.at(-1)?.spec).toMatchObject({ permissionMode: 'auto', assistantMode: ON })

    // The editor's later choice sticks while the mode stays on.
    expect((await patch(app, agentId, { permissionMode: 'default' })).json()).toMatchObject({
      permissionMode: 'default'
    })
    const edited = await patch(app, agentId, { assistantMode: { ...ON, instructions: 'Keep it short.' } })
    expect(edited.json()).toMatchObject({ permissionMode: 'default' })

    // Switching off keeps the mode; switching on again defaults it again.
    expect((await patch(app, agentId, { assistantMode: { enabled: false } })).json()).toMatchObject({
      permissionMode: 'default'
    })
    expect((await patch(app, agentId, { assistantMode: ON })).json()).toMatchObject({ permissionMode: 'auto' })
  })

  it('keeps an unattended mode and a mode set in the same edit, and defaults an unset one', async () => {
    const { app } = withSpy()
    const seeded = async (runtimeOverrides?: Record<string, unknown>) => {
      const id = randomUUID()
      await seedAgent(prisma, id, { runtime: 'claude-acp', ...(runtimeOverrides ? { runtimeOverrides } : {}) })
      return id
    }

    const fullAccess = await seeded({ permissionMode: 'bypassPermissions' })
    expect((await patch(app, fullAccess, { assistantMode: ON })).json()).toMatchObject({
      permissionMode: 'bypassPermissions'
    })
    const denies = await seeded({ permissionMode: 'dontAsk' })
    expect((await patch(app, denies, { assistantMode: ON })).json()).toMatchObject({ permissionMode: 'dontAsk' })
    const chosen = await seeded({ permissionMode: 'plan' })
    expect((await patch(app, chosen, { assistantMode: ON, permissionMode: 'acceptEdits' })).json()).toMatchObject({
      permissionMode: 'acceptEdits'
    })
    const unset = await seeded()
    const unsetOn = await patch(app, unset, { assistantMode: ON })
    expect(unsetOn.statusCode, unsetOn.body).toBe(200)
    expect(unsetOn.json()).toMatchObject({ permissionMode: 'auto' })

    // A refused switch changes nothing.
    const codex = randomUUID()
    await seedAgent(prisma, codex, { runtime: 'codex-acp', runtimeOverrides: { permissionMode: 'read-only' } })
    expect((await patch(app, codex, { assistantMode: ON })).statusCode).toBe(409)
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: codex } })).runtimeOverrides as object).toEqual({
      permissionMode: 'read-only'
    })
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

  it('takes no routing target, and names the responsible user it derives', async () => {
    const creator = await prisma.user.create({ data: { email: `creator-${randomUUID()}@example.test` } })
    await prisma.membership.create({ data: { orgId: DEFAULT_ORG_ID, userId: creator.id, role: 'collaborator' } })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { runtime: 'claude-acp', createdByUserId: creator.id })
    const { app } = withSpy()
    const responsible = async () =>
      (await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/assistant-mode/responsible-user` })).json()

    const on = await patch(app, agentId, { assistantMode: { enabled: true } })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json()).toMatchObject({ assistantMode: { enabled: true } })
    expect(
      (await patch(app, agentId, { assistantMode: { enabled: true, responsibleUserId: DEFAULT_OWNER_ID } })).statusCode
    ).toBe(400)
    const fallbackConversation = { integrationId: randomUUID(), channelId: 'C-EXAMPLE' }
    expect((await patch(app, agentId, { assistantMode: { enabled: true, fallbackConversation } })).statusCode).toBe(400)

    expect(await responsible()).toEqual({ userId: creator.id })
    // A creator who may no longer edit hands over to the editor who joined first, here the organization's owner.
    await prisma.membership.updateMany({
      where: { orgId: DEFAULT_ORG_ID, userId: creator.id },
      data: { role: 'viewer' }
    })
    expect(await responsible()).toEqual({ userId: DEFAULT_OWNER_ID })
    await prisma.membership.deleteMany({ where: { orgId: DEFAULT_ORG_ID, userId: creator.id } })
    expect(await responsible()).toEqual({ userId: DEFAULT_OWNER_ID })
  })

  // Expand step (assistant-mode.md §5.1): an older Control Plane's stored keys are read past, served without, and projected unchanged.
  it('reads a policy that still carries the stored routing keys, without serving or rewriting them', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, runtime: 'claude-acp' })
    const fallbackConversation = { integrationId: randomUUID(), channelId: 'C-EXAMPLE' }
    const stored = {
      enabled: true,
      responsibleUserId: DEFAULT_OWNER_ID,
      fallbackConversation,
      instructions: 'Be brief.'
    }
    await prisma.agent.update({ where: { id: agentId }, data: { assistantMode: stored, configRevision: 3n } })
    const { app, spy } = withSpy()

    const read = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().assistantMode).toEqual({ enabled: true, instructions: 'Be brief.' })

    // An unrelated edit leaves the row as it was and projects it unchanged, so a daemon that still requires a key validates it.
    const edited = await patch(app, agentId, { description: 'Helps the team.' })
    expect(edited.json().assistantMode).toEqual({ enabled: true, instructions: 'Be brief.' })
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).assistantMode).toEqual(stored)
    expect(spy.upserts.at(-1)?.spec.assistantMode).toEqual(stored)

    // A new write never carries them.
    await patch(app, agentId, { assistantMode: { enabled: true } })
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).assistantMode).toEqual({ enabled: true })
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
