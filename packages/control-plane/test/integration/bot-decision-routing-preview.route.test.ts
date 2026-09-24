// Routing Try on the CP (decisions.md §6.3, §9.3): the evaluation host answers, the router's settlement decides, nothing is written.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DECISION_CHAIN_V1_FEATURE,
  DECISION_PREVIEW_V1_FEATURE,
  DECISION_ROUTING_FORWARD_V1_FEATURE,
  DECISION_ROUTING_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  type DecisionDraft,
  type DecisionEvaluation,
  type DecisionPreviewRequest,
  type RelayCpFrameType
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd6d6d6d6-dddd-4ddd-8ddd-dddddddddddd'
const OFFLINE_DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-dddddddddddd'
const ROUTING = [DECISION_TRIGGER_V1_FEATURE, DECISION_ROUTING_V1_FEATURE, DECISION_CHAIN_V1_FEATURE]
const CONN = [...ROUTING, DECISION_PREVIEW_V1_FEATURE]
const RELAY_ROUTING = [...ROUTING, DECISION_ROUTING_FORWARD_V1_FEATURE]

const choiceDraft: DecisionDraft = {
  name: 'Topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: {
    type: 'choice',
    instructions: 'Which topic?',
    criteria: { billing: 'Money', tech: 'Code', sales: 'Quotes' }
  }
}
const answered = (probabilities: Record<string, number>): DecisionEvaluation => ({
  status: 'answered',
  model: 'jev-1.13.0',
  answer: { type: 'choice', value: 'billing', probabilities, confidence: 0.4 },
  usage: { inputTokens: 30, outputTokens: 1 }
})
const sample = {
  history: [{ sender: 'U1', text: 'Hello?' }],
  currentMessage: { sender: 'U2', text: 'Invoice API fails' }
}

class SpyControl {
  readonly previews: Array<{ daemonId: string; orgId: string; req: DecisionPreviewRequest }> = []
  next: (req: DecisionPreviewRequest) => Promise<{ evaluation: DecisionEvaluation }> = async () => ({
    evaluation: answered({ billing: 0.4, tech: 0.4, sales: 0.2 })
  })
  async decisionPreview(daemonId: string, orgId: string, req: DecisionPreviewRequest) {
    this.previews.push({ daemonId, orgId, req })
    return this.next(req)
  }
  async integrationUpsert(): Promise<void> {}
  async integrationRemove(): Promise<void> {}
  daemonFeatures(daemonId: string): readonly string[] | undefined {
    return daemonId === OFFLINE_DAEMON ? undefined : ROUTING
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

function appWith(opts: { userId?: string; offline?: boolean; conn?: string[]; relay?: string[] } = {}) {
  const spy = new SpyControl()
  const liveness = {
    get: (daemonId: string) =>
      opts.offline || daemonId === OFFLINE_DAEMON
        ? undefined
        : { state: 'READY', capabilities: { features: opts.conn ?? CONN } }
  }
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test', ...(opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {}) },
    liveness as never,
    spy as unknown as ControlSender
  )
  running.push(app)
  app.relayReg.add(new FakeRelay(randomUUID(), opts.relay ?? RELAY_ROUTING))
  return { app, spy }
}

async function member(role: 'viewer' | 'collaborator') {
  const repo = new PgUserRepo(prisma)
  const email = `${role}-${randomUUID()}@example.test`
  const { userId } = await repo.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
  await repo.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

// Three members: a (the owner, on the host), b (on the host), c (on an offline daemon).
async function seedBot(opts: { restricted?: boolean; prefix?: string } = {}) {
  for (const id of [DAEMON, OFFLINE_DAEMON])
    if (!(await prisma.daemon.findUnique({ where: { id } }))) await seedDaemon(prisma, id)
  const botId = randomUUID()
  await prisma.bot.create({
    data: {
      id: botId,
      orgId: DEFAULT_ORG_ID,
      platform: 'slack',
      name: `bot-${botId.slice(0, 6)}`,
      transport: 'http',
      shareable: true
    }
  })
  await prisma.botSecret.create({ data: { botId, botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' } })
  const agents: Array<{ agentId: string; integrationId: string }> = []
  for (const [n, daemonId] of [DAEMON, DAEMON, OFFLINE_DAEMON].entries()) {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId,
      name: `${opts.prefix ?? 'agent'}-${n}`,
      ...(opts.restricted ? { visibility: 'restricted' as const, sharedWith: [DEFAULT_OWNER_ID] } : {})
    })
    const integrationId = randomUUID()
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'b' }
    })
    agents.push({ agentId, integrationId })
  }
  const [a, b, c] = agents as [(typeof agents)[0], (typeof agents)[0], (typeof agents)[0]]
  const rows = [
    { channelId: 'C1', name: 'general', trigger: 'mention' as const },
    { channelId: 'C2', name: 'support', trigger: 'any' as const },
    { channelId: 'C3', name: 'quiet', trigger: 'off' as const },
    { channelId: 'D1', name: 'alice', trigger: 'any' as const, kind: 'im' as const }
  ]
  await prisma.integrationChannel.createMany({
    data: rows.flatMap((row) => [
      { integrationId: a.integrationId, agentId: a.agentId, ...row },
      { integrationId: b.integrationId, ...row },
      { integrationId: c.integrationId, ...row }
    ])
  })
  return { botId, a, b, c }
}

