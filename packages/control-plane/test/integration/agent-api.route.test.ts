// `/agents/:agentId/api` — the chat APIs an agent accepts calls on (shared-bot-relay.md §10.4).
import { describe, it, expect, afterEach } from 'vitest'
import { API_DECISION_GATE_V1_FEATURE } from '@agentconnect.md/protocol'
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

    const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_api_change', agentId: AGENT } })
    expect(audits.map((e) => (e.details as { enabled: boolean }).enabled).sort()).toEqual([false, true])
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
    expect(specs.at(-1)?.apiGates).toEqual({ 'ai-sdk-ui': gateOf(decisionId) })

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
    expect((unsupported.json() as { message: string }).message).toContain('Upgrade the daemon')
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
