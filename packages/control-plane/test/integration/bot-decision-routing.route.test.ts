// Shared-bot By decision routing configuration on the CP (decisions.md §3.2, §6.1–§6.3, §7.1).
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DECISION_ROUTING_FORWARD_V1_FEATURE,
  DECISION_ROUTING_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  type DecisionDraft,
  type IntegrationRemove,
  type IntegrationUpsert,
  type RcRoutes,
  type RelayCpFrameType,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgBotDecisionRoutingRepo } from '../../src/persistence/repositories/bot-decision-routing.repo.js'
import { RoutingChannelInvalid } from '../../src/persistence/errors.js'
import { BotId, IntegrationId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const ROUTING = [DECISION_TRIGGER_V1_FEATURE, DECISION_ROUTING_V1_FEATURE]
const CURRENT = [DECISION_TRIGGER_V1_FEATURE]
// A relay that forwards to the evaluation host (5b); a 5a relay advertises only ROUTING.
const RELAY_ROUTING = [...ROUTING, DECISION_ROUTING_FORWARD_V1_FEATURE]

class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  features: string[] = ROUTING
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
  daemonFeatures(): readonly string[] {
    return this.features
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
  name: 'Billing?',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: { type: 'boolean', instructions: 'Is it about billing?', criteria: { true: 'Yes', false: 'No' } }
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

function appWith(opts: { daemon?: string[]; relay?: string[] | null; userId?: string } = {}) {
  const spy = new SpyControl()
  spy.features = opts.daemon ?? ROUTING
  const liveness = { get: () => ({ state: 'READY', capabilities: { features: spy.features } }) }
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test', ...(opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {}) },
    liveness as never,
    spy as unknown as ControlSender
  )
  running.push(app)
  const relay = opts.relay === null ? null : new FakeRelay(randomUUID(), opts.relay ?? RELAY_ROUTING)
  if (relay) app.relayReg.add(relay)
  return { app, spy, relay }
}

async function seedBot(opts: { shareable?: boolean; transport?: 'http' | 'socket'; platform?: string } = {}) {
  if (!(await prisma.daemon.findUnique({ where: { id: DAEMON } }))) await seedDaemon(prisma, DAEMON)
  const botId = randomUUID()
  await prisma.bot.create({
    data: {
      id: botId,
      orgId: DEFAULT_ORG_ID,
      platform: opts.platform ?? 'slack',
      name: `bot-${botId.slice(0, 6)}`,
      transport: opts.transport ?? 'http',
      shareable: opts.shareable ?? true
    }
  })
  await prisma.botSecret.create({ data: { botId, botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' } })
  const installs: Array<{ agentId: string; integrationId: string }> = []
  for (let n = 0; n < 2; n += 1) {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: `agent-${n}-${botId.slice(0, 6)}` })
    const integrationId = randomUUID()
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: opts.platform ?? 'slack', name: 'b' }
    })
    installs.push({ agentId, integrationId })
  }
  const [a, b] = installs as [(typeof installs)[0], (typeof installs)[0]]
  // Every conversation is repeated on both installs; the first install owns it.
  const rows = [
    { channelId: 'C1', name: 'general', trigger: 'mention' as const },
    { channelId: 'C2', name: 'support', trigger: 'any' as const },
    { channelId: 'C3', name: 'quiet', trigger: 'off' as const },
    { channelId: 'D1', name: 'alice', trigger: 'any' as const, kind: 'im' as const }
  ]
  await prisma.integrationChannel.createMany({
    data: rows.flatMap((row) => [
      { integrationId: a.integrationId, agentId: a.agentId, ...row },
      { integrationId: b.integrationId, ...row }
    ])
  })
  return { botId, a, b }
}

async function createDecision(app: HttpApp, draft: DecisionDraft = boolDraft): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}

const routingConfig = (decisionId: string, a: string, b: string, over: Partial<SharedBotDecisionRouting> = {}) => ({
  enabled: true,
  decisionId,
  rules: [
    { id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: a } },
    { id: 'r2', when: { type: 'boolean', values: [false] }, action: { type: 'agent', agentId: b } }
  ],
  otherwise: { type: 'default_agent' },
  ...over
})

const put = (app: HttpApp, botId: string, payload: unknown) =>
  app.app.inject({ method: 'PUT', url: `${ORG}/bots/${botId}/decision-routing`, payload: payload as object })
