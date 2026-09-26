// Recent evaluations on the CP (decisions.md §9.5): the conversation audience gates a proxied, never-persisted daemon read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DECISION_EVALUATIONS_V1_FEATURE,
  DECISION_EVALUATION_FILTER_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  type DecisionEvaluationConversation,
  type DecisionEvaluationRecordDetail,
  type DecisionEvaluationRecordPage,
  type DecisionEvaluationReply,
  type DecisionEvaluationRequest,
  type DecisionEvaluationsReply,
  type DecisionEvaluationsRequest
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { OrgId } from '../../src/domain/ids.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd4d4d4d4-dddd-4ddd-8ddd-dddddddddddd'
const SECOND = 'd5d5d5d5-dddd-4ddd-8ddd-dddddddddddd'
const FEATURES = [DECISION_TRIGGER_V1_FEATURE, DECISION_EVALUATIONS_V1_FEATURE, DECISION_EVALUATION_FILTER_V1_FEATURE]
const DECISION = '33333333-3333-4333-8333-333333333333'

const row = {
  seq: 12,
  at: '2026-01-01T00:00:00.000Z',
  messageId: '1700000000.0001',
  decisionId: 'd-1',
  outcome: 'triggered' as const,
  reason: null,
  answer: { type: 'boolean' as const, value: true, probability: 0.9 },
  matchedKeys: [],
  latencyMs: 80,
  requestedModel: 'jev-latest',
  actualModel: 'jev-1.13.0',
  usage: { inputTokens: 10, outputTokens: 1 },
  detailsExpired: false
}
const page: DecisionEvaluationRecordPage = { items: [row], nextCursor: 12 }
const detail: DecisionEvaluationRecordDetail = {
  ...row,
  snapshot: {
    decisionId: 'd-1',
    providerId: 'typesafe',
    model: 'jev-latest',
    question: { type: 'boolean', instructions: 'Reply?', criteria: { true: 'Yes', false: 'No' } },
    condition: { type: 'boolean', values: [true] },
    sessionMode: 'createNew'
  },
  input: {
    currentMessage: { id: 'm1', sender: { id: 'U1' }, text: 'SECRET-BODY', threadId: null },
    history: [],
    historyOmitted: 0,
    context: { partial: false, reasons: [], omittedMessages: 0 }
  },
  fullAnswer: { type: 'boolean', value: true, probability: 0.9 },
  rawRequest: { text: '{"model":"jev-latest"}', truncated: false },
  rawResponse: { text: '{"model":"jev-1.13.0"}', truncated: true },
  evidence: { snapshotSeq: 12, suppliedBackground: 0 }
}

// The namespace seeded sessions carry by default: Slack with no stamped tenant scope.
const UNSCOPED: DecisionEvaluationConversation = { platform: 'slack', tenantScope: null }

class SpyControl {
  readonly lists: Array<{ daemonId: string; orgId: string; req: DecisionEvaluationsRequest }> = []
  readonly gets: Array<{ daemonId: string; orgId: string; req: DecisionEvaluationRequest }> = []
  scopeOf: (integrationId: string) => DecisionEvaluationConversation | undefined = () => UNSCOPED
  list: (daemonId: string, req: DecisionEvaluationsRequest) => Promise<DecisionEvaluationsReply> = async (_, req) =>
    this.scoped(page, req.integrationId)
  get: (daemonId: string, req: DecisionEvaluationRequest) => Promise<DecisionEvaluationReply> = async (_, req) =>
    this.scoped({ evaluation: detail }, req.integrationId)
  scoped<T extends object>(body: T, integrationId: string): T & { conversation?: DecisionEvaluationConversation } {
    const conversation = this.scopeOf(integrationId)
    return conversation ? { ...body, conversation } : body
  }
  async decisionEvaluations(daemonId: string, orgId: string, req: DecisionEvaluationsRequest) {
    this.lists.push({ daemonId, orgId, req })
    return this.list(daemonId, req)
  }
  async decisionEvaluation(daemonId: string, orgId: string, req: DecisionEvaluationRequest) {
    this.gets.push({ daemonId, orgId, req })
    return this.get(daemonId, req)
  }
  daemonFeatures(): readonly string[] {
    return FEATURES
  }
}

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