async function createDecision(app: HttpApp, draft: DecisionDraft = choiceDraft): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}

const configOf = (decisionId: string, a: string, b: string, over: Record<string, unknown> = {}) => ({
  enabled: true,
  decisionId,
  rules: [
    { id: 'r-billing', when: { type: 'choice', thresholds: { billing: 0.3 } }, action: { type: 'agent', agentId: a } },
    { id: 'r-tech', when: { type: 'choice', thresholds: { tech: 0.3 } }, action: { type: 'agent', agentId: b } },
    { id: 'r-sales', when: { type: 'choice', thresholds: { sales: 0.7 } }, action: { type: 'skip' } }
  ],
  otherwise: { type: 'default_agent' },
  ...over
})

// A saved router over C1 and C2, so the channels have an evaluation host.
async function routed() {
  const seeded = await seedBot()
  const { app } = appWith()
  const decisionId = await createDecision(app)
  const config = configOf(decisionId, seeded.a.agentId, seeded.b.agentId)
  const res = await app.app.inject({
    method: 'PUT',
    url: `${ORG}/bots/${seeded.botId}/decision-routing`,
    payload: { config, channelIds: ['C1', 'C2'], removals: [] }
  })
  expect(res.statusCode, res.body).toBe(200)
  return { ...seeded, decisionId, config }
}

