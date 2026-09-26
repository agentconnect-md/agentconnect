/**
 * By decision configuration end to end on the CP (decisions.md §6.2, §6.3, §7.1): the channel
 * PATCH, the trigger/binding invariant in the database, sibling replication, the Decision edit
 * that marks gates Needs review, delete-while-used, usage lists, and the capability hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DECISION_CHAIN_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  OWNER_DEFAULT_DECISION_V1_FEATURE,
  type DecisionDraft,
  type IntegrationUpsert,
  type IntegrationRemove,
  type RcBotAssign,
  type RelayCpFrameType
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { PgIntegrationChannelRepo } from '../../src/persistence/index.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { IntegrationId, OrgId } from '../../src/domain/ids.js'
import { PgDecisionRepo } from '../../src/persistence/repositories/decision.repo.js'
import { DecisionInUse } from '../../src/persistence/errors.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OLD_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'

class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  features: string[] = [DECISION_TRIGGER_V1_FEATURE]
  perDaemon: Record<string, string[]> = {}
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
  daemonFeatures(daemonId: string): readonly string[] {
    return this.perDaemon[daemonId] ?? this.features
  }
}

class FakeRelay implements RelayChannel {
  sends: { type: RelayCpFrameType; payload: unknown }[] = []
  constructor(
    readonly relayId: string,
    readonly features: readonly string[]
  ) {}
  send(type: RelayCpFrameType, payload: unknown): void {
    this.sends.push({ type, payload })
  }
  close(): void {}
}

const boolDraft: DecisionDraft = {
  name: 'Needs help',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: { type: 'boolean', instructions: 'Is help needed?', criteria: { true: 'Yes', false: 'No' } }
}
const scoreDraft: DecisionDraft = {
  ...boolDraft,
  name: 'Urgency',
  question: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high', 'critical'] }
}
const choiceDraft: DecisionDraft = {
  ...boolDraft,
  name: 'Topic',
  question: { type: 'choice', instructions: 'Which topic?', criteria: { billing: 'Money', tech: 'Code' } }
}

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

function appWith(
  daemonFeatures: string[] = [DECISION_TRIGGER_V1_FEATURE],
  userId?: string,
  perDaemon: Record<string, string[]> = {}
) {
  const spy = new SpyControl()
  spy.features = daemonFeatures
  spy.perDaemon = perDaemon
  const liveness = {
    get: (daemonId: string) => ({
      state: 'READY',
      capabilities: { features: perDaemon[daemonId] ?? daemonFeatures }
    })
  }
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test', ...(userId ? { DEFAULT_OWNER_ID: userId } : {}) },
    liveness as never,
    spy as unknown as ControlSender
  )
  running.push(app)
  return { app, spy }
}

async function seedInstall(
  opts: { transport?: 'socket' | 'http'; agents?: number; daemons?: string[]; platform?: string } = {}
) {
  const platform = opts.platform ?? 'slack'
  for (const daemonId of new Set([DAEMON, ...(opts.daemons ?? [])])) {
    const exists = await prisma.daemon.findUnique({ where: { id: daemonId } })
    if (!exists) await seedDaemon(prisma, daemonId)
  }
  const botId = randomUUID()
  await prisma.bot.create({
    data: {
      id: botId,
      orgId: DEFAULT_ORG_ID,
      platform,
      name: `bot-${botId}`,
      ...(opts.transport === 'http' ? { transport: 'http' as const, shareable: true } : {})
    }
  })
  await prisma.botSecret.create({
    data: { botId, botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' }
  })
  const installs: Array<{ agentId: string; integrationId: string }> = []
  for (let n = 0; n < (opts.agents ?? 1); n += 1) {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: opts.daemons?.[n] ?? DAEMON })
    const integrationId = randomUUID()
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform, name: 'b' }
    })
    installs.push({ agentId, integrationId })
  }
  const first = installs[0]!
  await prisma.integrationChannel.createMany({
    data: [
      {
        integrationId: first.integrationId,
        channelId: 'C1',
        name: 'general',
        trigger: 'mention',
        agentId: first.agentId
      },
      { integrationId: first.integrationId, channelId: 'D1', name: 'alice', kind: 'im', trigger: 'any' }
    ]
  })
  return { botId, installs, integrationId: first.integrationId, agentId: first.agentId }
}

async function createDecision(app: HttpApp, draft: DecisionDraft = boolDraft): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}

const patchChannel = (app: HttpApp, integrationId: string, channelId: string, payload: Record<string, unknown>) =>
  app.app.inject({ method: 'PATCH', url: `${ORG}/integrations/${integrationId}/channels/${channelId}`, payload })

const gateOf = (decisionId: string, when: unknown = { type: 'boolean', values: [true] }) => ({
  trigger: 'decision',
  decisionBinding: { type: 'gate', decisionId, when }
})

describe('the trigger/binding invariant in the database', () => {
  it('refuses a decision trigger without a binding and clears the binding with any other trigger', async () => {
    const { integrationId } = await seedInstall()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    await expect(
      prisma.$executeRaw`UPDATE "integration_channel" SET "trigger" = 'decision' WHERE "channelId" = 'C1'`
    ).rejects.toThrow()
    const repo = new PgIntegrationChannelRepo(prisma)
    const gate = { type: 'gate' as const, decisionId, when: { type: 'boolean' as const, values: [true] } }
    const bound = await repo.setTrigger(IntegrationId(integrationId), 'C1', {
      trigger: 'decision',
      decisionBinding: gate,
      decisionNeedsReview: false
    })
    expect(bound).toMatchObject({ trigger: 'decision', decisionBinding: gate, decisionDefinition: { id: decisionId } })
    expect(
      (await repo.listForIntegration(IntegrationId(integrationId))).find((c) => c.channelId === 'C1')
    ).toMatchObject({
      decisionDefinition: { id: decisionId, name: boolDraft.name }
    })
    const cleared = await repo.setTrigger(IntegrationId(integrationId), 'C1', { trigger: 'mention' })
    expect(cleared).toMatchObject({ trigger: 'mention', decisionBinding: null, decisionNeedsReview: false })
    expect(await prisma.integrationChannel.findFirst({ where: { channelId: 'C1' } })).toMatchObject({
      decisionId: null,
      decisionBinding: null
    })
  })

  it('clears the binding when a report converts the row to a DM, and on the restricted transition', async () => {
    const { integrationId, agentId } = await seedInstall()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const repo = new PgIntegrationChannelRepo(prisma)
    const gate = { type: 'gate' as const, decisionId, when: { type: 'boolean' as const, values: [true] } }
    await prisma.integrationChannel.create({ data: { integrationId, channelId: 'G1', trigger: 'mention' } })
    for (const channelId of ['C1', 'G1'])
      await repo.setTrigger(IntegrationId(integrationId), channelId, {
        trigger: 'decision',
        decisionBinding: gate,
        decisionNeedsReview: true
      })
    await repo.replaceSnapshot(IntegrationId(integrationId), [{ id: 'C1', kind: 'im' }], { authoritative: false })
    expect(await prisma.integrationChannel.findFirst({ where: { channelId: 'C1' } })).toMatchObject({
      kind: 'im',
      trigger: 'any',
      decisionBinding: null,
      decisionId: null,
      decisionNeedsReview: false
    })
    await repo.replaceSnapshot(IntegrationId(integrationId), [{ id: 'G1', kind: 'mpim' }], { authoritative: false })
    await prisma.integrationChannel.updateMany({
      where: { channelId: 'G1' },
      data: { trigger: 'decision', decisionBinding: gate, decisionId, decisionNeedsReview: false }
    })
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(await prisma.integrationChannel.findFirst({ where: { channelId: 'G1' } })).toMatchObject({
      trigger: 'off',
      decisionBinding: null,
      decisionId: null
    })
  })
})

describe('PATCH /integrations/:id/channels/:channelId with By decision', () => {
  it('sets the gate atomically, returns the consumer, pushes the bundle, and Any clears it', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith()
    const decisionId = await createDecision(app)
    spy.upserts.length = 0
    const res = await patchChannel(app, integrationId, 'C1', gateOf(decisionId))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      trigger: 'decision',
      decisionBinding: { type: 'gate', decisionId },
      decision: { id: decisionId, name: boolDraft.name, enabled: true, readiness: { status: 'ready' } }
    })
    const pushed = spy.upserts.at(-1)!.u
    expect(pushed.core.bindRules).toContainEqual({ channel: 'C1', match: { kind: 'decision' } })
    expect(pushed.core.decisions).toMatchObject({
      bindings: [{ channel: 'C1', enabled: true, consumer: { decisionId } }],
      definitions: [{ id: decisionId, question: boolDraft.question }]
    })
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const channel = (list.json() as Array<{ channels: Array<{ channelId: string }> }>)[0]!.channels.find(
      (c) => c.channelId === 'C1'
    )
    expect(channel).toMatchObject({ trigger: 'decision', decision: { name: boolDraft.name, enabled: true } })

    const cleared = await patchChannel(app, integrationId, 'C1', { trigger: 'any' })
    expect(cleared.json()).toMatchObject({ trigger: 'any', decisionBinding: null, decision: null })
    expect(spy.upserts.at(-1)!.u.core.decisions.bindings).toEqual([])
  })

  it('rejects an invalid binding with 400, an invisible Decision with 404, and a viewer with 403', async () => {
    const { integrationId } = await seedInstall()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const bad = async (payload: Record<string, unknown>, status: number) => {
      const res = await patchChannel(app, integrationId, 'C1', payload)
      expect(res.statusCode, res.body).toBe(status)
      return res.json() as { message: string; issues?: unknown[] }
    }
    await bad({ trigger: 'decision' }, 400)
    await bad({ trigger: 'mention', decisionBinding: gateOf(decisionId).decisionBinding }, 400)
    await bad({ trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } }, 400)
    expect((await patchChannel(app, integrationId, 'D1', gateOf(decisionId))).statusCode).toBe(400)
    const mismatched = await bad(gateOf(decisionId, { type: 'score', min: 0, max: 1 }), 400)
    expect(mismatched.issues).toEqual([expect.objectContaining({ message: 'Condition type must match the question.' })])
    await bad(gateOf(randomUUID()), 404)

    // Another member's restricted Decision, and one from another org, are both invisible.
    const users = new PgUserRepo(prisma)
    const { userId } = await users.provisionOidcUser({ oidcSubject: 'c', email: 'c@example.test', emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, 'c@example.test', 'collaborator')
    const hidden = (
      await appWith([DECISION_TRIGGER_V1_FEATURE], userId).app.app.inject({
        method: 'POST',
        url: `${ORG}/decisions`,
        payload: { ...boolDraft, visibility: 'restricted', sharedWith: [userId] }
      })
    ).json().id as string
    const { userId: viewer } = await users.provisionOidcUser({
      oidcSubject: 'v',
      email: 'v@example.test',
      emailVerified: true
    })
    await users.addMemberByEmail(DEFAULT_ORG_ID, 'v@example.test', 'viewer')
    const asViewer = appWith([DECISION_TRIGGER_V1_FEATURE], viewer).app
    expect((await patchChannel(asViewer, integrationId, 'C1', gateOf(decisionId))).statusCode).toBe(403)
    const asMember = appWith([DECISION_TRIGGER_V1_FEATURE], userId).app
    await prisma.org.create({ data: { id: 'org_other', name: 'Other', slug: 'other' } })
    const foreign = await prisma.decision.create({
      data: { orgId: 'org_other', name: 'x', providerId: 'typesafe', model: 'jev-1.13.0', question: boolDraft.question }
    })
    for (const id of [foreign.id]) {
      const res = await patchChannel(asMember, integrationId, 'C1', gateOf(id))
      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('DECISION_NOT_FOUND')
    }
    expect(hidden).toBeDefined()
    // The owner can view every Decision, so the restricted one is invisible only to a third member.
    const { userId: third } = await users.provisionOidcUser({
      oidcSubject: 't',
      email: 't@example.test',
      emailVerified: true
    })
    await users.addMemberByEmail(DEFAULT_ORG_ID, 't@example.test', 'collaborator')
    const asThird = appWith([DECISION_TRIGGER_V1_FEATURE], third).app
    const invisible = await patchChannel(asThird, integrationId, 'C1', gateOf(hidden))
    expect(invisible.statusCode).toBe(404)
    expect(invisible.json().code).toBe('DECISION_NOT_FOUND')
    expect(await prisma.integrationChannel.findFirst({ where: { channelId: 'C1' } })).toMatchObject({
      trigger: 'mention'
    })
  })

  it('returns 409 when a connected daemon predates decision-trigger-v1 and publishes no Any route', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith([])
    const decisionId = await createDecision(app)
    const res = await patchChannel(app, integrationId, 'C1', gateOf(decisionId))
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().code).toBe('DECISION_UNSUPPORTED_CONSUMER')
    expect(spy.upserts).toHaveLength(0)
    expect(await prisma.integrationChannel.findFirst({ where: { channelId: 'C1' } })).toMatchObject({
      trigger: 'mention'
    })
  })

  it('replicates the gate across shared-bot siblings, holds it for an old relay, and 409s when a relay predates it', async () => {
    const { integrationId, installs, botId } = await seedInstall({ transport: 'http', agents: 2 })
    const { app } = appWith()
    const modern = new FakeRelay(randomUUID(), [DECISION_TRIGGER_V1_FEATURE])
    app.relayReg.add(modern)
    const decisionId = await createDecision(app)
    const res = await patchChannel(app, integrationId, 'C1', gateOf(decisionId))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ decision: { readiness: { status: 'ready' } } })
    const rows = await prisma.integrationChannel.findMany({ where: { channelId: 'C1' } })
    expect(rows.map((r) => r.integrationId).sort()).toEqual(installs.map((i) => i.integrationId).sort())
    for (const row of rows) expect(row).toMatchObject({ trigger: 'decision', decisionId, triggerChosen: true })
    const assign = modern.sends.filter((s) => s.type === 'rc/routes').at(-1)!.payload as RcBotAssign
    expect(assign.routes).toContainEqual(
      expect.objectContaining({ scope: { channel: 'C1' }, match: { kind: 'decision' }, decisionId })
    )

    const legacy = new FakeRelay(randomUUID(), [])
    app.relayReg.add(legacy)
    const refused = await patchChannel(app, integrationId, 'C1', gateOf(decisionId))
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('DECISION_UNSUPPORTED_CONSUMER')
    await app.deps.httpBot.syncRoutes(botId)
    const held = legacy.sends.filter((s) => s.type === 'rc/routes').at(-1)!.payload as RcBotAssign
    expect(
      held.routes.some((r) => r.match.kind === 'decision' || (r.scope?.channel === 'C1' && r.match.kind === 'auto'))
    ).toBe(false)
    expect(held.mutedChannels).toContain('C1')

    const cleared = await patchChannel(app, integrationId, 'C1', { trigger: 'mention' })
    expect(cleared.statusCode).toBe(200)
    for (const row of await prisma.integrationChannel.findMany({ where: { channelId: 'C1' } }))
      expect(row).toMatchObject({ trigger: 'mention', decisionBinding: null })
  })
})

describe('By decision on an owner-as-default platform', () => {
  it("accepts a Linear team gate and compiles the owner's decision route instead of its default seat", async () => {
    const { integrationId, installs, botId } = await seedInstall({ transport: 'http', agents: 2, platform: 'linear' })
    const { app } = appWith()
    const modern = new FakeRelay(randomUUID(), [DECISION_TRIGGER_V1_FEATURE, OWNER_DEFAULT_DECISION_V1_FEATURE])
    app.relayReg.add(modern)
    const decisionId = await createDecision(app)
    const res = await patchChannel(app, integrationId, 'C1', gateOf(decisionId))
    expect(res.statusCode, res.body).toBe(200)
    await app.deps.httpBot.syncRoutes(botId)
    const routes = modern.sends.filter((s) => s.type === 'rc/routes').at(-1)!.payload as RcBotAssign
    expect(routes.routes.filter((r) => r.scope !== undefined)).toEqual([
      expect.objectContaining({
        agentId: installs[0]!.agentId,
        scope: { channel: 'C1' },
        match: { kind: 'decision' },
        decisionId
      })
    ])
    expect(routes.conversationDefaults.some((d) => d.channel === 'C1')).toBe(false)
    expect(routes.mutedChannels).not.toContain('C1')

    // A relay that cannot seat the route as the team default makes the gate unsupported.
    app.relayReg.add(new FakeRelay(randomUUID(), [DECISION_TRIGGER_V1_FEATURE]))
    const refused = await patchChannel(app, integrationId, 'C1', gateOf(decisionId))
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('DECISION_UNSUPPORTED_CONSUMER')
  })
})

describe('readiness of a shared-bot conversation patched through a sibling install', () => {
  async function throughSibling(daemons: string[]) {
    const seeded = await seedInstall({ transport: 'http', agents: 2, daemons })
    const sibling = seeded.installs[1]!
    await prisma.integrationChannel.create({
      data: { integrationId: sibling.integrationId, channelId: 'C1', name: 'general', trigger: 'mention' }
    })
    const { app } = appWith([DECISION_TRIGGER_V1_FEATURE], undefined, { [OLD_DAEMON]: [] })
    app.relayReg.add(new FakeRelay(randomUUID(), [DECISION_TRIGGER_V1_FEATURE]))
    return { app, sibling }
  }

  it("409s when the owner's daemon predates the feature, though the sibling's daemon has it", async () => {
    const { app, sibling } = await throughSibling([OLD_DAEMON, DAEMON])
    const res = await patchChannel(app, sibling.integrationId, 'C1', gateOf(await createDecision(app)))
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().code).toBe('DECISION_UNSUPPORTED_CONSUMER')
    for (const row of await prisma.integrationChannel.findMany({ where: { channelId: 'C1' } }))
      expect(row).toMatchObject({ trigger: 'mention' })
  })

  it("reports the owner's readiness on the PATCH and on every install's list row", async () => {
    const { app, sibling } = await throughSibling([DAEMON, OLD_DAEMON])
    const res = await patchChannel(app, sibling.integrationId, 'C1', gateOf(await createDecision(app)))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ decision: { readiness: { status: 'ready' } } })
    const list = (await app.app.inject({ method: 'GET', url: `${ORG}/integrations` })).json() as Array<{
      id: string
      channels: Array<{ channelId: string; decision: { readiness: { status: string } } | null }>
    }>
    const readinessOf = (id: string) =>
      list.find((i) => i.id === id)!.channels.find((c) => c.channelId === 'C1')?.decision?.readiness.status
    expect(readinessOf(sibling.integrationId)).toBe('ready')
  })
})

describe('Decision usage, edits, and deletion with channel gates', () => {
  it('lists gates as usages, refuses DELETE while bound, and allows it after', async () => {
    const { integrationId, installs } = await seedInstall({ transport: 'http', agents: 2 })
    const { app } = appWith()
    app.relayReg.add(new FakeRelay(randomUUID(), [DECISION_TRIGGER_V1_FEATURE]))
    const decisionId = await createDecision(app)
    expect((await patchChannel(app, integrationId, 'C1', gateOf(decisionId))).statusCode).toBe(200)

    const list = (await app.app.inject({ method: 'GET', url: `${ORG}/decisions` })).json() as Array<{
      id: string
      usageCount: number
    }>
    expect(list.find((d) => d.id === decisionId)?.usageCount).toBe(1)
    const detail = (await app.app.inject({ method: 'GET', url: `${ORG}/decisions/${decisionId}` })).json()
    expect(detail.usages).toHaveLength(2)
    expect(detail.usages.map((usage: { integrationId: string }) => usage.integrationId).sort()).toEqual(
      installs.map((install) => install.integrationId).sort()
    )
    expect(detail.usages[0]).toMatchObject({ kind: 'gate', channelId: 'C1', rootDecisionId: decisionId })

    // A member who cannot see the owning agent sees neither the usage nor its name.
    await prisma.agent.updateMany({
      where: { id: { in: installs.map((i) => i.agentId) } },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const users = new PgUserRepo(prisma)
    const { userId } = await users.provisionOidcUser({ oidcSubject: 'm', email: 'm@example.test', emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, 'm@example.test', 'collaborator')
    const member = appWith([DECISION_TRIGGER_V1_FEATURE], userId).app
    const refused = await member.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json()).toMatchObject({
      usages: [],
      hiddenUsageCount: 1,
      message: expect.stringContaining('1 conversation')
    })
    const ownerView = await app.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })
    expect(ownerView.json()).toMatchObject({
      hiddenUsageCount: 0,
      usages: expect.arrayContaining([expect.objectContaining({ channelId: 'C1' })])
    })

    // The FK is the backstop for a gate saved after the pre-check.
    await expect(prisma.decision.delete({ where: { id: decisionId } })).rejects.toThrow()
    await expect(
      new PgDecisionRepo(prisma).delete(OrgId(DEFAULT_ORG_ID), decisionId, { userId: DEFAULT_OWNER_ID, role: 'owner' })
    ).rejects.toBeInstanceOf(DecisionInUse)
    await prisma.agent.updateMany({
      where: { id: { in: installs.map((i) => i.agentId) } },
      data: { visibility: 'org' }
    })
    expect((await patchChannel(app, integrationId, 'C1', { trigger: 'off' })).statusCode).toBe(200)
    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })).statusCode).toBe(204)
  })

  it('marks incompatible gates Needs review on a question edit, projects them disabled, and re-pushes', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith()
    const score = await createDecision(app, scoreDraft)
    const choice = await createDecision(app, choiceDraft)
    await prisma.integrationChannel.create({
      data: { integrationId, channelId: 'C2', name: 'topic', trigger: 'mention' }
    })
    await prisma.integrationChannel.create({
      data: { integrationId, channelId: 'C3', name: 'keep', trigger: 'mention' }
    })
    expect(
      (await patchChannel(app, integrationId, 'C1', gateOf(score, { type: 'score', min: 1, max: 2 }))).statusCode
    ).toBe(200)
    expect(
      (await patchChannel(app, integrationId, 'C2', gateOf(choice, { type: 'choice', thresholds: { billing: 0.5 } })))
        .statusCode
    ).toBe(200)
    expect(
      (await patchChannel(app, integrationId, 'C3', gateOf(choice, { type: 'choice', thresholds: { tech: 0.5 } })))
        .statusCode
    ).toBe(200)

    spy.upserts.length = 0
    const rubric = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/decisions/${score}`,
      payload: { ...scoreDraft, question: { ...scoreDraft.question, criteria: ['low', 'mid', 'high'] } }
    })
    expect(rubric.statusCode, rubric.body).toBe(200)
    const removedKey = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/decisions/${choice}`,
      payload: { ...choiceDraft, question: { ...choiceDraft.question, criteria: { tech: 'Code', ops: 'Ops' } } }
    })
    expect(removedKey.statusCode, removedKey.body).toBe(200)

    const rows = new Map(
      (await prisma.integrationChannel.findMany({ where: { integrationId } })).map((r) => [r.channelId, r])
    )
    expect(rows.get('C1')).toMatchObject({ trigger: 'decision', decisionNeedsReview: true })
    expect(rows.get('C2')).toMatchObject({ trigger: 'decision', decisionNeedsReview: true })
    expect(rows.get('C3')).toMatchObject({ trigger: 'decision', decisionNeedsReview: false })
    const pushed = spy.upserts.at(-1)!.u
    // Rows project in name order: general (C1), keep (C3), topic (C2).
    expect(pushed.core.decisions.bindings.map((b) => [b.channel, b.enabled, b.disabledReason])).toEqual([
      ['C1', false, 'needs_review'],
      ['C3', true, undefined],
      ['C2', false, 'needs_review']
    ])
    expect(pushed.core.bindRules).toContainEqual({ channel: 'C3', match: { kind: 'decision' } })
    expect(pushed.core.bindRules).not.toContainEqual({ channel: 'C1', match: { kind: 'decision' } })
    expect(pushed.core.mutedChannels).toEqual(expect.arrayContaining(['C1', 'C2']))

    const list = (await app.app.inject({ method: 'GET', url: `${ORG}/integrations` })).json() as Array<{
      channels: Array<{ channelId: string; decision: { readiness: { status: string } } | null }>
    }>
    const c1 = list[0]!.channels.find((c) => c.channelId === 'C1')
    expect(c1?.decision).toMatchObject({
      enabled: false,
      disabledReason: 'needs_review',
      readiness: { status: 'needs_review' }
    })

    // Re-saving the binding is the repair and clears the flag.
    expect(
      (await patchChannel(app, integrationId, 'C1', gateOf(score, { type: 'score', min: 1, max: 2 }))).json()
    ).toMatchObject({
      decision: { enabled: true }
    })
  })
})

describe('chained conversation gates', () => {
  it('saves all nodes, projects their definitions, fences deletion, and invalidates a changed child', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith([DECISION_TRIGGER_V1_FEATURE, DECISION_CHAIN_V1_FEATURE])
    const root = await createDecision(app)
    const child = await createDecision(app, scoreDraft)
    const binding = {
      type: 'gate',
      decisionId: root,
      when: { type: 'boolean', values: [true] },
      nextStepId: 'urgency',
      steps: [{ id: 'urgency', decisionId: child, when: { type: 'score', min: 1, max: 3 } }]
    }
    const response = await patchChannel(app, integrationId, 'C1', { trigger: 'decision', decisionBinding: binding })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().decisionBinding).toEqual(binding)
    expect(
      spy.upserts
        .at(-1)
        ?.u.core.decisions?.definitions.map((d) => d.id)
        .sort()
    ).toEqual([root, child].sort())
    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${child}` })).statusCode).toBe(409)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/decisions/${child}` })).json().usages).toEqual([
      expect.objectContaining({ kind: 'gate', rootDecisionId: root })
    ])
    const changed = await app.app.inject({ method: 'PATCH', url: `${ORG}/decisions/${child}`, payload: boolDraft })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(
      (
        await prisma.integrationChannel.findUnique({
          where: { integrationId_channelId: { integrationId, channelId: 'C1' } }
        })
      )?.decisionNeedsReview
    ).toBe(true)
  })
})
