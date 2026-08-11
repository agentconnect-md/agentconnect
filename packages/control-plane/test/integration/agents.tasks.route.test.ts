/**
 * `GET /agents/:id/tasks` — the Tasks panel's read of ONE ACP session's background tasks.
 * The CP authorizes the agent, the SESSION (not its worktree) and the daemon's capability,
 * proxies the daemon's snapshot, and persists nothing. Every degraded answer the daemon can
 * give is data: an untracked session, a tracked session with nothing running, a settled task.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TASK_LIST_FEATURE, WORKSPACE_GIT_REVIEW_FEATURE } from '@agentconnect.md/protocol'
import type { TaskList, TaskListReq } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd4d4d4d4-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a4a4a4a4-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TASK_CAPABILITIES = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: [TASK_LIST_FEATURE]
}
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The one read seam under test, recording every forwarded REQ. */
class TaskSpy {
  calls: Array<{ daemonId: string; req: TaskListReq }> = []
  /** Set to answer the next read as an untracked session (no lease on the daemon). */
  untracked = false
  /** Set to make the next read fail the way a daemon `error` frame would. */
  failure: Error | null = null

  async taskList(daemonId: string, req: TaskListReq): Promise<TaskList> {
    this.calls.push({ daemonId, req })
    if (this.failure) throw this.failure
    if (this.untracked) {
      return { agentId: req.agentId, sessionId: req.sessionId, tracked: false, tasks: [], truncated: false }
    }
    return {
      agentId: req.agentId,
      sessionId: req.sessionId,
      tracked: true,
      tasks: [
        { id: 't2', state: 'running', subagent: false, startedAt: '2026-08-10T10:00:02Z' },
        {
          id: 't1',
          description: 'run the integration suite',
          state: 'failed',
          subagent: true,
          startedAt: '2026-08-10T10:00:00Z',
          endedAt: '2026-08-10T10:04:00Z',
          detail: 'failed'
        }
      ],
      truncated: true
    }
  }
}