const preview = (app: HttpApp, botId: string, payload: Record<string, unknown>) =>
  app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/decision-routing/preview`, payload })
const body = (config: unknown, over: Record<string, unknown> = {}) => ({
  config,
  channelIds: ['C1', 'C2'],
  channelId: 'C1',
  targets: { type: 'new' },
  state: sample,
  ...over
})

async function writes(): Promise<number> {
  const [sessions, audits, routings] = await Promise.all([
    prisma.sessionMeta.count(),
    prisma.auditEvent.count(),
    prisma.botDecisionRouting.findMany()
  ])
  return sessions + audits + routings.reduce((n, r) => n + r.updatedAt.getTime(), 0)
}

describe('POST /bots/:id/decision-routing/preview', () => {
  it('fans a Choice answer out to every matched agent on the host and writes nothing', async () => {
    const { botId, a, b, config } = await routed()
    const { app, spy } = appWith()
    const before = await writes()
    const res = await preview(app, botId, body(config))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      mode: 'live',
      readiness: { status: 'ready' },
      evaluation: { status: 'answered' },
      consumer: {
        type: 'shared_bot_routing',
        outcome: 'activate',
        evaluated: true,
        rules: [
          { ruleId: 'r-billing', matched: true, matchedKeys: ['billing'] },
          { ruleId: 'r-tech', matched: true, matchedKeys: ['tech'] },
          { ruleId: 'r-sales', matched: false, matchedKeys: [] }
        ],
        matchedRuleIds: ['r-billing', 'r-tech'],
        usedOtherwise: false,
        defaultAgent: { id: a.agentId, name: 'agent-0' },
        targets: [
          { agentId: a.agentId, name: 'agent-0', effect: 'selected', status: 'available' },
          { agentId: b.agentId, name: 'agent-1', effect: 'selected', status: 'available' }
        ]
      }
    })
    expect(spy.previews).toHaveLength(1)
    expect(spy.previews[0]).toMatchObject({ daemonId: DAEMON, orgId: DEFAULT_ORG_ID, req: { agentId: a.agentId } })
    expect(spy.previews[0]!.req.state).toMatchObject({
      currentMessage: { text: 'Invoice API fails', threadId: null },
      conversation: { name: 'general' },
      addressing: { mentions: [], constraint: { eligibleAgentIds: [], participantAgentIds: [] } }
    })
    expect(await writes()).toBe(before)
  })

  it('routes a matched branch through a second Decision to its final Agent', async () => {
    const { botId, decisionId, b, config } = await routed()
    const { app, spy } = appWith()
    const childId = await createDecision(app, { ...choiceDraft, name: 'Follow-up' })
    const draft = {
      ...config,
      rules: [
        {
          id: 'start',
          when: { type: 'choice', thresholds: { billing: 0.3 } },
          action: { type: 'decision', nextStepId: 'follow' }
        }
      ],
      steps: [
        {
          id: 'follow',
          decisionId: childId,
          rules: [
            {
              id: 'finish',
              when: { type: 'choice', thresholds: { tech: 0.3 } },
              action: { type: 'agent', agentId: b.agentId }
            }
          ]
        }
      ]
    }
    const before = await writes()
    const res = await preview(app, botId, body(draft))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().consumer.targets).toEqual([expect.objectContaining({ agentId: b.agentId, effect: 'selected' })])
    expect(res.json().chain.map((step: { decisionId: string }) => step.decisionId)).toEqual([decisionId, childId])
    expect(spy.previews).toHaveLength(2)
    expect(spy.previews[1]!.req.state).toEqual(spy.previews[0]!.req.state)
    expect(await writes()).toBe(before)
  })

  it('keeps a mention on its recipient, and an all-participant thread settles with no model call', async () => {
    const { botId, b, config } = await routed()
    const { app, spy } = appWith()
    const mention = await preview(app, botId, body(config, { targets: { type: 'mention', agentIds: [b.agentId] } }))
    expect(mention.statusCode, mention.body).toBe(200)
    expect(mention.json().consumer).toMatchObject({
      outcome: 'continue',
      targets: [{ agentId: b.agentId, effect: 'kept', via: 'mention' }]
    })
    expect(spy.previews[0]!.req.state).toMatchObject({
      addressing: { mentions: [b.agentId], constraint: { eligibleAgentIds: [b.agentId], participantAgentIds: [] } }
    })
    const thread = await preview(
      app,
      botId,
      body(config, { targets: { type: 'thread', agentIds: [b.agentId], participantAgentIds: [b.agentId] } })
    )
    expect(thread.statusCode, thread.body).toBe(200)
    expect(thread.json()).toMatchObject({
      evaluation: null,
      consumer: { outcome: 'continue', evaluated: false, targets: [{ agentId: b.agentId, effect: 'participant' }] }
    })
    expect(spy.previews).toHaveLength(1)
  })

  it('a provider failure continues to the default agent and never reads as a skip', async () => {
    const { botId, a, config } = await routed()
    const { app, spy } = appWith()
    spy.next = async () => ({ evaluation: { status: 'unavailable', reason: 'provider' } })
    const res = await preview(app, botId, body(config))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      evaluation: { status: 'unavailable', reason: 'provider' },
      consumer: {
        outcome: 'unavailable',
        reason: 'provider',
        fallback: 'default',
        targets: [{ agentId: a.agentId, effect: 'fallback_default' }]
      }
    })
  })

  it('reports a removed and an offline target without choosing another', async () => {
    const { botId, a, c, config } = await routed()
    const { app } = appWith()
    const ghost = randomUUID()
    const draft = {
      ...config,
      rules: [
        {
          id: 'r-billing',
          when: { type: 'choice', thresholds: { billing: 0.3 } },
          action: { type: 'agent', agentId: ghost }
        },
        {
          id: 'r-tech',
          when: { type: 'choice', thresholds: { tech: 0.3 } },
          action: { type: 'agent', agentId: c.agentId }
        }
      ]
    }
    const res = await preview(app, botId, body(draft))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().consumer.targets).toEqual([
      expect.objectContaining({ agentId: ghost, name: null, status: 'removed' }),
      expect.objectContaining({ agentId: c.agentId, name: 'agent-2', status: 'unavailable' })
    ])
    expect(res.json().consumer.targets.map((t: { agentId: string }) => t.agentId)).not.toContain(a.agentId)
  })

  it('returns Not applied with no model call for Off, outside scope, paused, Needs review, and unsupported', async () => {
    const { botId, config } = await routed()
    const { app, spy } = appWith()
    const reasonOf = async (payload: Record<string, unknown>, target = app) => {
      const res = await preview(target, botId, payload)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().evaluation).toBeNull()
      return res.json().consumer.notAppliedReason
    }
    expect(await reasonOf(body(config, { channelId: 'C3' }))).toBe('off')
    // Saving the draft turns an in-scope Off channel to By decision, so it evaluates.
    const offInScope = await preview(app, botId, body(config, { channelId: 'C3', channelIds: ['C1', 'C2', 'C3'] }))
    expect(offInScope.json().consumer.notAppliedReason, offInScope.body).toBeUndefined()
    expect(await reasonOf(body(config, { channelIds: ['C2'] }))).toBe('outside_scope')
    expect(await reasonOf(body({ ...config, enabled: false }))).toBe('paused')
    await prisma.botDecisionRouting.update({ where: { botId }, data: { needsReview: true } })
    expect(await reasonOf(body(config))).toBe('needs_review')
    // An edited draft is the repair, so it runs.
    const edited = { ...config, otherwise: { type: 'skip' } }
    expect((await preview(app, botId, body(edited))).json().consumer.outcome).toBe('activate')
    await prisma.botDecisionRouting.update({ where: { botId }, data: { needsReview: false } })
    const oldRelay = appWith({ relay: [DECISION_TRIGGER_V1_FEATURE] })
    expect(await reasonOf(body(config), oldRelay.app)).toBe('unsupported')
    const oldHost = appWith({ conn: ROUTING })
    expect(await reasonOf(body(config), oldHost.app)).toBe('unsupported')
    expect(spy.previews).toHaveLength(2)
    expect(oldRelay.spy.previews).toHaveLength(0)
    expect(oldHost.spy.previews).toHaveLength(0)
  })

  it('answers 503 when the host is offline or the call fails', async () => {
    const { botId, config } = await routed()
    const offline = appWith({ offline: true })
    const down = await preview(offline.app, botId, body(config))
    expect(down.statusCode, down.body).toBe(503)
    expect(down.json()).toMatchObject({ code: 'DAEMON_OFFLINE' })
    expect(offline.spy.previews).toHaveLength(0)
    const { app, spy } = appWith()
    spy.next = async () => {
      throw new NoConnection(DAEMON)
    }
    const failed = await preview(app, botId, body(config))
    expect(failed.statusCode, failed.body).toBe(503)
  })

  it('refuses viewers, invisible bots, invalid drafts, and recipients outside the bot', async () => {
    const { botId, config, decisionId, a } = await routed()
    const viewer = appWith({ userId: await member('viewer') })
    expect((await preview(viewer.app, botId, body(config))).statusCode).toBe(403)
    const { app } = appWith()
    expect((await preview(app, randomUUID(), body(config))).statusCode).toBe(404)
    const hidden = await seedBot({ restricted: true, prefix: 'hidden' })
    const collaborator = appWith({ userId: await member('collaborator') })
    const invisible = await preview(
      collaborator.app,
      hidden.botId,
      body(configOf(decisionId, hidden.a.agentId, hidden.b.agentId))
    )
    expect(invisible.statusCode, invisible.body).toBe(404)
    const duplicate = {
      ...config,
      rules: [
        {
          id: 'x',
          when: { type: 'choice', thresholds: { billing: 0.3 } },
          action: { type: 'agent', agentId: a.agentId }
        },
        { id: 'y', when: { type: 'choice', thresholds: { billing: 0.5 } }, action: { type: 'skip' } }
      ]
    }
    const invalid = await preview(app, botId, body(duplicate))
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().issues.map((i: { path: unknown[] }) => i.path)).toEqual([
      ['rules', 0, 'when'],
      ['rules', 1, 'when']
    ])
    const outsider = await preview(app, botId, body(config, { targets: { type: 'mention', agentIds: [randomUUID()] } }))
    expect(outsider.statusCode).toBe(400)
    expect(outsider.json().issues).toEqual([expect.objectContaining({ path: ['targets'] })])
    expect((await preview(app, botId, body(config, { channelId: 'D1' }))).statusCode).toBe(400)
    expect((await preview(app, botId, body(config, { channelId: 'C9' }))).statusCode).toBe(404)
    expect((await preview(app, botId, body({ ...config, decisionId: randomUUID() }))).json()).toMatchObject({
      code: 'DECISION_NOT_FOUND'
    })
  })
})
