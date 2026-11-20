/** An `editors` session against real Postgres (session-visibility.md §1): whoever can edit its agent when it is read sees it, through the list SQL and the single read alike. */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId, SessionId } from '../../src/domain/ids.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const OUTSIDER = 'email:mail.example.test:stranger@other.example.test'
const users = () => new PgUserRepo(prisma)
const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@corp.example.test`
  const { userId } = await users().provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users().addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

function appAs(userId: string): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

/** What the list and the single read say about one session for one member; the two must agree. */
async function sees(userId: string, agentId: string, sessionId: string): Promise<boolean> {
  const app = appAs(userId)
  const list = (
    await app.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&agentId=${agentId}` })
  ).json() as {
    sessions: Array<{ sessionId: string }>
  }
  const listed = list.sessions.some((s) => s.sessionId === sessionId)
  const detail = await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${sessionId}` })
  expect(detail.statusCode === 200).toBe(listed)
  if (detail.statusCode !== 200) expect(detail.statusCode).toBe(404)
  return listed
}

describe('an editors session', () => {
  it('is seen by the agent’s editors and its organization’s owners, never by another member or a viewer', async () => {
    const tag = randomUUID().slice(0, 8)
    const editor = await makeUser(`ed-editor-${tag}`, 'collaborator')
    const member = await makeUser(`ed-member-${tag}`, 'collaborator')
    const sharedViewer = await makeUser(`ed-viewer-${tag}`, 'viewer')
    const owner = await makeUser(`ed-owner-${tag}`, 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), {
      daemonId,
      visibility: 'restricted',
      sharedWith: [editor, sharedViewer]
    })
    const sessionId = await seedSessionMeta(prisma, `s-editors-${randomUUID()}`, agentId, {
      platform: 'email',
      visibility: 'editors',
      ownerIdentity: OUTSIDER
    })

    expect(await sees(editor, agentId, sessionId)).toBe(true)
    expect(await sees(owner, agentId, sessionId)).toBe(true)
    expect(await sees(member, agentId, sessionId)).toBe(false)
    // The viewer is on the agent's list, so sees the agent, but a viewer edits nothing.
    expect(await sees(sharedViewer, agentId, sessionId)).toBe(false)
  })

  it('follows the agent’s edit grants as they stand when read: an editor added later sees it, a removed one stops', async () => {
    const tag = randomUUID().slice(0, 8)
    const first = await makeUser(`ed-first-${tag}`, 'collaborator')
    const later = await makeUser(`ed-later-${tag}`, 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId, visibility: 'restricted', sharedWith: [first] })
    const sessionId = await seedSessionMeta(prisma, `s-editors-${randomUUID()}`, agentId, {
      platform: 'email',
      visibility: 'editors',
      ownerIdentity: OUTSIDER
    })
    expect(await sees(first, agentId, sessionId)).toBe(true)
    expect(await sees(later, agentId, sessionId)).toBe(false)

    await prisma.agent.update({ where: { id: agentId }, data: { sharedWith: [first, later] } })
    expect(await sees(later, agentId, sessionId)).toBe(true)

    await prisma.agent.update({ where: { id: agentId }, data: { sharedWith: [later] } })
    expect(await sees(first, agentId, sessionId)).toBe(false)
    expect(await sees(later, agentId, sessionId)).toBe(true)

    // Opening the agent to the organization makes every collaborator an editor; a demotion to viewer ends it.
    await prisma.agent.update({ where: { id: agentId }, data: { visibility: 'org', sharedWith: [] } })
    expect(await sees(first, agentId, sessionId)).toBe(true)
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: first } },
      data: { role: 'viewer' }
    })
    expect(await sees(first, agentId, sessionId)).toBe(false)
  })

  it('passes its audience to an agent-to-agent child, and no one reclassifies it', async () => {
    const tag = randomUUID().slice(0, 8)
    const editor = await makeUser(`ed-a2a-editor-${tag}`, 'collaborator')
    const member = await makeUser(`ed-a2a-member-${tag}`, 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId, visibility: 'restricted', sharedWith: [editor] })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-editors-parent-${randomUUID()}`
    const childId = `s-editors-child-${randomUUID()}`
    await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'email',
      channel: 'dm:stranger@other.example.test',
      at: new Date(),
      classification: { visibility: 'editors', ownerIdentity: OUTSIDER, source: 'default' }
    })
    const child = await repo.recordMilestone({
      sessionId: SessionId(childId),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'email',
      channel: 'a2a:parent',
      at: new Date(),
      classification: { inherit: true }
    })
    expect(child.session).toMatchObject({ visibility: 'editors', ownerIdentity: OUTSIDER })
    expect(await sees(editor, agentId, childId)).toBe(true)
    expect(await sees(member, agentId, childId)).toBe(false)

    // The memory gate the daemon is told treats it as private, so it stays out of the shared layer.
    const [gate] = await repo.privateVisibilityPage([agentId], 10, true)
    expect(gate).toMatchObject({ visibility: 'editors', sharedMemoryExcluded: true })

    const change = await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(parentId), 'org')
    expect(change).toMatchObject({ forbidden: true, affected: [] })
    const put = await appAs(editor).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${parentId}/visibility`,
      payload: { visibility: 'org' }
    })
    expect(put.statusCode).toBeGreaterThanOrEqual(400)
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), SessionId(parentId)))?.visibility).toBe('editors')
    // The facet read shares the list predicate: the agent shows only to someone who sees one of its sessions.
    const facetsFor = (userId: string) =>
      repo.listFacets({
        agentIds: [AgentId(agentId)],
        viewer: { userId, role: 'collaborator', identitySet: [`user:${userId}`] }
      })
    expect((await facetsFor(member)).agents).not.toContain(agentId)
    expect((await facetsFor(editor)).agents).toContain(agentId)
  })
})
