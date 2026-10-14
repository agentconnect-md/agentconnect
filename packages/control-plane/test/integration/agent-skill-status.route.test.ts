// `agent/skill-status` → `agent_skill_source_status` → `GET /agents/:id/skill-source-status` (source-cache.md §11).
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgAgentSkillSourceStatusRepo } from '../../src/persistence/index.js'
import { handleAgentSkillStatus } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { AnyFrame } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { FakeClock } from '../fakes/fake-clock.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

let clock = new FakeClock(Date.parse('2026-07-05T00:00:00.000Z'))

function deps(withStore = true): DaemonWsDeps {
  return {
    agent: new PgAgentRepo(prisma),
    agentMutations: new AgentMutationGate(),
    clock,
    ...(withStore ? { agentSkillSourceStatus: new PgAgentSkillSourceStatusRepo(prisma) } : {})
  } as unknown as DaemonWsDeps
}

async function report(failed: Array<{ name: string; code: string }>, daemonId = DAEMON, withStore = true) {
  // Decoded as the socket edge decodes it, so the frame contract is exercised too.
  const frame = AnyFrame.parse({
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'agent/skill-status',
    payload: { agentId: AGENT, failed, ts: '2026-07-05T00:00:00.000Z' }
  })
  await handleAgentSkillStatus(frame, { daemonId, orgId: DEFAULT_ORG_ID } as DaemonConnection, deps(withStore))
}

async function status(app: HttpApp) {
  const res = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/skill-source-status` })
  expect(res.statusCode).toBe(200)
  return (res.json() as { sources: Array<{ name: string; code: string; reportedAt: string }> }).sources
}

async function seed() {
  clock = new FakeClock(Date.parse('2026-07-05T00:00:00.000Z'))
  await seedDaemon(prisma, DAEMON)
  await seedDaemon(prisma, OTHER_DAEMON)
  await seedAgent(prisma, AGENT, {
    daemonId: DAEMON,
    runtimeOverrides: { skills: ['other-host/*', 'gitlab-private/review', 'public/*'] }
  })
}

describe('agent skill source status (source-cache.md §11)', () => {
  it('stores each failed Source with its code, and clears it when a later report installs it', async () => {
    await seed()
    running = buildHttpApp(prisma)
    expect(await status(running)).toEqual([])

    await report([
      { name: 'other-host', code: 'sha_fetch_refused' },
      { name: 'gitlab-private', code: 'access_denied' }
    ])
    expect(await status(running)).toEqual([
      { name: 'gitlab-private', code: 'access_denied', reportedAt: '2026-07-05T00:00:00.000Z' },
      { name: 'other-host', code: 'sha_fetch_refused', reportedAt: '2026-07-05T00:00:00.000Z' }
    ])

    clock.advance(60_000)
    await report([{ name: 'other-host', code: 'fetch_failed' }])
    expect(await status(running)).toEqual([
      { name: 'other-host', code: 'fetch_failed', reportedAt: '2026-07-05T00:01:00.000Z' }
    ])

    await report([])
    expect(await status(running)).toEqual([])
  })

  it('drops a report from a daemon that does not serve the agent, and stores nothing without a store', async () => {
    await seed()
    running = buildHttpApp(prisma)
    await report([{ name: 'public', code: 'fetch_failed' }], OTHER_DAEMON)
    await report([{ name: 'public', code: 'fetch_failed' }], DAEMON, false)
    expect(await prisma.agentSkillSourceStatus.count()).toBe(0)
  })

  it('lists only Sources the agent still enables', async () => {
    await seed()
    running = buildHttpApp(prisma)
    await report([
      { name: 'public', code: 'limits_exceeded' },
      { name: 'removed-since', code: 'cli_failed' }
    ])
    expect((await status(running)).map((row) => row.name)).toEqual(['public'])
  })

  it('answers 404 for an unknown agent', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${randomUUID()}/skill-source-status` })
    expect(res.statusCode).toBe(404)
  })

  it('refuses raw output in place of a code at the frame edge', () => {
    expect(
      AnyFrame.safeParse({
        v: 1,
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: 'agent/skill-status',
        payload: {
          agentId: AGENT,
          failed: [{ name: 'x', code: 'fatal: repository not found' }],
          ts: new Date().toISOString()
        }
      }).success
    ).toBe(false)
  })
})