function appWith(
  opts: { userId?: string; features?: Record<string, string[]>; plugins?: HttpApp['deps']['sessionAccessPlugins'] } = {}
) {
  const spy = new SpyControl()
  const liveness = {
    get: (daemonId: string) => {
      const features = opts.features ? opts.features[daemonId] : FEATURES
      return features ? { state: 'READY', capabilities: { features } } : undefined
    }
  }
  const app = buildHttpApp(
    prisma,
    opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {},
    liveness as never,
    spy as unknown as ControlSender,
    opts.plugins ? { sessionAccessPlugins: opts.plugins } : undefined
  )
  running.push(app)
  return { app, spy }
}

async function member(role: 'viewer' | 'collaborator') {
  const repo = new PgUserRepo(prisma)
  const email = `${role}-${randomUUID()}@example.test`
  const { userId } = await repo.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
  await repo.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function seedInstall(opts: { name?: string; agent?: { visibility: 'restricted'; sharedWith: string[] } } = {}) {
  for (const id of [DAEMON, SECOND])
    if (!(await prisma.daemon.findUnique({ where: { id } }))) await seedDaemon(prisma, id)
  const botId = randomUUID()
  await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `bot-${botId}` } })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, name: opts.name ?? 'helper', ...(opts.agent ?? {}) })
  const integrationId = randomUUID()
  await prisma.integration.create({
    data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'b' }
  })
  await prisma.integrationChannel.createMany({
    data: [
      { integrationId, channelId: 'C1', name: 'general', trigger: 'mention', agentId },
      { integrationId, channelId: 'D1', name: 'alice', kind: 'im', trigger: 'any' }
    ]
  })
  return { integrationId, agentId }
}

// A second install of the same agent on another bot whose platform reuses the channel id C1.
async function seedSecondInstall(agentId: string) {
  const botId = randomUUID()
  await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `bot-${botId}` } })
  const integrationId = randomUUID()
  await prisma.integration.create({
    data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'b2' }
  })
  await prisma.integrationChannel.create({
    data: { integrationId, channelId: 'C1', name: 'general', trigger: 'mention', agentId }
  })
  return integrationId
}

const list = (app: HttpApp, integrationId: string, channelId = 'C1', query = '') =>
  app.app.inject({
    method: 'GET',
    url: `${ORG}/integrations/${integrationId}/channels/${channelId}/decision-evaluations${query}`
  })
const get = (app: HttpApp, integrationId: string, seq: number | string, channelId = 'C1') =>
  app.app.inject({
    method: 'GET',
    url: `${ORG}/integrations/${integrationId}/channels/${channelId}/decision-evaluations/${seq}`
  })

async function contentRows(): Promise<number> {
  const [sessions, audits] = await Promise.all([prisma.sessionMeta.count(), prisma.auditEvent.count()])
  return sessions + audits
}

