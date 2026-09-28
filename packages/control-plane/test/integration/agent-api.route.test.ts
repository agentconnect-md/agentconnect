// `/agents/:agentId/api` — the chat APIs an agent accepts calls on (shared-bot-relay.md §10.4).
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  API_AG_UI_V1_FEATURE,
  API_DECISION_GATE_V1_FEATURE,
  API_GATE_EVALUATIONS_V1_FEATURE,
  type DecisionEvaluationRecord
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const AGENT = 'a9a9a9a9-aaaa-4aaa-8aaa-a9a9a9a9a9a9'

type HttpApp = ReturnType<typeof buildHttpApp>
const opened: HttpApp[] = []
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close()
})
function open(over?: Parameters<typeof buildHttpApp>[1]): HttpApp {
  const a = buildHttpApp(prisma, over)
  opened.push(a)
  return a
}

async function makeUser(sub: string, role: 'collaborator' | 'viewer'): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

const list = (a: HttpApp, agentId = AGENT) => a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/api` })
const add = (a: HttpApp, protocol = 'ai-sdk-ui', agentId = AGENT) =>
  a.app.inject({ method: 'PUT', url: `${ORG}/agents/${agentId}/api/${protocol}` })
const remove = (a: HttpApp, protocol = 'ai-sdk-ui', agentId = AGENT) =>
  a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}/api/${protocol}` })

describe('agent chat APIs', () => {
  it('adds idempotently, lists, removes, and audits each change once', async () => {
    await seedAgent(prisma, AGENT)
    const a = open()
    expect((await list(a)).json()).toEqual({ entries: [] })

    const first = await add(a)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ protocol: 'ai-sdk-ui' })
    const again = await add(a)
    expect(again.json()).toEqual(first.json())
    expect(((await list(a)).json() as { entries: unknown[] }).entries).toEqual([first.json()])

    expect((await remove(a)).statusCode).toBe(204)
    expect((await list(a)).json()).toEqual({ entries: [] })
    expect((await remove(a)).statusCode).toBe(404)

    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_api_change', agentId: AGENT } })
      expect(audits.map((e) => (e.details as { enabled: boolean }).enabled).sort()).toEqual([false, true])
    })
  })

  it('rejects an unknown protocol and an unknown agent', async () => {
    await seedAgent(prisma, AGENT)
    const a = open()
    expect((await add(a, 'acp-2')).statusCode).toBe(400)
    expect((await add(a, 'ai-sdk-ui', 'b8b8b8b8-bbbb-4bbb-8bbb-b8b8b8b8b8b8')).statusCode).toBe(404)
  })

  it('reads 404 for an agent the caller cannot see, and refuses writes from a viewer', async () => {
    const other = await makeUser('api-other', 'collaborator')
    const viewer = await makeUser('api-viewer', 'viewer')
    await seedAgent(prisma, AGENT, { visibility: 'restricted', sharedWith: [viewer] })

    const asOther = open({ DEFAULT_OWNER_ID: other })
    expect((await list(asOther)).statusCode).toBe(404)
    expect((await add(asOther)).statusCode).toBe(404)

    const asViewer = open({ DEFAULT_OWNER_ID: viewer })
    expect((await list(asViewer)).statusCode).toBe(200)
    expect((await add(asViewer)).statusCode).toBe(403)
    expect((await remove(asViewer)).statusCode).toBe(403)
  })

  it('goes with its agent', async () => {
    await seedAgent(prisma, AGENT)
    const a = open()
    await add(a)
    await prisma.agent.delete({ where: { id: AGENT } })
    expect(await prisma.agentApiEntry.count()).toBe(0)
  })
})

describe('AG-UI chat API', () => {
  const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'

  it('is added only while every connected daemon serving the agent can take it', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    let features: string[] = []
    const a = open(undefined)
    const live = buildHttpApp(prisma, undefined, {
      get: () => ({ state: 'READY', capabilities: { features } })
    } as never)
    opened.push(live)

    const refused = await add(live, 'ag-ui')
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'DAEMON_UPGRADE_REQUIRED' })
    // AI SDK UI needs no feature beyond the chat API itself.
    expect((await add(live)).statusCode).toBe(200)

    features = [API_AG_UI_V1_FEATURE]
    expect((await add(live, 'ag-ui')).json()).toMatchObject({ protocol: 'ag-ui' })
    // Re-adding stays idempotent even after the daemon changes.
    features = []
    expect((await add(live, 'ag-ui')).statusCode).toBe(200)
    expect(
      ((await list(a)).json() as { entries: Array<{ protocol: string }> }).entries.map((e) => e.protocol).sort()
    ).toEqual(['ag-ui', 'ai-sdk-ui'])
  })

  it('is added while the serving daemon is offline, which catches up on reconnect', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    expect((await add(open(), 'ag-ui')).statusCode).toBe(200)
  })
})

