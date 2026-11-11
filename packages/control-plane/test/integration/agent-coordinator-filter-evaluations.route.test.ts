// auto-session-mode.md §4.7: an agent's coordinator filter verdicts, proxied from its serving daemon to its editors.
import { describe, it, expect, afterEach } from 'vitest'
import {
  COORDINATOR_FILTER_DECISION_ID,
  COORDINATOR_FILTER_EVALUATIONS_V1_FEATURE,
  SESSION_MODE_AUTO_V1_FEATURE,
  type DecisionEvaluationRecord
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const AGENT = 'c7c7c7c7-cccc-4ccc-8ccc-c7c7c7c7c7c7'
const DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-d7d7d7d7d7d7'

const opened: HttpApp[] = []
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close()
})

async function makeUser(sub: string, role: 'collaborator' | 'viewer'): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

describe('coordinator filter evaluations', () => {
  const row: DecisionEvaluationRecord = {
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    messageId: 'slack:C1:1.1',
    title: 'lunch anyone?',
    decisionId: COORDINATOR_FILTER_DECISION_ID,
    outcome: 'skipped',
    reason: null,
    answer: { type: 'boolean', value: false, probability: 0.05 },
    matchedKeys: [],
    latencyMs: 30,
    requestedModel: 'jev-1.13.0',
    actualModel: 'jev-1.13.0',
    usage: { inputTokens: 1, outputTokens: 1 },
    detailsExpired: false
  }

  it('proxies the verdicts from the serving daemon to those who can edit the agent', async () => {
    const viewer = await makeUser('filter-eval-viewer', 'viewer')
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [viewer] })
    const requests: unknown[] = []
    const control = {
      coordinatorFilterEvaluations: async (_daemonId: string, _orgId: string, req: unknown) => {
        requests.push(req)
        return { items: [row], nextCursor: null }
      },
      coordinatorFilterEvaluation: async (_daemonId: string, _orgId: string, req: { seq: number }) => ({
        evaluation: req.seq === 1 ? { ...row, snapshot: null, input: null, fullAnswer: null, evidence: null } : null
      })
    }
    let features = [COORDINATOR_FILTER_EVALUATIONS_V1_FEATURE]
    const liveness = { get: () => ({ state: 'READY', capabilities: { features } }) }
    const build = (over?: Parameters<typeof buildHttpApp>[1]) => {
      const a = buildHttpApp(prisma, over, liveness as never, control as unknown as ControlSender)
      opened.push(a)
      return a
    }
    const a = build()
    const url = `${ORG}/agents/${AGENT}/coordinator-filter/evaluations`

    const page = await a.app.inject({ method: 'GET', url: `${url}?limit=5` })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toEqual({ items: [row], nextCursor: null })
    expect(requests).toEqual([{ agentId: AGENT, limit: 5 }])
    expect((await a.app.inject({ method: 'GET', url: `${url}/1` })).json()).toMatchObject({
      seq: 1,
      title: 'lunch anyone?'
    })
    expect((await a.app.inject({ method: 'GET', url: `${url}/2` })).statusCode).toBe(404)

    // A viewer sees the agent, not the messages its filter judged.
    expect((await build({ DEFAULT_OWNER_ID: viewer }).app.inject({ method: 'GET', url })).statusCode).toBe(403)

    features = [SESSION_MODE_AUTO_V1_FEATURE]
    const old = await a.app.inject({ method: 'GET', url })
    expect(old.statusCode).toBe(503)
    expect(old.json().code).toBe('DAEMON_UPGRADE_REQUIRED')
  })
})
