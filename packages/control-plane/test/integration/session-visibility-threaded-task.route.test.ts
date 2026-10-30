// A threaded task takes its owning session's audience while one owns it, which its daemon moves and clears (auto-session-mode.md §6.2).
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { SessionId, type AgentId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

async function makeUser(sub: string): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
  return userId
}

function appAs(userId: string): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

const repo = () => new PgSessionRepo(prisma)

/** One milestone of a Slack channel session the first poster owns, as `event/session` ingest records it. */
async function milestone(
  agentId: AgentId,
  id: string,
  thread: string,
  owner: string,
  taskParentSessionId?: string | null
): Promise<void> {
  await repo().recordMilestone({
    sessionId: SessionId(id),
    ...(taskParentSessionId !== undefined
      ? { taskParentSessionId: taskParentSessionId === null ? null : SessionId(taskParentSessionId) }
      : {}),
    agentId,
    phase: 'plan',
    platform: 'slack',
    channel: 'C1',
    thread,
    at: new Date(),
    classification: { visibility: 'org', ownerIdentity: `user:${owner}`, source: 'default' }
  })
}

type Relation = { id: string }
const detail = async (app: HttpApp, id: string) =>
  (await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${id}` })).json() as {
    visibility: string
    canChangeVisibility: boolean
    parentSession: Relation | null
    siblingSessions: Relation[]
    childSessions: Relation[]
  }
const put = async (app: HttpApp, id: string, visibility: 'private' | 'org') =>
  (await app.app.inject({ method: 'PUT', url: `${ORG}/sessions/${id}/visibility`, payload: { visibility } })).statusCode
const row = (id: string) => prisma.sessionMeta.findUniqueOrThrow({ where: { id } })

describe('session visibility of a threaded task', () => {
  it('is locked while a coordinator owns the task, follows a handover, and opens again once released', async () => {
    const sender = await makeUser(`sv-task-${randomUUID()}`)
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const first = `s-coordinator-${randomUUID()}`
    const second = `s-coordinator-${randomUUID()}`
    const task = `s-task-${randomUUID()}`
    await milestone(agentId, first, 'append:coordinator-1700000000000', sender)
    await milestone(agentId, second, 'append:coordinator-1700000000500', sender)
    await milestone(agentId, task, '1700000000.000100', sender, first)
    const app = appAs(sender)

    expect(await row(task)).toMatchObject({ taskParentSessionId: first, parentSessionId: null })
    expect(await detail(app, task)).toMatchObject({ canChangeVisibility: false, parentSession: { id: first } })
    expect(await put(app, task, 'private')).toBe(403)
    expect((await detail(app, first)).childSessions.map((s) => s.id)).toEqual([task])

    // A snapshot that does not say keeps the owner; a root `!new` hands the task to the next coordinator.
    await milestone(agentId, task, '1700000000.000100', sender)
    expect((await row(task)).taskParentSessionId).toBe(first)
    await milestone(agentId, task, '1700000000.000100', sender, second)
    expect(await detail(app, task)).toMatchObject({ canChangeVisibility: false, parentSession: { id: second } })
    expect((await detail(app, first)).childSessions).toEqual([])
    expect((await detail(app, second)).childSessions.map((s) => s.id)).toEqual([task])

    // Released (the conversation left Auto, or the task closed idle): an ordinary thread session again.
    await milestone(agentId, task, '1700000000.000100', sender, null)
    expect(await detail(app, task)).toMatchObject({ canChangeVisibility: true, parentSession: null })
    expect((await detail(app, second)).childSessions).toEqual([])
    expect(await put(app, task, 'private')).toBe(200)
    expect((await row(task)).visibility).toBe('private')
  })
})