describe('agent chat API Decision gate', () => {
  const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
  const draft = {
    name: 'On topic',
    providerId: 'typesafe',
    model: 'jev-1.13.0',
    visibility: 'org',
    sharedWith: [],
    question: { type: 'boolean', instructions: 'Is it about the product?', criteria: { true: 'Yes', false: 'No' } }
  }

  /** An app whose daemon advertises `features`, capturing every AgentSpec it is sent. */
  function gateApp(features: string[] = [API_DECISION_GATE_V1_FEATURE]) {
    const specs: Array<{ apiGates?: unknown }> = []
    const control = {
      agentUpsert: async (_daemonId: string, u: { spec: { apiGates?: unknown } }) => {
        specs.push(u.spec)
      }
    }
    const liveness = { get: () => ({ state: 'READY', capabilities: { features } }) }
    const a = buildHttpApp(prisma, undefined, liveness as never, control as unknown as ControlSender)
    opened.push(a)
    return { a, specs }
  }
  async function setup(features?: string[]) {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { a, specs } = gateApp(features)
    const decision = (await a.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })).json() as {
      id: string
    }
    return { a, specs, decisionId: decision.id }
  }
  const gateOf = (decisionId: string) => ({ type: 'gate', decisionId, when: { type: 'boolean', values: [true] } })
  const setGate = (a: HttpApp, gate: unknown) =>
    a.app.inject({ method: 'PUT', url: `${ORG}/agents/${AGENT}/api/ai-sdk-ui/gate`, payload: { gate } })

  it('saves a gate on an added API, lists it, ships it in the AgentSpec, and clears it', async () => {
    const { a, specs, decisionId } = await setup()
    expect((await setGate(a, gateOf(decisionId))).statusCode).toBe(404)
    await add(a)

    const saved = await setGate(a, gateOf(decisionId))
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ protocol: 'ai-sdk-ui', gate: gateOf(decisionId) })
    expect((await list(a)).json()).toMatchObject({ entries: [{ gate: gateOf(decisionId) }] })
    // The spec carries the gate with its Decision, so the daemon admits without reading the CP.
    expect(specs.at(-1)?.apiGates).toMatchObject({
      'ai-sdk-ui': { gate: gateOf(decisionId), definitions: [{ id: decisionId, providerId: 'typesafe' }] }
    })

    expect((await setGate(a, null)).json()).toMatchObject({ gate: null })
    expect(specs.at(-1)?.apiGates).toEqual({})
  })

  it('refuses a condition that does not fit the question, and a daemon that cannot run the gate', async () => {
    const { a, decisionId } = await setup([])
    await add(a)
    const wrong = await setGate(a, { type: 'gate', decisionId, when: { type: 'score', min: 0, max: 2 } })
    expect(wrong.statusCode).toBe(400)
    const unsupported = await setGate(a, gateOf(decisionId))
    expect(unsupported.statusCode).toBe(409)
    expect(unsupported.json()).toMatchObject({ code: 'DECISION_UNSUPPORTED_CONSUMER' })
    expect((unsupported.json() as { message: string }).message).toContain('Upgrade the daemon')
    const hidden = await setGate(a, gateOf('44444444-4444-4444-8444-444444444444'))
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toMatchObject({ code: 'DECISION_NOT_FOUND' })
  })

  it('refuses an AG-UI gate while a connected daemon cannot take AG-UI', async () => {
    let features = [API_DECISION_GATE_V1_FEATURE, API_AG_UI_V1_FEATURE]
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const a = buildHttpApp(prisma, undefined, { get: () => ({ state: 'READY', capabilities: { features } }) } as never)
    opened.push(a)
    const decision = (await a.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })).json() as {
      id: string
    }
    expect((await add(a, 'ag-ui')).statusCode).toBe(200)
    const setAgUiGate = () =>
      a.app.inject({
        method: 'PUT',
        url: `${ORG}/agents/${AGENT}/api/ag-ui/gate`,
        payload: { gate: gateOf(decision.id) }
      })
    features = [API_DECISION_GATE_V1_FEATURE]
    const refused = await setAgUiGate()
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'DECISION_UNSUPPORTED_CONSUMER' })
    features = [API_DECISION_GATE_V1_FEATURE, API_AG_UI_V1_FEATURE]
    expect((await setAgUiGate()).json()).toMatchObject({ protocol: 'ag-ui', gate: gateOf(decision.id) })
  })

  it('re-ships a gate when its Decision changes, and leaves out one whose condition no longer fits', async () => {
    const { a, specs, decisionId } = await setup()
    await add(a)
    await setGate(a, gateOf(decisionId))
    const edit = (question: unknown) =>
      a.app.inject({ method: 'PATCH', url: `${ORG}/decisions/${decisionId}`, payload: { ...draft, question } })

    specs.length = 0
    expect((await edit({ ...draft.question, instructions: 'Is it about the product or its docs?' })).statusCode).toBe(
      200
    )
    expect(specs.at(-1)?.apiGates).toMatchObject({
      'ai-sdk-ui': { definitions: [{ question: { instructions: 'Is it about the product or its docs?' } }] }
    })

    // A boolean condition cannot judge a score question: the gate fails open until it is saved again.
    const score = { type: 'score', instructions: 'How relevant?', criteria: ['low', 'high'] }
    expect((await edit(score)).statusCode).toBe(200)
    expect(specs.at(-1)?.apiGates).toEqual({})
  })

  it('keeps the Decision in use while the gate holds it, and releases it with the API', async () => {
    const { a, decisionId } = await setup()
    await add(a)
    await setGate(a, gateOf(decisionId))
    const detail = (await a.app.inject({ method: 'GET', url: `${ORG}/decisions/${decisionId}` })).json() as {
      usages: Array<{ kind: string; id: string }>
    }
    expect(detail.usages).toContainEqual(expect.objectContaining({ kind: 'api_gate', id: AGENT }))
    expect((await a.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })).statusCode).toBe(409)

    expect((await remove(a)).statusCode).toBe(204)
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })
    expect((agent.runtimeOverrides as { apiGates?: unknown } | null)?.apiGates).toBeUndefined()
    expect((await a.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })).statusCode).toBe(204)
  })
})