function app(control: TaskSpy, userId?: string): HttpApp {
  const running = buildHttpApp(
    prisma,
    userId ? { DEFAULT_OWNER_ID: userId } : undefined,
    LIVE,
    control as unknown as ControlSender
  )
  opened.push(running)
  return running
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** A task-capable daemon holding one agent. */
async function seedTaskAgent(features: string[] = TASK_CAPABILITIES.features): Promise<void> {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...TASK_CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/repo' })
}

/** An org-visible session of AGENT. Left at the default SHARED workspace isolation on
 *  purpose: a shared checkout still runs background tasks, so the tasks read must not
 *  inherit the worktree gate. */
async function seedSession(agentId = AGENT): Promise<string> {
  const id = randomUUID()
  await seedSessionMeta(prisma, id, agentId, { daemonId: DAEMON })
  return id
}

describe('GET /agents/:id/tasks', () => {
  it('proxies a SHARED-workspace session and projects the daemon’s order and nulls', async () => {
    await seedTaskAgent()
    const session = await seedSession()
    const control = new TaskSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      sessionId: session,
      tracked: true,
      tasks: [
        {
          id: 't2',
          description: null,
          state: 'running',
          subagent: false,
          startedAt: '2026-08-10T10:00:02Z',
          endedAt: null,
          detail: null
        },
        {
          id: 't1',
          description: 'run the integration suite',
          state: 'failed',
          subagent: true,
          startedAt: '2026-08-10T10:00:00Z',
          endedAt: '2026-08-10T10:04:00Z',
          detail: 'failed'
        }
      ],
      truncated: true
    })
    expect(control.calls).toEqual([{ daemonId: DAEMON, req: { agentId: AGENT, sessionId: session } }])
  })

  it('answers an untracked session with data, not an error — and refuses an unscoped read', async () => {
    await seedTaskAgent()
    const session = await seedSession()
    const control = new TaskSpy()
    control.untracked = true
    const running = app(control)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ sessionId: session, tracked: false, tasks: [], truncated: false })

    // The lease is per (agent, ACP session) and there is no per-agent aggregate, so an
    // unscoped list is refused by the schema rather than answered with a guess.
    const unscoped = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/tasks` })
    expect(unscoped.statusCode).toBe(400)
    const blank = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/tasks?sessionId=` })
    expect(blank.statusCode).toBe(400)
    expect(control.calls).toHaveLength(1)
  })

  it('reads a viewer’s request too — listing tasks is a read, so no write gate applies', async () => {
    await seedTaskAgent()
    const session = await seedSession()
    const viewer = await makeUser(`tasks-viewer-${randomUUID()}`, 'viewer')
    const control = new TaskSpy()

    const res = await app(control, viewer).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(res.statusCode).toBe(200)
    expect(control.calls).toHaveLength(1)
  })

  it('refuses every session the gate does not authorize, before any daemon I/O', async () => {
    await seedTaskAgent()
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const foreign = await seedSession(otherAgent) // a real session, but not this agent's
    const purged = await seedSession()
    await prisma.sessionMeta.update({
      where: { id: purged },
      data: { contentPurgedAt: new Date(), contentPurgedReason: 'retention' }
    })
    const control = new TaskSpy()
    const running = app(control)

    for (const sessionId of [foreign, purged, randomUUID()]) {
      const res = await running.app.inject({
        method: 'GET',
        url: `${ORG}/agents/${AGENT}/tasks?sessionId=${sessionId}`
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ message: 'session not found' })
    }
    expect(control.calls).toHaveLength(0)
  })

  it('hides another member’s private session behind the same 404', async () => {
    await seedTaskAgent()
    const mine = await makeUser(`tasks-mine-${randomUUID()}`, 'collaborator')
    const theirs = await makeUser(`tasks-theirs-${randomUUID()}`, 'collaborator')
    const session = randomUUID()
    await seedSessionMeta(prisma, session, AGENT, {
      daemonId: DAEMON,
      visibility: 'private',
      ownerIdentity: `user:${theirs}`
    })
    const control = new TaskSpy()

    const denied = await app(control, mine).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(denied.statusCode).toBe(404)
    expect(control.calls).toHaveLength(0)

    const owner = await app(control, theirs).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(owner.statusCode).toBe(200)
    expect(control.calls).toHaveLength(1)
  })

  it('reads a restricted agent and a foreign org’s agent as absent', async () => {
    const other = await makeUser(`tasks-other-${randomUUID()}`, 'collaborator')
    await seedDaemon(prisma, DAEMON, { capabilities: TASK_CAPABILITIES })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] })
    const session = await seedSession()
    const foreignOrg = `org-foreign-${randomUUID().slice(0, 8)}`
    const foreignAgent = randomUUID()
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.agent.create({
      data: { id: foreignAgent, orgId: foreignOrg, name: 'foreign-bot', runtime: 'claude', daemonId: null }
    })
    const control = new TaskSpy()

    const restricted = await app(control, other).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(restricted.statusCode).toBe(404)
    expect(restricted.json()).toMatchObject({ message: 'agent not found' })

    const crossOrg = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${foreignAgent}/tasks?sessionId=${session}`
    })
    expect(crossOrg.statusCode).toBe(404)
    expect(control.calls).toHaveLength(0)
  })

  it('answers an unplaced agent 503 without touching the wire', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: TASK_CAPABILITIES })
    await seedAgent(prisma, AGENT) // no daemonId
    const session = await seedSession()
    const control = new TaskSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ message: 'agent has no live daemon' })
    expect(control.calls).toHaveLength(0)
  })

  it('refuses a daemon that does not report tasks, rather than sending a frame it would drop', async () => {
    await seedTaskAgent([WORKSPACE_GIT_REVIEW_FEATURE]) // git-capable, task-blind
    const session = await seedSession()
    const control = new TaskSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}`
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.calls).toHaveLength(0)
  })

  it('maps a daemon rejection to the status its reason names, and keeps 503 otherwise', async () => {
    await seedTaskAgent()
    const session = await seedSession()
    const control = new TaskSpy()
    const running = app(control)
    const read = () => running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/tasks?sessionId=${session}` })

    control.failure = new ProtocolError('BAD_PAYLOAD', 'task/list failed: unknown agent "a4"', {
      details: { reason: 'unknown-agent' }
    })
    const unknown = await read()
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ message: 'agent not found on its daemon', code: 'TASK_UNKNOWN_AGENT' })

    // An older daemon names no reason, so the read keeps the honest "may be offline" 503
    // instead of the CP inventing a status from a prose message.
    control.failure = new ProtocolError('BAD_PAYLOAD', 'task/list failed')
    expect((await read()).statusCode).toBe(503)

    control.failure = new NoConnection(DAEMON)
    const offline = await read()
    expect(offline.statusCode).toBe(503)
    expect(offline.json()).toMatchObject({ message: 'owning daemon is offline' })
  })
})
