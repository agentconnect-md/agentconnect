import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DECISION_MODEL_SESSION_FILTER_V1_FEATURE,
  DECISION_EVALUATION_FILTER_V1_FEATURE,
  DECISION_MODEL_EVALUATIONS_V1_FEATURE,
  type DecisionModelEvaluationRecord
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-dddddddddddd'
const DECISION = '33333333-3333-4333-8333-333333333333'
const row = (seq: number, sessionId: string): DecisionModelEvaluationRecord => ({
  seq,
  at: '2026-01-01T00:00:00.000Z',
  sessionId,
  title: 'PR #42: Fix the parser',
  decisionId: DECISION,
  outcome: 'selected',
  reason: null,
  target: { runtime: 'claude', model: 'chosen' },
  answer: { type: 'boolean', value: true, probability: 0.9 },
  requestedModel: 'jev-latest',
  actualModel: 'jev-latest',
  latencyMs: 12,
  usage: { inputTokens: 1, outputTokens: 1 },
  detailsExpired: false
})

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

describe('agent model evaluation reads', () => {
  it('keeps the Agent entrypoint scoped to visible sessions', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const publicId = randomUUID()
    const privateId = randomUUID()
    await seedSessionMeta(prisma, publicId, agentId)
    await seedSessionMeta(prisma, privateId, agentId, { visibility: 'private', ownerIdentity: 'other-user' })
    const email = `${randomUUID()}@example.test`
    const user = new PgUserRepo(prisma)
    const { userId } = await user.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
    await user.addMemberByEmail(DEFAULT_ORG_ID, email, 'viewer')
    const rows = [row(2, privateId), row(1, publicId)]
    let requestedDecisionId: string | undefined
    let requestedSessionId: string | undefined
    const control = {
      decisionModelEvaluations: async (
        _daemonId: string,
        _orgId: string,
        req: { decisionId?: string; sessionId?: string }
      ) => {
        requestedDecisionId = req.decisionId
        requestedSessionId = req.sessionId
        return { items: rows, nextCursor: null }
      },
      decisionModelEvaluation: async (_daemonId: string, _orgId: string, req: { seq: number }) => ({
        evaluation: {
          ...rows.find((item) => item.seq === req.seq)!,
          selection: null,
          question: null,
          input: { currentMessage: { text: 'SECRET-BODY' } },
          fullAnswer: null,
          rawRequest: null,
          rawResponse: null
        }
      })
    }
    let features = [
      DECISION_MODEL_EVALUATIONS_V1_FEATURE,
      DECISION_EVALUATION_FILTER_V1_FEATURE,
      DECISION_MODEL_SESSION_FILTER_V1_FEATURE
    ]
    const liveness = {
      get: () => ({
        state: 'READY',
        capabilities: { features }
      })
    }
    const app = buildHttpApp(
      prisma,
      { DEFAULT_OWNER_ID: userId },
      liveness as never,
      control as unknown as ControlSender
    )
    running.push(app)
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/model-evaluations` })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().items).toEqual([rows[1]])
    // A row the daemon could not title, its session row aged out, takes the CP's session title.
    await prisma.sessionMeta.update({ where: { id: publicId }, data: { title: 'Deploy the hotfix' } })
    rows[1] = { ...rows[1]!, title: null }
    const fallback = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/model-evaluations` })
    expect(fallback.json().items).toEqual([{ ...rows[1], title: 'Deploy the hotfix' }])
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/model-evaluations/1` })).json().title
    ).toBe('Deploy the hotfix')
    rows[1] = { ...rows[1], title: 'PR #42: Fix the parser' }
    const filtered = await app.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/model-evaluations?decisionId=${DECISION}`
    })
    expect(filtered.statusCode, filtered.body).toBe(200)
    expect(requestedDecisionId).toBe(DECISION)
    expect(filtered.json().items).toEqual([rows[1]])
    const sessionFiltered = await app.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/model-evaluations?sessionId=${publicId}`
    })
    expect(sessionFiltered.statusCode, sessionFiltered.body).toBe(200)
    expect(requestedSessionId).toBe(publicId)
    expect(sessionFiltered.json().items).toEqual([rows[1]])
    const hiddenSession = await app.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/model-evaluations?sessionId=${privateId}`
    })
    expect(hiddenSession.json().items).toEqual([])
    features = [DECISION_MODEL_EVALUATIONS_V1_FEATURE]
    const oldSessionHost = await app.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/model-evaluations?sessionId=${publicId}`
    })
    expect(oldSessionHost.statusCode).toBe(503)
    expect(oldSessionHost.json().code).toBe('DAEMON_UPGRADE_REQUIRED')
    const oldHost = await app.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/model-evaluations?decisionId=${DECISION}`
    })
    expect(oldHost.statusCode).toBe(503)
    expect(oldHost.json().code).toBe('DAEMON_UPGRADE_REQUIRED')
    const allowed = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/model-evaluations/1` })
    expect(allowed.statusCode, allowed.body).toBe(200)
    expect(allowed.json().title).toBe('PR #42: Fix the parser')
    const denied = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/model-evaluations/2` })
    expect(denied.statusCode).toBe(404)
    expect(denied.body).not.toContain('SECRET-BODY')
  })
})
