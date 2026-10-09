// An assistant-mode agent's sub-session takes its parent's audience, which no viewer may change (assistant-mode.md §5.6).
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { classifySession } from '../../src/domain/session-visibility.js'
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

async function agent(daemonId: string, assistantMode: boolean): Promise<AgentId> {
  const id = await seedAgent(prisma, randomUUID(), { daemonId })
  if (assistantMode) {
    await prisma.agent.update({
      where: { id },
      data: { assistantMode: { enabled: true, responsibleUserId: 'user-1' } }
    })
  }
  return id
}

/** A parent the first poster owns, and a child classified exactly as `event/session` ingest classifies one. */
async function lineage(parentAgent: AgentId, childAgent: AgentId, childThread: string, owner: string) {
  const repo = new PgSessionRepo(prisma)
  const parentId = `s-parent-${randomUUID()}`
  const childId = `s-child-${randomUUID()}`
  await repo.recordMilestone({
    sessionId: SessionId(parentId),
    agentId: parentAgent,
    phase: 'start',
    platform: 'slack',
    channel: 'C1',
    thread: '1700000000.000100',
    at: new Date(),
    classification: { visibility: 'org', ownerIdentity: `user:${owner}`, source: 'default' }
  })
  const classification = classifySession({
    parentSessionId: parentId,
    platform: 'slack',
    conversationKind: 'channel',
    transportScope: 'T0EXAMPLE',
    triggeredBy: 'agent'
  })
  expect(classification).toEqual({ inherit: true })
  await repo.recordMilestone({
    sessionId: SessionId(childId),
    parentSessionId: SessionId(parentId),
    agentId: childAgent,
    phase: 'start',
    platform: 'slack',
    channel: 'C1',
    thread: childThread,
    at: new Date(),
    classification
  })
  return { parentId, childId }
}

const detail = async (app: HttpApp, id: string) =>
  (await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${id}` })).json() as {
    visibility: string
    canChangeVisibility: boolean
  }
const put = async (app: HttpApp, id: string, visibility: 'private' | 'org') =>
  (await app.app.inject({ method: 'PUT', url: `${ORG}/sessions/${id}/visibility`, payload: { visibility } })).statusCode
const row = (id: string) => prisma.sessionMeta.findUniqueOrThrow({ where: { id } })

describe('session visibility of assistant-mode sub-sessions', () => {
  it('inherits the parent’s audience and owner, and refuses that owner a change of its own', async () => {
    const firstPoster = await makeUser(`sv-sub-${randomUUID()}`)
    const daemonId = await seedDaemon(prisma, randomUUID())
    const assistant = await agent(daemonId, true)
    const { parentId, childId } = await lineage(assistant, assistant, 'subsession:1700000000000', firstPoster)
    const app = appAs(firstPoster)

    expect(await row(childId)).toMatchObject({ visibility: 'org', ownerIdentity: `user:${firstPoster}` })
    expect(await detail(app, childId)).toMatchObject({ visibility: 'org', canChangeVisibility: false })
    expect(await put(app, childId, 'private')).toBe(403)
    expect((await row(childId)).visibility).toBe('org')

    // The parent stays its owner's to change, and tightening it still reaches the sub-session.
    expect(await detail(app, parentId)).toMatchObject({ canChangeVisibility: true })
    expect(await put(app, parentId, 'private')).toBe(200)
    expect(await row(childId)).toMatchObject({ visibility: 'private', ownerIdentity: `user:${firstPoster}` })
  })

  it.each([
    ['a peer’s child on a platform thread', true, 'peer', '1700000000.000200'],
    ['the agent’s own channel-root child', true, 'self', '1700000000.000200'],
    ['a sub-session coordinate of an agent whose assistant mode is off', false, 'self', 'subsession:1700000000000']
  ] as const)('keeps today’s rule for %s', async (_label, assistantMode, childOf, childThread) => {
    const firstPoster = await makeUser(`sv-sub-other-${randomUUID()}`)
    const daemonId = await seedDaemon(prisma, randomUUID())
    const parentAgent = await agent(daemonId, assistantMode)
    const childAgent = childOf === 'self' ? parentAgent : await agent(daemonId, assistantMode)
    const { childId } = await lineage(parentAgent, childAgent, childThread, firstPoster)
    const app = appAs(firstPoster)

    expect(await detail(app, childId)).toMatchObject({ visibility: 'org', canChangeVisibility: true })
    expect(await put(app, childId, 'private')).toBe(200)
    expect((await row(childId)).visibility).toBe('private')
  })
})
