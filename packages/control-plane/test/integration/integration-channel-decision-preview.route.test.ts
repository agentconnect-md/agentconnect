// Gate Try on the CP (decisions.md §6.3, §9.3): the consumer's serving daemon answers, the draft condition decides, nothing is written.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DECISION_PREVIEW_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  type DecisionDraft,
  type DecisionEvaluation,
  type DecisionPreviewRequest
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
const FEATURES = [DECISION_TRIGGER_V1_FEATURE, DECISION_PREVIEW_V1_FEATURE]

const boolDraft: DecisionDraft = {
  name: 'Needs help',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: { type: 'boolean', instructions: 'Is help needed?', criteria: { true: 'Yes', false: 'No' } }
}
const choiceDraft: DecisionDraft = {
  ...boolDraft,
  name: 'Topic',
  question: { type: 'choice', instructions: 'Which topic?', criteria: { billing: 'Money', tech: 'Code' } }
}
const yes: DecisionEvaluation = {
  status: 'answered',
  model: 'jev-1.13.0',
  answer: { type: 'boolean', value: true, probability: 0.9 },
  usage: { inputTokens: 20, outputTokens: 1 }
}
const sample = {
  history: [{ sender: 'U1', text: 'Is anyone around?' }],
  currentMessage: { sender: 'U2', text: 'My deploy is failing' }
}

class SpyControl {
  readonly previews: Array<{ daemonId: string; orgId: string; req: DecisionPreviewRequest }> = []
  next: (req: DecisionPreviewRequest) => Promise<{ evaluation: DecisionEvaluation }> = async () => ({
    evaluation: yes
  })
  async decisionPreview(daemonId: string, orgId: string, req: DecisionPreviewRequest) {
    this.previews.push({ daemonId, orgId, req })
    return this.next(req)
  }
  async integrationUpsert(): Promise<void> {}
  daemonFeatures(): readonly string[] {
    return FEATURES
  }
}

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

function appWith(opts: { features?: string[]; userId?: string; offline?: boolean } = {}) {
  const spy = new SpyControl()
  const liveness = {
    get: () => (opts.offline ? undefined : { state: 'READY', capabilities: { features: opts.features ?? FEATURES } })
  }
  const app = buildHttpApp(
    prisma,
    opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {},
    liveness as never,
    spy as unknown as ControlSender
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

async function seedInstall(
  opts: { name?: string; platform?: string; agent?: { visibility: 'restricted'; sharedWith: string[] } } = {}
) {
  if (!(await prisma.daemon.findUnique({ where: { id: DAEMON } }))) await seedDaemon(prisma, DAEMON)
  const botId = randomUUID()
  const platform = opts.platform ?? 'slack'
  await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform, name: `bot-${botId}` } })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, name: opts.name ?? 'helper', ...(opts.agent ?? {}) })
  const integrationId = randomUUID()
  await prisma.integration.create({
    data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform, name: 'b' }
  })
  await prisma.integrationChannel.createMany({
    data: [
      { integrationId, channelId: 'C1', name: 'general', trigger: 'mention', agentId },
      { integrationId, channelId: 'D1', name: 'alice', kind: 'im', trigger: 'any' }
    ]
  })
  return { integrationId, agentId }
}

async function createDecision(app: HttpApp, draft: DecisionDraft = boolDraft): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}