describe('GET /integrations/:id/channels/:channelId/decision-evaluations', () => {
  it('proxies the page as-is to a viewer, forwarding cursor and limit, and stores nothing', async () => {
    const { integrationId, agentId } = await seedInstall()
    await seedSessionMeta(prisma, 'audience', agentId, { channel: 'C1' })
    const before = await contentRows()
    const { app, spy } = appWith({ userId: await member('viewer') })
    const res = await list(app, integrationId, 'C1', '?cursor=40&limit=5')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual(page)
    expect(spy.lists).toEqual([
      {
        daemonId: DAEMON,
        orgId: DEFAULT_ORG_ID,
        req: { agentId, integrationId, channel: 'C1', cursor: 40, limit: 5 }
      }
    ])
    expect((await list(app, integrationId)).statusCode).toBe(200)
    expect(spy.lists.at(-1)!.req).toEqual({ agentId, integrationId, channel: 'C1', limit: 20 })
    expect((await list(app, integrationId, 'C1', `?decisionId=${DECISION}`)).statusCode).toBe(200)
    expect(spy.lists.at(-1)!.req).toEqual({ agentId, integrationId, channel: 'C1', decisionId: DECISION, limit: 20 })
    const old = appWith({ features: { [DAEMON]: [DECISION_TRIGGER_V1_FEATURE, DECISION_EVALUATIONS_V1_FEATURE] } })
    expect((await list(old.app, integrationId, 'C1', `?decisionId=${DECISION}`)).json()).toMatchObject({
      code: 'DAEMON_UPGRADE_REQUIRED'
    })
    expect(old.spy.lists).toEqual([])
    const one = await get(app, integrationId, 12)
    expect(one.statusCode, one.body).toBe(200)
    expect(one.json()).toEqual(detail)
    expect(spy.gets.at(-1)!.req).toEqual({ agentId, integrationId, channel: 'C1', seq: 12 })
    expect(await contentRows()).toBe(before)
    expect(JSON.stringify(await prisma.integrationChannel.findMany())).not.toContain('SECRET-BODY')
  })

  it('lists summaries to a viewer before any session exists but keeps the bodies behind agent edit access', async () => {
    const { integrationId, agentId } = await seedInstall()
    const viewer = appWith({ userId: await member('viewer') })
    expect((await list(viewer.app, integrationId)).statusCode).toBe(200)
    const denied = await get(viewer.app, integrationId, 12)
    expect(denied.statusCode).toBe(404)
    expect(denied.body).not.toContain('SECRET-BODY')
    const collaborator = appWith({ userId: await member('collaborator') })
    expect((await get(collaborator.app, integrationId, 12)).statusCode).toBe(200)
    await seedSessionMeta(prisma, 'audience', agentId, { channel: 'C1' })
    expect((await get(viewer.app, integrationId, 12)).statusCode).toBe(200)
  })

  it('hides a conversation whose agent or newest session the caller cannot read', async () => {
    const hidden = await seedInstall({
      name: 'hidden',
      agent: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const collaborator = appWith({ userId: await member('collaborator') })
    expect((await list(collaborator.app, hidden.integrationId)).statusCode).toBe(404)
    const { integrationId, agentId } = await seedInstall()
    expect((await list(collaborator.app, integrationId, 'D1')).statusCode).toBe(404)
    expect((await list(collaborator.app, integrationId, 'C9')).statusCode).toBe(404)
    await seedSessionMeta(prisma, 'older', agentId, { channel: 'C1', startedAt: new Date(Date.now() - 60_000) })
    expect((await list(collaborator.app, integrationId)).statusCode).toBe(200)
    await seedSessionMeta(prisma, 'newest', agentId, {
      channel: 'C1',
      visibility: 'private',
      ownerIdentity: 'user:someone-else'
    })
    expect((await list(collaborator.app, integrationId)).statusCode).toBe(404)
    const denied = await get(collaborator.app, integrationId, 12)
    expect(denied.statusCode).toBe(404)
    expect(denied.body).not.toContain('SECRET-BODY')
    // Pre-checks refuse without a daemon call; the audience check discards the replies it refuses.
    expect(collaborator.spy.lists).toHaveLength(2)
    expect(collaborator.spy.gets).toHaveLength(1)
  })

  it('checks the audience of the install namespace the daemon names, not a same-id channel on another install', async () => {
    const { integrationId: a, agentId } = await seedInstall()
    const b = await seedSecondInstall(agentId)
    const scopes: Record<string, DecisionEvaluationConversation> = {
      [a]: { platform: 'slack', tenantScope: 'T-A' },
      [b]: { platform: 'slack', tenantScope: 'T-B' }
    }
    const reader = appWith({ userId: await member('collaborator') })
    reader.spy.scopeOf = (integrationId) => scopes[integrationId]
    await seedSessionMeta(prisma, 'a-private', agentId, {
      channel: 'C1',
      tenantScope: 'T-A',
      visibility: 'private',
      ownerIdentity: 'user:someone-else',
      startedAt: new Date(Date.now() - 60_000)
    })
    await seedSessionMeta(prisma, 'b-open', agentId, { channel: 'C1', tenantScope: 'T-B' })
    const hiddenList = await list(reader.app, a)
    expect(hiddenList.statusCode).toBe(404)
    const hiddenDetail = await get(reader.app, a, 12)
    expect(hiddenDetail.statusCode).toBe(404)
    expect(hiddenDetail.body).not.toContain('SECRET-BODY')
    expect(reader.spy.gets.at(-1)!.req.integrationId).toBe(a)
    expect((await list(reader.app, b)).statusCode).toBe(200)

    await prisma.sessionMeta.update({ where: { id: 'a-private' }, data: { visibility: 'org', ownerIdentity: null } })
    await prisma.sessionMeta.update({
      where: { id: 'b-open' },
      data: { visibility: 'private', ownerIdentity: 'user:someone-else' }
    })
    const shown = await list(reader.app, a)
    expect(shown.statusCode, shown.body).toBe(200)
    expect(shown.json()).toEqual(page)
    expect((await get(reader.app, a, 12)).json()).toEqual(detail)
    expect((await list(reader.app, b)).statusCode).toBe(404)
  })

  it('fails closed with 503 when the daemon reply names no namespace', async () => {
    const { integrationId, agentId } = await seedInstall()
    await seedSessionMeta(prisma, 'audience', agentId, { channel: 'C1' })
    const { app, spy } = appWith({ userId: await member('collaborator') })
    spy.scopeOf = () => undefined
    for (const res of [await list(app, integrationId), await get(app, integrationId, 12)]) {
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'DAEMON_UPGRADE_REQUIRED' })
      expect(res.body).not.toContain('SECRET-BODY')
      expect(res.body).not.toContain('jev-1.13.0')
    }
  })

  it('fails closed without a session while an external-access policy is active', async () => {
    const { integrationId } = await seedInstall()
    await new PgSessionRepo(prisma).setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    const plugins = [
      { provider: 'slack', available: true, resolve: async () => ({ allowedScopes: [], degraded: false }) }
    ]
    const { app } = appWith({ plugins })
    const res = await list(app, integrationId)
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('jev-1.13.0')
  })

  it('answers 503 offline or unsupported with distinct messages, and moves past a daemon that refuses the lane', async () => {
    const { integrationId } = await seedInstall()
    const offline = appWith({ features: {} })
    const down = await list(offline.app, integrationId)
    expect(down.statusCode).toBe(503)
    expect(down.json()).toMatchObject({ message: 'owning daemon is offline', code: 'DAEMON_OFFLINE' })
    const old = appWith({ features: { [DAEMON]: [DECISION_TRIGGER_V1_FEATURE] } })
    const upgrade = await list(old.app, integrationId)
    expect(upgrade.statusCode).toBe(503)
    expect(upgrade.json()).toMatchObject({ code: 'DAEMON_UPGRADE_REQUIRED', message: expect.stringMatching(/upgrade/) })
    expect([...offline.spy.lists, ...old.spy.lists]).toHaveLength(0)

    const two = appWith({ features: { [DAEMON]: FEATURES, [SECOND]: FEATURES } })
    vi.spyOn(two.app.deps.placementResolver, 'servingDaemons').mockResolvedValue([DAEMON, SECOND])
    two.spy.list = async (daemonId, req) => {
      if (daemonId === DAEMON) throw new ProtocolError('SCOPE_DENIED', 'not served here')
      return two.spy.scoped(page, req.integrationId)
    }
    const moved = await list(two.app, integrationId)
    expect(moved.statusCode).toBe(200)
    expect(two.spy.lists.map((call) => call.daemonId)).toEqual([DAEMON, SECOND])
    two.spy.list = async (daemonId) => {
      if (daemonId === DAEMON) throw new ProtocolError('SCOPE_DENIED', 'not served here')
      throw new NoConnection(daemonId)
    }
    expect((await list(two.app, integrationId)).statusCode).toBe(503)
  })

  it('returns 404 for a detail the daemon no longer holds and re-checks access after the reply', async () => {
    const { integrationId, agentId } = await seedInstall()
    const collaborator = appWith({ userId: await member('collaborator') })
    collaborator.spy.get = async () => ({ evaluation: null, conversation: UNSCOPED })
    expect((await get(collaborator.app, integrationId, 3)).statusCode).toBe(404)
    expect((await get(collaborator.app, integrationId, 'abc')).statusCode).toBe(400)
    collaborator.spy.list = async () => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
      })
      return { ...page, conversation: UNSCOPED }
    }
    expect((await list(collaborator.app, integrationId)).statusCode).toBe(404)
  })
})