describe('chat API gate evaluations', () => {
  const DAEMON = 'd8d8d8d8-dddd-4ddd-8ddd-d8d8d8d8d8d8'
  const row: DecisionEvaluationRecord = {
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    messageId: 'msg-1',
    title: 'How do I install the daemon?',
    decisionId: '33333333-3333-4333-8333-333333333333',
    outcome: 'skipped',
    reason: null,
    answer: { type: 'boolean', value: false, probability: 0.1 },
    matchedKeys: [],
    latencyMs: 12,
    requestedModel: 'example-model',
    actualModel: 'example-model',
    usage: { inputTokens: 1, outputTokens: 1 },
    detailsExpired: false
  }

  it('proxies the verdicts from the serving daemon to those who can edit the agent', async () => {
    const viewer = await makeUser('api-eval-viewer', 'viewer')
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [viewer] })
    const requests: unknown[] = []
    const control = {
      decisionApiGateEvaluations: async (_daemonId: string, _orgId: string, req: unknown) => {
        requests.push(req)
        return { items: [row], nextCursor: null }
      },
      decisionApiGateEvaluation: async (_daemonId: string, _orgId: string, req: { seq: number }) => ({
        evaluation: req.seq === 1 ? { ...row, snapshot: null, input: null, fullAnswer: null, evidence: null } : null
      })
    }
    let features = [API_GATE_EVALUATIONS_V1_FEATURE]
    const liveness = { get: () => ({ state: 'READY', capabilities: { features } }) }
    const build = (over?: Parameters<typeof buildHttpApp>[1]) => {
      const a = buildHttpApp(prisma, over, liveness as never, control as unknown as ControlSender)
      opened.push(a)
      return a
    }
    const a = build()
    const url = `${ORG}/agents/${AGENT}/api/ai-sdk-ui/evaluations`

    const page = await a.app.inject({ method: 'GET', url: `${url}?limit=5` })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toEqual({ items: [row], nextCursor: null })
    expect(requests).toEqual([{ agentId: AGENT, protocol: 'ai-sdk-ui', limit: 5 }])
    expect((await a.app.inject({ method: 'GET', url: `${url}/1` })).json()).toMatchObject({ seq: 1, evidence: null })
    expect((await a.app.inject({ method: 'GET', url: `${url}/2` })).statusCode).toBe(404)

    // A viewer sees the agent, not the calls its gate judged.
    expect((await build({ DEFAULT_OWNER_ID: viewer }).app.inject({ method: 'GET', url })).statusCode).toBe(403)

    features = [API_DECISION_GATE_V1_FEATURE]
    const old = await a.app.inject({ method: 'GET', url })
    expect(old.statusCode).toBe(503)
    expect(old.json().code).toBe('DAEMON_UPGRADE_REQUIRED')
  })
})
