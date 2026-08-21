/**
 * `GET /agents/:id/commands` — what the agent's ACP runtime advertised it can be asked to run.
 * The CP authorizes the agent, proxies the daemon's cached advertisement and persists nothing.
 * "No session has advertised yet" is DATA (`reported:false`), not an error — an empty list then
 * means unknown, the same distinction `skills/local` draws with `materialized`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RUNTIME_COMMANDS_FEATURE, type RuntimeCommandsList, type RuntimeCommandsReq } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { NoConnection, type ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd5d5d5d5-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a5a5a5a5-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CAPABILITIES = { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [RUNTIME_COMMANDS_FEATURE] }
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The one read seam under test, recording every forwarded REQ. */
class CommandsSpy {
  calls: Array<{ daemonId: string; req: RuntimeCommandsReq }> = []
  /** Set to answer as a daemon that has seen no advertisement for this agent yet. */
  unreported = false
  /** Set to make the next read fail the way a daemon `error` frame would. */
  failure: Error | null = null

  async listRuntimeCommands(daemonId: string, req: RuntimeCommandsReq): Promise<RuntimeCommandsList> {
    this.calls.push({ daemonId, req })
    if (this.failure) throw this.failure
    if (this.unreported) return { reported: false, commands: [] }
    return {
      reported: true,
      updatedAt: '2026-08-20T10:00:00.000Z',
      sessionId: 'acp-1',
      commands: [
        { name: 'code-review', description: 'Review the current diff (project)', hint: '[pr-number]' },
        { name: 'superpowers:brainstorming', description: 'Explore intent first (user)', hint: null }
      ]
    }
  }
}

function app(control: CommandsSpy, userId?: string): HttpApp {
  const running = buildHttpApp(
    prisma,
    userId ? { DEFAULT_OWNER_ID: userId } : undefined,
    LIVE,
    control as unknown as ControlSender
  )
  opened.push(running)
  return running
}

async function seedCommandAgent(features: string[] = CAPABILITIES.features): Promise<void> {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
}

describe('GET /agents/:id/commands', () => {
  it('proxies the runtime’s advertisement, hint and all', async () => {
    await seedCommandAgent()
    const control = new CommandsSpy()

    const res = await app(control).app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/commands` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      reported: true,
      updatedAt: '2026-08-20T10:00:00.000Z',
      sessionId: 'acp-1',
      commands: [
        { name: 'code-review', description: 'Review the current diff (project)', hint: '[pr-number]' },
        { name: 'superpowers:brainstorming', description: 'Explore intent first (user)', hint: null }
      ]
    })
    expect(control.calls).toEqual([{ daemonId: DAEMON, req: { agentId: AGENT } }])
  })

  it('passes "nothing advertised yet" through as data, not as an error', async () => {
    await seedCommandAgent()
    const control = new CommandsSpy()
    control.unreported = true

    const res = await app(control).app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/commands` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ reported: false, commands: [] })
  })

  it('reads an unknown and a foreign org’s agent as absent, without touching the wire', async () => {
    await seedCommandAgent()
    const control = new CommandsSpy()

    const res = await app(control).app.inject({ method: 'GET', url: `${ORG}/agents/${randomUUID()}/commands` })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ message: 'agent not found' })
    expect(control.calls).toHaveLength(0)
  })

  it('answers an unplaced agent 503 without touching the wire', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABILITIES })
    await seedAgent(prisma, AGENT) // no daemonId
    const control = new CommandsSpy()

    const res = await app(control).app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/commands` })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ message: 'agent has no live daemon' })
    expect(control.calls).toHaveLength(0)
  })

  it('refuses a daemon that predates this read instead of sending a frame it would drop', async () => {
    await seedCommandAgent([]) // capable of everything else, command-blind
    const control = new CommandsSpy()

    const res = await app(control).app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/commands` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.calls).toHaveLength(0)
  })

  it('answers 503 when the owning daemon is unreachable', async () => {
    await seedCommandAgent()
    const control = new CommandsSpy()
    control.failure = new NoConnection(DAEMON)

    const res = await app(control).app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/commands` })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ message: 'owning daemon is offline' })
  })
})
