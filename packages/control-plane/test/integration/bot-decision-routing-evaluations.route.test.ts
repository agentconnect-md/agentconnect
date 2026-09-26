// Routing Recent evaluations on the CP (decisions.md §9.5): the evaluation host answers, each row's conversation audience gates it.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DECISION_PREVIEW_V1_FEATURE,
  DECISION_EVALUATION_FILTER_V1_FEATURE,
  DECISION_ROUTING_EVALUATIONS_V1_FEATURE,
  DECISION_ROUTING_FORWARD_V1_FEATURE,
  DECISION_ROUTING_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  type DecisionDraft,
  type DecisionEvaluationConversation,
  type DecisionRoutingEvaluationRecord,
  type DecisionRoutingEvaluationRecordDetail,
  type DecisionRoutingEvaluationReply,
  type DecisionRoutingEvaluationRequest,
  type DecisionRoutingEvaluationsReply,
  type DecisionRoutingEvaluationsRequestInput,
  type RelayCpFrameType
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import { ProtocolError } from '../../src/domain/errors.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd8d8d8d8-dddd-4ddd-8ddd-dddddddddddd'
const ROUTING = [DECISION_TRIGGER_V1_FEATURE, DECISION_ROUTING_V1_FEATURE]
const CONN = [
  ...ROUTING,
  DECISION_PREVIEW_V1_FEATURE,
  DECISION_ROUTING_EVALUATIONS_V1_FEATURE,
  DECISION_EVALUATION_FILTER_V1_FEATURE
]
const DECISION = '33333333-3333-4333-8333-333333333333'
const UNSCOPED: DecisionEvaluationConversation = { platform: 'slack', tenantScope: null }

const draft: DecisionDraft = {
  name: 'Billing?',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: { type: 'boolean', instructions: 'Is it billing?', criteria: { true: 'Yes', false: 'No' } }
}
const row = (seq: number, channel: string): DecisionRoutingEvaluationRecord => ({
  seq,
  at: '2026-01-01T00:00:00.000Z',
  channel,
  messageId: null,
  decisionId: 'd-1',
  outcome: 'partially_routed',
  reason: null,
  evaluated: true,
  answer: { type: 'boolean', value: true, probability: 0.9 },
  matchedKeys: [],
  matchedRuleIds: ['r1'],
  usedOtherwise: false,
  fallback: null,
  targets: [
    { agentId: 'a', effect: 'selected', via: 'implicit', participant: false, disposition: 'admitted', reason: null },
    { agentId: 'b', effect: 'selected', via: 'implicit', participant: false, disposition: 'rejected', reason: 'off' }
  ],
  latencyMs: 20,
  requestedModel: 'jev-latest',
  actualModel: 'jev-1.13.0',
  usage: { inputTokens: 5, outputTokens: 1 },
  detailsExpired: false
})
const detail = (channel: string): DecisionRoutingEvaluationRecordDetail => ({
  ...row(12, channel),
  snapshot: null,
  constraint: [],
  input: {
    currentMessage: { id: 'm1', sender: { id: 'U1' }, text: 'SECRET-BODY', threadId: null },
    history: [],
    historyOmitted: 0,
    context: { partial: false, reasons: [], omittedMessages: 0 }
  },
  fullAnswer: { type: 'boolean', value: true, probability: 0.9 }
})

class SpyControl {
  readonly lists: Array<{ daemonId: string; req: DecisionRoutingEvaluationsRequestInput }> = []
  readonly gets: Array<{ daemonId: string; req: DecisionRoutingEvaluationRequest }> = []
  conversation: DecisionEvaluationConversation | undefined = UNSCOPED
  list: (req: DecisionRoutingEvaluationsRequestInput) => Promise<DecisionRoutingEvaluationsReply> = async () =>
    this.scoped({ items: [row(14, 'C2'), row(13, 'C1')], nextCursor: 13 })
  get: (req: DecisionRoutingEvaluationRequest) => Promise<DecisionRoutingEvaluationReply> = async (req) =>
    this.scoped({ evaluation: detail(req.channel) })
  scoped<T extends object>(body: T): T & { conversation?: DecisionEvaluationConversation } {
    return this.conversation ? { ...body, conversation: this.conversation } : body
  }
  async decisionRoutingEvaluations(daemonId: string, _orgId: string, req: DecisionRoutingEvaluationsRequestInput) {
    this.lists.push({ daemonId, req })
    return this.list(req)
  }
  async decisionRoutingEvaluation(daemonId: string, _orgId: string, req: DecisionRoutingEvaluationRequest) {
    this.gets.push({ daemonId, req })
    return this.get(req)
  }
  async integrationUpsert(): Promise<void> {}
  async integrationRemove(): Promise<void> {}
  daemonFeatures(): readonly string[] {
    return ROUTING
  }
}