const preview = (app: HttpApp, integrationId: string, channelId: string, payload: Record<string, unknown>) =>
  app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations/${integrationId}/channels/${channelId}/decision-preview`,
    payload
  })
const gate = (decisionId: string, when: unknown = { type: 'boolean', values: [true] }) => ({
  decisionBinding: { type: 'gate', decisionId, when },
  state: sample
})

describe('POST /integrations/:id/channels/:channelId/decision-preview', () => {
  it('runs the draft on the serving daemon and answers Would trigger with the fixed target', async () => {
    const { integrationId, agentId } = await seedInstall()
    const { app, spy } = appWith()
    const decisionId = await createDecision(app)
    const res = await preview(app, integrationId, 'C1', gate(decisionId))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({
      mode: 'live',
      readiness: { status: 'ready' },
      evaluation: yes,
      consumer: {
        type: 'gate',
        outcome: 'trigger',
        matched: true,
        matchedKeys: [],
        target: { agentId, name: 'helper' }
      }
    })
    expect(spy.previews).toHaveLength(1)
    const sent = spy.previews[0]!
    expect(sent).toMatchObject({ daemonId: DAEMON, orgId: DEFAULT_ORG_ID, req: { agentId } })
    expect(sent.req.decision).toMatchObject({
      providerId: 'typesafe',
      model: 'jev-1.13.0',
      question: boolDraft.question
    })
    expect(sent.req.state).toMatchObject({
      currentMessage: { sender: { id: 'U2' }, text: 'My deploy is failing', threadId: null },
      history: [{ sender: { id: 'U1' }, text: 'Is anyone around?' }],
      conversation: { name: 'general' },
      addressing: { target: { agentId, via: 'implicit' } }
    })
    // Writes nothing: no session, and the conversation row is untouched.
    expect(await prisma.sessionMeta.count()).toBe(0)
    expect(await prisma.integrationChannel.findFirst({ where: { integrationId, channelId: 'C1' } })).toMatchObject({
      trigger: 'mention',
      decisionBinding: null
    })
  })

  it('answers Would skip with matched keys from the draft condition, and unavailable is never a skip', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith()
    const decisionId = await createDecision(app, choiceDraft)
    spy.next = async () => ({
      evaluation: {
        status: 'answered',
        model: 'jev-1.13.0',
        answer: { type: 'choice', value: 'billing', probabilities: { billing: 0.7, tech: 0.3 }, confidence: 0.7 },
        usage: { inputTokens: 1, outputTokens: 1 }
      }
    })
    const matched = await preview(
      app,
      integrationId,
      'C1',
      gate(decisionId, { type: 'choice', thresholds: { billing: 0.5 } })
    )
    expect(matched.json().consumer).toMatchObject({ outcome: 'trigger', matchedKeys: ['billing'] })
    const skipped = await preview(
      app,
      integrationId,
      'C1',
      gate(decisionId, { type: 'choice', thresholds: { tech: 0.5 } })
    )
    expect(skipped.json().consumer).toMatchObject({ outcome: 'skip', matched: false, matchedKeys: [] })
    spy.next = async () => ({ evaluation: { status: 'unavailable', reason: 'provider' } })
    const failed = await preview(
      app,
      integrationId,
      'C1',
      gate(decisionId, { type: 'choice', thresholds: { tech: 0.5 } })
    )
    expect(failed.statusCode).toBe(200)
    expect(failed.json()).toMatchObject({
      evaluation: { status: 'unavailable', reason: 'provider' },
      consumer: { outcome: 'unavailable', matched: false }
    })
  })

  it('refuses viewers, invisible agents, DMs, owner-as-default platforms, hidden Decisions, and bad conditions', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith()
    const decisionId = await createDecision(app)
    const viewer = appWith({ userId: await member('viewer') }).app
    expect((await preview(viewer, integrationId, 'C1', gate(decisionId))).statusCode).toBe(403)
    const hidden = await seedInstall({
      name: 'hidden',
      agent: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const collaborator = appWith({ userId: await member('collaborator') }).app
    expect((await preview(collaborator, hidden.integrationId, 'C1', gate(decisionId))).statusCode).toBe(404)
    expect((await preview(app, integrationId, 'D1', gate(decisionId))).statusCode).toBe(400)
    const linear = await seedInstall({ name: 'linear-agent', platform: 'linear' })
    const owned = await preview(app, linear.integrationId, 'C1', gate(decisionId))
    expect(owned.statusCode).toBe(400)
    expect(owned.json().message).toBe('By decision is not available for this platform')
    const restricted = await createDecision(app, {
      ...boolDraft,
      name: 'Private',
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    const missing = await preview(collaborator, integrationId, 'C1', gate(restricted))
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'DECISION_NOT_FOUND' })
    const invalid = await preview(app, integrationId, 'C1', gate(decisionId, { type: 'score', min: 0, max: 1 }))
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().issues).toEqual([expect.objectContaining({ path: ['type'] })])
    expect((await preview(app, integrationId, 'C9', gate(decisionId))).statusCode).toBe(404)
    expect(spy.previews).toHaveLength(0)
  })

  it('returns Not applied for off, unsupported, and Needs review without calling the daemon', async () => {
    const { integrationId } = await seedInstall()
    const { app, spy } = appWith()
    const decisionId = await createDecision(app)
    const binding = { type: 'gate', decisionId, when: { type: 'boolean', values: [true] } }
    await prisma.integrationChannel.updateMany({
      where: { integrationId, channelId: 'C1' },
      data: { trigger: 'decision', decisionBinding: binding, decisionId, decisionNeedsReview: true }
    })
    const review = await preview(app, integrationId, 'C1', gate(decisionId))
    expect(review.json()).toMatchObject({
      evaluation: null,
      readiness: { status: 'needs_review' },
      consumer: { outcome: 'not_applied', notAppliedReason: 'needs_review' }
    })
    // A repaired draft is no longer the saved stranded condition, so it runs.
    expect(
      (await preview(app, integrationId, 'C1', gate(decisionId, { type: 'boolean', values: [false] }))).json().consumer
    ).toMatchObject({ outcome: 'skip' })
    expect(spy.previews).toHaveLength(1)

    const old = appWith({ features: [] })
    const unsupported = await preview(
      old.app,
      integrationId,
      'C1',
      gate(decisionId, { type: 'boolean', values: [false] })
    )
    expect(unsupported.json().consumer).toMatchObject({ outcome: 'not_applied', notAppliedReason: 'unsupported' })
    const noPreview = appWith({ features: [DECISION_TRIGGER_V1_FEATURE] })
    expect(
      (await preview(noPreview.app, integrationId, 'C1', gate(decisionId, { type: 'boolean', values: [false] }))).json()
        .consumer
    ).toMatchObject({ outcome: 'not_applied', notAppliedReason: 'unsupported' })
    await prisma.integration.update({ where: { id: integrationId }, data: { status: 'revoked' } })
    expect((await preview(app, integrationId, 'C1', gate(decisionId))).json().consumer).toMatchObject({
      outcome: 'not_applied',
      notAppliedReason: 'off'
    })
    expect(old.spy.previews).toHaveLength(0)
    expect(noPreview.spy.previews).toHaveLength(0)
    expect(spy.previews).toHaveLength(1)
  })

  it('answers 503 offline and on a transport failure, and 404 when the Decision disappears mid-call', async () => {
    const { integrationId } = await seedInstall()
    const offline = appWith({ offline: true })
    const decisionId = await createDecision(offline.app)
    expect((await preview(offline.app, integrationId, 'C1', gate(decisionId))).statusCode).toBe(503)
    expect(offline.spy.previews).toHaveLength(0)
    const { app, spy } = appWith()
    spy.next = async () => {
      throw new NoConnection(DAEMON)
    }
    expect((await preview(app, integrationId, 'C1', gate(decisionId))).statusCode).toBe(503)
    spy.next = async () => {
      await prisma.decision.delete({ where: { id: decisionId } })
      return { evaluation: yes }
    }
    expect((await preview(app, integrationId, 'C1', gate(decisionId))).statusCode).toBe(404)
    expect(await prisma.sessionMeta.count()).toBe(0)
  })
})