const get = (app: HttpApp, botId: string) =>
  app.app.inject({ method: 'GET', url: `${ORG}/bots/${botId}/decision-routing` })
const rowsOf = (channelId: string) => prisma.integrationChannel.findMany({ where: { channelId } })
const lastRoutes = (relay: FakeRelay) =>
  relay.sends.filter((s) => s.type === 'rc/routes' || s.type === 'rc/bot-assign').at(-1)!.payload as RcRoutes

async function member(role: 'collaborator' | 'viewer', tag: string) {
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({
    oidcSubject: tag,
    email: `${tag}@example.test`,
    emailVerified: true
  })
  await users.addMemberByEmail(DEFAULT_ORG_ID, `${tag}@example.test`, role)
  return userId
}

describe('GET /bots/:id/decision-routing', () => {
  it('reports no configuration and an empty scope for a bot without a router', async () => {
    const { botId } = await seedBot()
    const { app } = appWith()
    const res = await get(app, botId)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ botId, config: null, channelIds: [], channels: [], updatedAt: null })
    expect((await get(app, randomUUID())).statusCode).toBe(404)
  })
})

describe('PUT /bots/:id/decision-routing', () => {
  it('saves the config and the scope together, replicating the router to every sibling row', async () => {
    const { botId, a, b } = await seedBot()
    const { app, relay, spy } = appWith()
    const decisionId = await createDecision(app)
    const res = await put(app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId),
      channelIds: ['C1', 'C2'],
      removals: []
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      config: { decisionId, enabled: true },
      channelIds: ['C1', 'C2'],
      readiness: { status: 'ready' },
      evaluationHost: { daemonId: DAEMON, source: 'default_agent', status: 'ready' },
      channels: [
        {
          channelId: 'C1',
          defaultAgent: { id: a.agentId, name: expect.stringMatching(/^agent-0-/) },
          evaluationDaemonId: DAEMON
        },
        { channelId: 'C2', defaultAgent: { id: a.agentId }, evaluationDaemonId: DAEMON }
      ]
    })
    expect(res.json().updatedAt).toEqual(expect.any(String))
    for (const channelId of ['C1', 'C2'])
      for (const row of await rowsOf(channelId))
        expect(row).toMatchObject({
          trigger: 'decision',
          decisionBinding: { type: 'shared_bot_routing' },
          decisionId: null,
          decisionNeedsReview: false,
          triggerChosen: true
        })
    expect(await prisma.botDecisionRouting.findUnique({ where: { botId } })).toMatchObject({
      decisionId,
      enabled: true,
      needsReview: false,
      createdByUserId: DEFAULT_OWNER_ID
    })
    const routes = lastRoutes(relay!)
    expect(routes.routedConversations).toEqual([
      { channel: 'C1', decisionId, evaluationDaemonId: DAEMON },
      { channel: 'C2', decisionId, evaluationDaemonId: DAEMON }
    ])
    expect(routes.routes).toContainEqual(
      expect.objectContaining({ agentId: a.agentId, scope: { channel: 'C1' }, match: { kind: 'decision' }, decisionId })
    )
    // Both installs live on the host daemon, so each spec carries the router and its definition.
    const pushed = spy.upserts.at(-1)!.u
    expect(pushed.core.decisions.sharedBotRouting).toMatchObject({
      botId,
      channels: [{ channel: 'C1' }, { channel: 'C2' }]
    })
    expect(pushed.core.decisions.definitions).toEqual([expect.objectContaining({ id: decisionId })])

    // The channel DTO names the router as the consumer.
    const list = (await app.app.inject({ method: 'GET', url: `${ORG}/integrations` })).json() as Array<{
      channels: Array<{ channelId: string; decisionBinding: unknown; decision: unknown }>
    }>
    expect(list[0]!.channels.find((c) => c.channelId === 'C1')).toMatchObject({
      decisionBinding: { type: 'shared_bot_routing' },
      decision: { consumer: 'shared_bot_routing', id: decisionId, name: boolDraft.name, readiness: { status: 'ready' } }
    })
  })

  it('refuses additions while current daemons lack decision-routing-v1, but pauses and config saves succeed', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith({ daemon: CURRENT })
    const decisionId = await createDecision(app)
    const refused = await put(app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId),
      channelIds: ['C1'],
      removals: []
    })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('DECISION_UNSUPPORTED_CONSUMER')
    for (const row of await rowsOf('C1')) expect(row.trigger).toBe('mention')
    const configOnly = await put(app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId, { enabled: false }),
      channelIds: [],
      removals: []
    })
    expect(configOnly.statusCode, configOnly.body).toBe(200)
    expect(configOnly.json()).toMatchObject({ config: { enabled: false }, channelIds: [] })

    // A relay that predates routing refuses additions too, whatever the daemons advertise.
    const oldRelay = appWith({ relay: CURRENT })
    const viaOldRelay = await put(oldRelay.app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId),
      channelIds: ['C1'],
      removals: []
    })
    expect(viaOldRelay.statusCode, viaOldRelay.body).toBe(409)
    expect(viaOldRelay.json().code).toBe('DECISION_UNSUPPORTED_CONSUMER')
    // So does a 5a relay, which parses routed conversations but cannot forward them to the host.
    const parseOnly = appWith({ relay: ROUTING })
    const viaParseOnly = await put(parseOnly.app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId),
      channelIds: ['C1'],
      removals: []
    })
    expect(viaParseOnly.statusCode, viaParseOnly.body).toBe(409)
    expect(viaParseOnly.json().message).toBe('Upgrade the relay to use By decision routing.')
  })

  it('holds a routed conversation behind a relay that cannot forward to the host, even with a capable host', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const saved = await put(app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId),
      channelIds: ['C1'],
      removals: []
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const parseOnly = appWith({ relay: ROUTING })
    await parseOnly.app.deps.httpBot.syncRoutes(botId)
    const routes = lastRoutes(parseOnly.relay!)
    expect(routes.mutedChannels).toContain('C1')
    expect(routes.routedConversations).toEqual([])
    expect(routes.routes.some((r) => r.scope?.channel === 'C1')).toBe(false)
    const detail = (await get(parseOnly.app, botId)).json()
    expect(detail.readiness).toMatchObject({
      status: 'unsupported',
      reason: 'Upgrade the relay to use By decision routing.'
    })
  })

  it('holds a routed conversation once its daemons downgrade, never projecting an unfiltered route', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    expect(
      (
        await put(app, botId, {
          config: routingConfig(decisionId, a.agentId, b.agentId),
          channelIds: ['C1'],
          removals: []
        })
      ).statusCode
    ).toBe(200)
    const downgraded = appWith({ daemon: CURRENT })
    await downgraded.app.deps.httpBot.syncRoutes(botId)
    const routes = lastRoutes(downgraded.relay!)
    expect(routes.mutedChannels).toContain('C1')
    expect(routes.routedConversations).toEqual([])
    expect(routes.routes.some((r) => r.scope?.channel === 'C1')).toBe(false)
    expect(downgraded.spy.upserts.at(-1)!.u.core.decisions.sharedBotRouting).toBeUndefined()
    const detail = (await get(downgraded.app, botId)).json()
    expect(detail.readiness).toMatchObject({ status: 'unsupported' })
    expect(detail.evaluationHost).toMatchObject({ daemonId: DAEMON, status: 'unsupported' })
  })

  it('refuses Off, direct, unknown and duplicate channels, a non-shared bot, and an owner-as-default platform', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const config = routingConfig(decisionId, a.agentId, b.agentId)
    const off = await put(app, botId, { config, channelIds: ['C3'], removals: [] })
    expect(off.statusCode, off.body).toBe(400)
    expect(off.json().message).toBe('Enable the channel before adding it to routing.')
    expect((await put(app, botId, { config, channelIds: ['D1'], removals: [] })).statusCode).toBe(400)
    expect((await put(app, botId, { config, channelIds: ['C9'], removals: [] })).statusCode).toBe(404)
    expect((await put(app, botId, { config, channelIds: ['C1', 'C1'], removals: [] })).statusCode).toBe(400)
    for (const row of await rowsOf('C3')) expect(row.trigger).toBe('off')

    const classic = await seedBot({ shareable: false })
    const notShared = await put(app, classic.botId, {
      config: routingConfig(decisionId, classic.a.agentId, classic.b.agentId),
      channelIds: [],
      removals: []
    })
    expect(notShared.statusCode).toBe(400)
    expect(notShared.json().message).toBe('Routing requires a shared bot.')
    const linear = await seedBot({ platform: 'linear' })
    const ownerAsDefault = await put(app, linear.botId, {
      config: routingConfig(decisionId, linear.a.agentId, linear.b.agentId),
      channelIds: [],
      removals: []
    })
    expect(ownerAsDefault.statusCode).toBe(400)
  })

  it('rejects a target not connected to the bot, and invalid rules, with row errors', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const outsider = randomUUID()
    await seedAgent(prisma, outsider, { daemonId: DAEMON })
    const res = await put(app, botId, {
      config: routingConfig(decisionId, a.agentId, outsider),
      channelIds: ['C1'],
      removals: []
    })
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().issues).toEqual([
      { path: ['rules', 1, 'action'], message: 'Choose an agent connected to this bot.' }
    ])

    const overlap = await put(app, botId, {
      config: routingConfig(await createDecision(app, scoreDraft), a.agentId, b.agentId, {
        rules: [
          { id: 'r1', when: { type: 'score', min: 0, max: 2 }, action: { type: 'agent', agentId: a.agentId } },
          { id: 'r2', when: { type: 'score', min: 1, max: 3 }, action: { type: 'skip' } }
        ]
      }),
      channelIds: [],
      removals: []
    })
    expect(overlap.statusCode).toBe(400)
    expect(overlap.json().issues).toEqual([expect.objectContaining({ message: 'Score intervals must not overlap.' })])
    const repeatedKey = await put(app, botId, {
      config: routingConfig(await createDecision(app, choiceDraft), a.agentId, b.agentId, {
        rules: [
          {
            id: 'r1',
            when: { type: 'choice', thresholds: { billing: 0.5 } },
            action: { type: 'agent', agentId: a.agentId }
          },
          {
            id: 'r2',
            when: { type: 'choice', thresholds: { billing: 0.7 } },
            action: { type: 'agent', agentId: b.agentId }
          }
        ]
      }),
      channelIds: [],
      removals: []
    })
    expect(repeatedKey.statusCode).toBe(400)
    expect(repeatedKey.json().issues).toEqual([
      expect.objectContaining({ message: 'An answer can appear in only one routing rule.' })
    ])
    const repeatedValue = await put(app, botId, {
      config: routingConfig(decisionId, a.agentId, b.agentId, {
        rules: [
          { id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: a.agentId } },
          { id: 'r2', when: { type: 'boolean', values: [true] }, action: { type: 'skip' } }
        ]
      }),
      channelIds: [],
      removals: []
    })
    expect(repeatedValue.statusCode).toBe(400)
    expect(await prisma.botDecisionRouting.findUnique({ where: { botId } })).toBeNull()
  })

  it('requires replacement settings for every removal, applies them, and keeps the router', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const config = routingConfig(decisionId, a.agentId, b.agentId)
    expect((await put(app, botId, { config, channelIds: ['C1', 'C2'], removals: [] })).statusCode).toBe(200)

    const missing = await put(app, botId, { config, channelIds: ['C2'], removals: [] })
    expect(missing.statusCode).toBe(409)
    expect(missing.json().message).toBe('Specify replacement settings for every channel removed from routing.')
    const extra = await put(app, botId, {
      config,
      channelIds: ['C1', 'C2'],
      removals: [{ channelId: 'C1', settings: { trigger: 'mention' } }]
    })
    expect(extra.statusCode).toBe(409)

    const removed = await put(app, botId, {
      config,
      channelIds: ['C2'],
      removals: [{ channelId: 'C1', settings: { trigger: 'mention' }, agentId: b.agentId }]
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json().channelIds).toEqual(['C2'])
    const c1 = await rowsOf('C1')
    for (const row of c1) expect(row).toMatchObject({ trigger: 'mention', decisionBinding: null, decisionId: null })
    // The replacement default agent is the one canonical owner.
    expect(c1.filter((row) => row.agentId !== null).map((row) => row.agentId)).toEqual([b.agentId])
    expect(await prisma.botDecisionRouting.findUnique({ where: { botId } })).not.toBeNull()

    const toAny = await put(app, botId, {
      config,
      channelIds: [],
      removals: [{ channelId: 'C2', settings: { trigger: 'auto' } }]
    })
    expect(toAny.statusCode, toAny.body).toBe(200)
    for (const row of await rowsOf('C2')) expect(row).toMatchObject({ trigger: 'any', decisionBinding: null })
    const notMember = await put(app, botId, {
      config,
      channelIds: [],
      removals: [{ channelId: 'C9', settings: { trigger: 'mention' }, agentId: randomUUID() }]
    })
    expect(notMember.statusCode).toBe(409)
  })

  it('pauses without discarding the config or the scope', async () => {
    const { botId, a, b } = await seedBot()
    const { app, relay } = appWith()
    const decisionId = await createDecision(app)
    const config = routingConfig(decisionId, a.agentId, b.agentId)
    expect((await put(app, botId, { config, channelIds: ['C1'], removals: [] })).statusCode).toBe(200)
    const paused = await put(app, botId, { config: { ...config, enabled: false }, channelIds: ['C1'], removals: [] })
    expect(paused.statusCode, paused.body).toBe(200)
    expect(paused.json()).toMatchObject({
      config: { enabled: false, rules: config.rules },
      channelIds: ['C1'],
      readiness: { reason: 'Routing is paused.' }
    })
    for (const row of await rowsOf('C1')) expect(row.decisionBinding).toEqual({ type: 'shared_bot_routing' })
    expect(lastRoutes(relay!).mutedChannels).toContain('C1')
    expect(lastRoutes(relay!).routedConversations).toEqual([])
  })

  it('authorizes the caller, every affected channel, the Decision and every target', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const config = routingConfig(decisionId, a.agentId, b.agentId)
    const viewer = appWith({ userId: await member('viewer', 'rv') }).app
    expect((await put(viewer, botId, { config, channelIds: [], removals: [] })).statusCode).toBe(403)

    const collaborator = await member('collaborator', 'rc')
    const asCollaborator = appWith({ userId: collaborator }).app
    // A Decision the collaborator cannot see is a 404, never a name leak.
    const hidden = await createDecision(app, { ...boolDraft, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] })
    const invisible = await put(asCollaborator, botId, {
      config: routingConfig(hidden, a.agentId, b.agentId),
      channelIds: [],
      removals: []
    })
    expect(invisible.statusCode).toBe(404)
    expect(invisible.json().code).toBe('DECISION_NOT_FOUND')
    // An invisible target reads exactly like a non-member one.
    await prisma.agent.update({
      where: { id: b.agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const target = await put(asCollaborator, botId, { config, channelIds: [], removals: [] })
    expect(target.statusCode).toBe(400)
    expect(target.json().issues).toEqual([
      { path: ['rules', 1, 'action'], message: 'Choose an agent connected to this bot.' }
    ])
    await prisma.agent.update({ where: { id: b.agentId }, data: { visibility: 'org', sharedWith: [] } })
    // A channel whose owner the collaborator cannot edit is refused.
    await prisma.agent.update({
      where: { id: a.agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const channel = await put(asCollaborator, botId, {
      config: routingConfig(decisionId, b.agentId, b.agentId, {
        rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: b.agentId } }]
      }),
      channelIds: ['C1'],
      removals: []
    })
    expect(channel.statusCode, channel.body).toBe(403)
    for (const row of await rowsOf('C1')) expect(row.trigger).toBe('mention')

    // A rule edit governs every retained channel, so it needs its owner too, even with the scope unchanged.
    const bOnly = routingConfig(decisionId, b.agentId, b.agentId, {
      rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: b.agentId } }]
    })
    expect((await put(app, botId, { config: bOnly, channelIds: ['C1'], removals: [] })).statusCode).toBe(200)
    const edited = await put(asCollaborator, botId, {
      config: { ...bOnly, rules: [{ ...bOnly.rules[0]!, when: { type: 'boolean', values: [false] } }] },
      channelIds: ['C1'],
      removals: []
    })
    expect(edited.statusCode, edited.body).toBe(403)
    expect(edited.json().message).toBe('cannot edit the owner of an affected conversation')
    const pausedByCollaborator = await put(asCollaborator, botId, {
      config: { ...bOnly, enabled: false },
      channelIds: ['C1'],
      removals: []
    })
    expect(pausedByCollaborator.statusCode).toBe(403)
    expect(await prisma.botDecisionRouting.findUnique({ where: { botId } })).toMatchObject({
      enabled: true,
      rules: bOnly.rules
    })
    // Resending the stored config unchanged affects no retained channel.
    const unchanged = await put(asCollaborator, botId, { config: bOnly, channelIds: ['C1'], removals: [] })
    expect(unchanged.statusCode, unchanged.body).toBe(200)
  })

  it("hides conversation names from a member who can view none of the bot's agents", async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const config = routingConfig(decisionId, a.agentId, b.agentId)
    expect((await put(app, botId, { config, channelIds: ['C1'], removals: [] })).statusCode).toBe(200)
    await prisma.agent.updateMany({
      where: { id: { in: [a.agentId, b.agentId] } },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const outsider = appWith({ userId: await member('collaborator', 'rn') }).app
    const hidden = await get(outsider, botId)
    expect(hidden.statusCode, hidden.body).toBe(200)
    expect(hidden.json().channels).toEqual([
      expect.objectContaining({ channelId: 'C1', name: null, defaultAgent: { id: a.agentId, name: null } })
    ])
    expect((await get(app, botId)).json().channels).toEqual([
      expect.objectContaining({ channelId: 'C1', name: 'general' })
    ])
  })
})