class FakeRelay implements RelayChannel {
  constructor(
    readonly relayId: string,
    readonly features: readonly string[]
  ) {}
  send(_type: RelayCpFrameType, _payload: unknown): void {}
  close(): void {}
}

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

function appWith(opts: { userId?: string; conn?: string[] | null } = {}) {
  const spy = new SpyControl()
  const liveness = {
    get: () => (opts.conn === null ? undefined : { state: 'READY', capabilities: { features: opts.conn ?? CONN } })
  }
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test', ...(opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {}) },
    liveness as never,
    spy as unknown as ControlSender
  )
  running.push(app)
  app.relayReg.add(new FakeRelay(randomUUID(), [...ROUTING, DECISION_ROUTING_FORWARD_V1_FEATURE]))
  return { app, spy }
}

async function member(role: 'viewer' | 'collaborator') {
  const repo = new PgUserRepo(prisma)
  const email = `${role}-${randomUUID()}@example.test`
  const { userId } = await repo.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
  await repo.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function routedBot() {
  if (!(await prisma.daemon.findUnique({ where: { id: DAEMON } }))) await seedDaemon(prisma, DAEMON)
  const botId = randomUUID()
  await prisma.bot.create({
    data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'shared', transport: 'http', shareable: true }
  })
  await prisma.botSecret.create({ data: { botId, botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' } })
  const agents: Array<{ agentId: string; integrationId: string }> = []
  for (let n = 0; n < 2; n += 1) {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: `member-${n}` })
    const integrationId = randomUUID()
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'b' }
    })
    agents.push({ agentId, integrationId })
  }
  const [a, b] = agents as [(typeof agents)[0], (typeof agents)[0]]
  const rows = [
    { channelId: 'C1', name: 'general', trigger: 'mention' as const },
    { channelId: 'C2', name: 'support', trigger: 'any' as const }
  ]
  await prisma.integrationChannel.createMany({
    data: rows.flatMap((r) => [
      { integrationId: a.integrationId, agentId: a.agentId, ...r },
      { integrationId: b.integrationId, ...r }
    ])
  })
  const { app } = appWith()
  const created = await app.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  const decisionId = (created.json() as { id: string }).id
  const config = {
    enabled: true,
    decisionId,
    rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: b.agentId } }],
    otherwise: { type: 'default_agent' }
  }
  const saved = await app.app.inject({
    method: 'PUT',
    url: `${ORG}/bots/${botId}/decision-routing`,
    payload: { config, channelIds: ['C1', 'C2'], removals: [] }
  })
  expect(saved.statusCode, saved.body).toBe(200)
  return { botId, a, b }
}

const list = (app: HttpApp, botId: string, query = '') =>
  app.app.inject({ method: 'GET', url: `${ORG}/bots/${botId}/decision-routing/evaluations${query}` })
const get = (app: HttpApp, botId: string, seq: number, channelId = 'C1') =>
  app.app.inject({
    method: 'GET',
    url: `${ORG}/bots/${botId}/decision-routing/evaluations/${seq}?channelId=${channelId}`
  })

