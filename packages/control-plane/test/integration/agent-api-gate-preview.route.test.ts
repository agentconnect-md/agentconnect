// API gate Try on the CP (shared-bot-relay.md §10.4, decisions.md §9.3): the live gate's state, the draft condition, nothing written.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  API_DECISION_GATE_V1_FEATURE,
  DECISION_CHAIN_V1_FEATURE,
  DECISION_PREVIEW_V1_FEATURE,
  type DecisionEvaluation,
  type DecisionPreviewRequest
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const AGENT = 'a9a9a9a9-aaaa-4aaa-8aaa-a9a9a9a9a9a9'
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const FEATURES = [API_DECISION_GATE_V1_FEATURE, DECISION_PREVIEW_V1_FEATURE, DECISION_CHAIN_V1_FEATURE]
const draft = {
  name: 'On topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: { type: 'boolean', instructions: 'Is it about the product?', criteria: { true: 'Yes', false: 'No' } }
}
const yes: DecisionEvaluation = {
  status: 'answered',
  model: 'jev-1.13.0',
  answer: { type: 'boolean', value: true, probability: 0.9 },
  usage: { inputTokens: 20, outputTokens: 1 }
}

type HttpApp = ReturnType<typeof buildHttpApp>
const opened: HttpApp[] = []
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close()
})

function open(opts: { features?: string[]; offline?: boolean; userId?: string } = {}) {
  const previews: DecisionPreviewRequest[] = []
  const control = {
    next: async (): Promise<{ evaluation: DecisionEvaluation }> => ({ evaluation: yes }),
    async decisionPreview(_daemonId: string, _orgId: string, req: DecisionPreviewRequest) {
      previews.push(req)
      return this.next()
    },
    async agentUpsert(): Promise<void> {}
  }
  const liveness = {
    get: () => (opts.offline ? undefined : { state: 'READY', capabilities: { features: opts.features ?? FEATURES } })
  }
  const a = buildHttpApp(
    prisma,
    opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : undefined,
    liveness as never,
    control as unknown as ControlSender
  )
  opened.push(a)
  return { a, previews, control }
}

async function setup(a: HttpApp, agent: Parameters<typeof seedAgent>[2] = {}) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, name: 'docs-helper', ...agent })
  expect((await a.app.inject({ method: 'PUT', url: `${ORG}/agents/${AGENT}/api/ai-sdk-ui` })).statusCode).toBe(200)
  const res = await a.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  return (res.json() as { id: string }).id
}

const gateOf = (decisionId: string, values = [true]) => ({
  type: 'gate',
  decisionId,
  when: { type: 'boolean', values }
})
const preview = (a: HttpApp, payload: Record<string, unknown>, protocol = 'ai-sdk-ui') =>
  a.app.inject({ method: 'POST', url: `${ORG}/agents/${AGENT}/api/${protocol}/gate/preview`, payload })
const state = { currentMessage: { text: 'How do I install the CLI?' } }

describe('POST /agents/:agentId/api/:protocol/gate/preview', () => {
  it("runs the draft on the serving daemon in the live gate's state and admits the call", async () => {
    const { a, previews } = open()
    const decisionId = await setup(a)
    const res = await preview(a, { gate: gateOf(decisionId), state })
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
        target: { agentId: AGENT, name: 'docs-helper' }
      }
    })
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({ agentId: AGENT, decision: { model: 'jev-1.13.0' } })
    expect(previews[0]!.state).toEqual({
      source: 'chat',
      agent: expect.objectContaining({ name: 'docs-helper' }),
      currentMessage: { text: 'How do I install the CLI?' },
      history: [],
      truncated: false
    })
    // Writes nothing: the saved gate stays unset.
    const entries = (await a.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/api` })).json()
    expect(entries).toMatchObject({ entries: [{ protocol: 'ai-sdk-ui', gate: null }] })
  })

  it('answers skip for an unmatched condition and unavailable for a provider failure, never a skip', async () => {
    const { a, control } = open()
    const decisionId = await setup(a)
    expect((await preview(a, { gate: gateOf(decisionId, [false]), state })).json().consumer).toMatchObject({
      outcome: 'skip',
      matched: false
    })
    control.next = async () => ({ evaluation: { status: 'unavailable', reason: 'timeout' } })
    const failed = (await preview(a, { gate: gateOf(decisionId), state })).json()
    expect(failed.consumer.outcome).toBe('unavailable')
    expect(failed.evaluation).toEqual({ status: 'unavailable', reason: 'timeout' })
  })

  it('refuses history, bound fields, an API the agent has not added, and a hidden Decision', async () => {
    const { a, previews } = open()
    const decisionId = await setup(a)
    const history = await preview(a, { gate: gateOf(decisionId), state: { ...state, history: [{ text: 'x' }] } })
    expect(history.statusCode).toBe(400)
    const bound = await preview(a, { gate: gateOf(decisionId), state: { ...state, agent: { name: 'x' } } })
    expect(bound.statusCode).toBe(400)
    expect((await preview(a, { gate: gateOf(decisionId), state }, 'ag-ui')).statusCode).toBe(404)
    const hidden = await preview(a, { gate: gateOf(randomUUID()), state })
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toMatchObject({ code: 'DECISION_NOT_FOUND' })
    expect(previews).toHaveLength(0)
  })

  it('is Not applied on a daemon that cannot preview, and 503 while none is connected', async () => {
    const outdated = open({ features: [API_DECISION_GATE_V1_FEATURE] })
    const decisionId = await setup(outdated.a)
    const res = await preview(outdated.a, { gate: gateOf(decisionId), state })
    expect(res.json().consumer).toMatchObject({ outcome: 'not_applied', notAppliedReason: 'unsupported' })
    expect(outdated.previews).toHaveLength(0)
    const offline = open({ offline: true })
    const down = await preview(offline.a, { gate: gateOf(decisionId), state })
    expect(down.statusCode).toBe(503)
    expect(down.json()).toMatchObject({ code: 'DAEMON_OFFLINE' })
  })

  it('needs edit access to the agent: a viewer and a collaborator it is hidden from are refused', async () => {
    const users = new PgUserRepo(prisma)
    const member = async (role: 'viewer' | 'collaborator') => {
      const email = `${role}-${randomUUID()}@example.test`
      const { userId } = await users.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
      await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
      return userId
    }
    const viewerId = await member('viewer')
    const otherId = await member('collaborator')
    const owner = open()
    const decisionId = await setup(owner.a, { visibility: 'restricted', sharedWith: [viewerId] })
    const viewer = open({ userId: viewerId })
    expect((await preview(viewer.a, { gate: gateOf(decisionId), state })).statusCode).toBe(403)
    const other = open({ userId: otherId })
    expect((await preview(other.a, { gate: gateOf(decisionId), state })).statusCode).toBe(404)
    expect([...viewer.previews, ...other.previews]).toHaveLength(0)
  })
})