describe('the router persistence invariants', () => {
  it('lets a row hold a router or a gate, never a router with a Decision id or a gate without one', async () => {
    const { a } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    await expect(
      prisma.$executeRaw`UPDATE "integration_channel" SET "trigger" = 'decision', "decisionBinding" = '{"type":"shared_bot_routing"}'::jsonb, "decisionId" = ${decisionId}::uuid WHERE "integrationId" = ${a.integrationId}::uuid AND "channelId" = 'C1'`
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "integration_channel" SET "trigger" = 'decision', "decisionBinding" = ${JSON.stringify({ type: 'gate', decisionId, when: { type: 'boolean', values: [true] } })}::jsonb WHERE "integrationId" = ${a.integrationId}::uuid AND "channelId" = 'C1'`
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "integration_channel" SET "trigger" = 'decision', "decisionBinding" = '{"type":"shared_bot_routing"}'::jsonb, "decisionNeedsReview" = true WHERE "integrationId" = ${a.integrationId}::uuid AND "channelId" = 'C1'`
    ).rejects.toThrow()
    expect(
      await prisma.$executeRaw`UPDATE "integration_channel" SET "trigger" = 'decision', "decisionBinding" = '{"type":"shared_bot_routing"}'::jsonb WHERE "integrationId" = ${a.integrationId}::uuid AND "channelId" = 'C1'`
    ).toBe(1)
  })

  it('rolls the whole save back when any scope change fails', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    const repo = new PgBotDecisionRoutingRepo(prisma)
    const actor = { userId: DEFAULT_OWNER_ID, role: 'owner' as const }
    const config = routingConfig(decisionId, a.agentId, b.agentId) as SharedBotDecisionRouting
    await repo.save(OrgId(DEFAULT_ORG_ID), BotId(botId), { config, channelIds: ['C1'], removals: [] }, actor)
    await expect(
      repo.save(
        OrgId(DEFAULT_ORG_ID),
        BotId(botId),
        {
          config: { ...config, enabled: false },
          channelIds: ['C2'],
          removals: [
            { channelId: 'C1', activation: { trigger: 'mention' }, ownerIntegrationId: IntegrationId(randomUUID()) }
          ]
        },
        actor
      )
    ).rejects.toBeInstanceOf(RoutingChannelInvalid)
    expect(await prisma.botDecisionRouting.findUnique({ where: { botId } })).toMatchObject({ enabled: true })
    for (const row of await rowsOf('C1')) expect(row.decisionBinding).toEqual({ type: 'shared_bot_routing' })
    for (const row of await rowsOf('C2')) expect(row).toMatchObject({ trigger: 'any', decisionBinding: null })
  })
})