describe('GET /bots/:id/decision-routing/evaluations', () => {
  it('reads the host across the scoped channels, and one channel with its cursor, storing nothing', async () => {
    const { botId, a } = await routedBot()
    const before = (await prisma.sessionMeta.count()) + (await prisma.auditEvent.count())
    const { app, spy } = appWith({ userId: await member('viewer') })
    const res = await list(app, botId, '?limit=5')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ items: [row(14, 'C2'), row(13, 'C1')], nextCursor: 13 })
    expect(spy.lists[0]).toMatchObject({ daemonId: DAEMON, req: { agentId: a.agentId, botId, limit: 5 } })
    expect([...spy.lists[0]!.req.channels].sort()).toEqual(['C1', 'C2'])
    const one = await list(app, botId, '?channelId=C1&cursor=40')
    expect(one.statusCode, one.body).toBe(200)
    expect(spy.lists[1]!.req).toMatchObject({ channels: ['C1'], cursor: 40, limit: 20 })
    expect((await list(app, botId, `?decisionId=${DECISION}`)).statusCode).toBe(200)
    expect(spy.lists.at(-1)!.req).toMatchObject({ decisionId: DECISION })
    const old = appWith({ conn: CONN.filter((feature) => feature !== DECISION_EVALUATION_FILTER_V1_FEATURE) })
    expect((await list(old.app, botId, `?decisionId=${DECISION}`)).json()).toMatchObject({
      code: 'DAEMON_UPGRADE_REQUIRED'
    })
    expect(old.spy.lists).toEqual([])
    expect((await list(app, botId, '?channelId=C9')).statusCode).toBe(404)
    expect((await list(app, randomUUID())).statusCode).toBe(404)
    expect((await prisma.sessionMeta.count()) + (await prisma.auditEvent.count())).toBe(before)
  })

  it('drops the rows of a conversation the caller cannot read and keeps the cursor', async () => {
    const { botId, b } = await routedBot()
    // The newest session in C2 belongs to another bot agent and is private to someone else.
    await seedSessionMeta(prisma, 'c2-private', b.agentId, {
      channel: 'C2',
      visibility: 'private',
      ownerIdentity: 'user:someone-else'
    })
    const { app } = appWith({ userId: await member('collaborator') })
    const res = await list(app, botId)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ items: [row(13, 'C1')], nextCursor: 13 })
    const denied = await get(app, botId, 12, 'C2')
    expect(denied.statusCode).toBe(404)
    expect(denied.body).not.toContain('SECRET-BODY')
  })

  it('keeps bodies without a session behind edit access, and any bot agent session opens them', async () => {
    const { botId, b } = await routedBot()
    const viewer = appWith({ userId: await member('viewer') })
    const hidden = await get(viewer.app, botId, 12)
    expect(hidden.statusCode).toBe(404)
    expect(hidden.body).not.toContain('SECRET-BODY')
    const collaborator = appWith({ userId: await member('collaborator') })
    const shown = await get(collaborator.app, botId, 12)
    expect(shown.statusCode, shown.body).toBe(200)
    expect(shown.json()).toEqual(detail('C1'))
    // A session held by the routed agent, not the channel owner, names the audience.
    await seedSessionMeta(prisma, 'c1-open', b.agentId, { channel: 'C1' })
    expect((await get(viewer.app, botId, 12)).statusCode).toBe(200)
    collaborator.spy.get = async () => ({ evaluation: null, conversation: UNSCOPED })
    expect((await get(collaborator.app, botId, 12)).statusCode).toBe(404)
  })

  it('answers 503 offline, upgrade required, and a reply with no namespace', async () => {
    const { botId } = await routedBot()
    const offline = appWith({ conn: null })
    expect((await list(offline.app, botId)).json()).toMatchObject({ code: 'DAEMON_OFFLINE' })
    const old = appWith({ conn: ROUTING })
    for (const res of [await list(old.app, botId), await get(old.app, botId, 12)]) {
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'DAEMON_UPGRADE_REQUIRED' })
    }
    expect([...offline.spy.lists, ...old.spy.lists, ...old.spy.gets]).toHaveLength(0)
    const bare = appWith({ userId: await member('collaborator') })
    bare.spy.conversation = undefined
    for (const res of [await list(bare.app, botId), await get(bare.app, botId, 12)]) {
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'DAEMON_UPGRADE_REQUIRED' })
      expect(res.body).not.toContain('SECRET-BODY')
    }
  })

  it('moves past a member the host refuses, then reads as offline', async () => {
    const { botId, a, b } = await routedBot()
    const { app, spy } = appWith()
    spy.list = async (req) => {
      if (req.agentId === a.agentId) throw new ProtocolError('SCOPE_DENIED', 'not routed here')
      return spy.scoped({ items: [], nextCursor: null })
    }
    expect((await list(app, botId)).statusCode).toBe(200)
    expect(spy.lists.map((call) => call.req.agentId)).toEqual([a.agentId, b.agentId])
    spy.list = async () => {
      throw new NoConnection(DAEMON)
    }
    expect((await list(app, botId)).json()).toMatchObject({ code: 'DAEMON_OFFLINE' })
  })
})