describe('Decision edits and deletion with a router', () => {
  it('marks the router Needs review on an incompatible edit, keeps its config, and holds it', async () => {
    const { botId, a, b } = await seedBot()
    const { app, relay } = appWith()
    const decisionId = await createDecision(app, choiceDraft)
    const config = routingConfig(decisionId, a.agentId, b.agentId, {
      rules: [
        {
          id: 'r1',
          when: { type: 'choice', thresholds: { billing: 0.5 } },
          action: { type: 'agent', agentId: a.agentId }
        }
      ]
    })
    expect((await put(app, botId, { config, channelIds: ['C1'], removals: [] })).statusCode).toBe(200)
    const edit = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/decisions/${decisionId}`,
      payload: { ...choiceDraft, question: { ...choiceDraft.question, criteria: { tech: 'Code', ops: 'Ops' } } }
    })
    expect(edit.statusCode, edit.body).toBe(200)
    const stored = await prisma.botDecisionRouting.findUnique({ where: { botId } })
    expect(stored).toMatchObject({ needsReview: true, rules: config.rules })
    const detail = (await get(app, botId)).json()
    expect(detail.readiness.status).toBe('needs_review')
    expect(detail.config).toMatchObject({ rules: config.rules })
    expect(lastRoutes(relay!).mutedChannels).toContain('C1')
    // Re-saving a repaired config is what clears the flag.
    const repaired = await put(app, botId, {
      config: { ...config, rules: [{ ...config.rules[0]!, when: { type: 'choice', thresholds: { tech: 0.5 } } }] },
      channelIds: ['C1'],
      removals: []
    })
    expect(repaired.statusCode, repaired.body).toBe(200)
    expect(repaired.json().readiness.status).toBe('ready')
  })

  it('lists the router as a usage and refuses DELETE with a permission-filtered summary', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    expect(
      (await put(app, botId, { config: routingConfig(decisionId, a.agentId, b.agentId), channelIds: [], removals: [] }))
        .statusCode
    ).toBe(200)
    const list = (await app.app.inject({ method: 'GET', url: `${ORG}/decisions` })).json() as Array<{
      id: string
      usageCount: number
    }>
    expect(list.find((d) => d.id === decisionId)?.usageCount).toBe(1)
    const detail = (await app.app.inject({ method: 'GET', url: `${ORG}/decisions/${decisionId}` })).json()
    expect(detail.usages).toEqual([{ kind: 'shared_bot_routing', id: botId, label: expect.stringMatching(/^bot-/) }])
    const refused = await app.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json()).toMatchObject({
      usages: [{ kind: 'shared_bot_routing', id: botId }],
      hiddenUsageCount: 0,
      message: expect.stringContaining('1 shared bot')
    })

    // A member who can see none of the bot's agents learns only that something hidden uses it.
    await prisma.agent.updateMany({
      where: { id: { in: [a.agentId, b.agentId] } },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const other = appWith({ userId: await member('collaborator', 'rd') }).app
    const hidden = await other.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })
    expect(hidden.statusCode).toBe(409)
    expect(hidden.json()).toMatchObject({ usages: [], hiddenUsageCount: 1 })
    await expect(prisma.decision.delete({ where: { id: decisionId } })).rejects.toThrow()
  })
})

describe('the channel PATCH on a routed conversation', () => {
  it('keeps the router on a session-mode patch and removes the channel from scope on a trigger patch', async () => {
    const { botId, a, b } = await seedBot()
    const { app } = appWith()
    const decisionId = await createDecision(app)
    expect(
      (
        await put(app, botId, {
          config: routingConfig(decisionId, a.agentId, b.agentId),
          channelIds: ['C1'],
          removals: []
        })
      ).statusCode
    ).toBe(200)
    const patch = (payload: Record<string, unknown>) =>
      app.app.inject({ method: 'PATCH', url: `${ORG}/integrations/${a.integrationId}/channels/C1`, payload })
    const mode = await patch({ sessionMode: 'append' })
    expect(mode.statusCode, mode.body).toBe(200)
    expect(mode.json()).toMatchObject({
      trigger: 'decision',
      decisionBinding: { type: 'shared_bot_routing' },
      decision: { consumer: 'shared_bot_routing', id: decisionId },
      sessionMode: 'append'
    })
    for (const row of await rowsOf('C1'))
      expect(row).toMatchObject({ decisionBinding: { type: 'shared_bot_routing' }, sessionMode: 'append' })
    expect((await patch({ trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } })).statusCode).toBe(400)

    const mention = await patch({ trigger: 'mention' })
    expect(mention.statusCode, mention.body).toBe(200)
    for (const row of await rowsOf('C1')) expect(row).toMatchObject({ trigger: 'mention', decisionBinding: null })
    expect((await get(app, botId)).json().channelIds).toEqual([])
  })
})
