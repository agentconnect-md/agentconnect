/** An email address's two settings against real Postgres (email-integration.md §4.1): read with the agent, changed by its editor, and projected to the daemon. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect, afterEach } from 'vitest'
import { EMAIL_V1_FEATURE } from '@agentconnect.md/protocol'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd4d4d4d4-dddd-4ddd-8ddd-dddddddddddd'
const DOMAIN = 'mail.example.test'

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
}

function harness(userId?: string) {
  const control = new SpyControl()
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test', ...(userId ? { DEFAULT_OWNER_ID: userId } : {}) },
    undefined,
    control as unknown as ControlSender,
    { emailMailDomain: DOMAIN }
  )
  app.relayReg.add({ relayId: 'r1', send: () => {}, close() {} } as unknown as RelayChannel)
  running.push(app)
  return { app, control }
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@corp.example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** An agent with an Email integration the default owner added. */
async function withAddress(app: HttpApp): Promise<{ integrationId: string; botId: string }> {
  if (!(await prisma.daemon.findUnique({ where: { id: DAEMON } })))
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['email'], runtimes: ['claude'], acp: true, features: [EMAIL_V1_FEATURE] }
    })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { platform: 'email', agentId, transport: 'http', email: { name: `helper-${agentId.slice(0, 8)}` } }
  })
  expect(res.statusCode).toBe(201)
  const dto = res.json() as { id: string; botId: string }
  return { integrationId: dto.id, botId: dto.botId }
}

const url = (integrationId: string) => `${ORG}/integrations/${integrationId}/email/settings`

describe('an email address’s settings', () => {
  it('reads Members, and outside sessions seen by the agent’s editors, by default', async () => {
    const { app } = harness()
    const { integrationId } = await withAddress(app)
    const res = await app.app.inject({ method: 'GET', url: url(integrationId) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ whoMayWrite: 'members', outsideSessions: { kind: 'editors' } })
  })

  it('stores the editors choice by name', async () => {
    const { app } = harness()
    const { integrationId, botId } = await withAddress(app)
    const res = await app.app.inject({
      method: 'PUT',
      url: url(integrationId),
      payload: { whoMayWrite: 'anyone', outsideSessions: { kind: 'editors' } }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ whoMayWrite: 'anyone', outsideSessions: { kind: 'editors' } })
    expect((await prisma.bot.findUnique({ where: { id: botId } }))?.platformConfig).toMatchObject({
      outsideSessions: 'editors'
    })
  })

  it('migrates an address that kept the old default to editors, and leaves other choices alone', async () => {
    const { app } = harness()
    const kept = await withAddress(app)
    const picked = await withAddress(app)
    const toOrg = await withAddress(app)
    const other = await makeUser('migration-pick', 'collaborator')
    const store = (botId: string, outsideSessions: string) =>
      prisma.bot.update({ where: { id: botId }, data: { platformConfig: { whoMayWrite: 'anyone', outsideSessions } } })
    await store(kept.botId, `user:${DEFAULT_OWNER_ID}`)
    await store(picked.botId, `user:${other}`)
    await store(toOrg.botId, 'org')
    const migration = readFileSync(
      new URL('../../prisma/migrations/20270125000000_email_outside_sessions_editors/migration.sql', import.meta.url),
      'utf8'
    )
    await prisma.$executeRawUnsafe(migration)
    const stored = async (botId: string) =>
      ((await prisma.bot.findUnique({ where: { id: botId } }))?.platformConfig as Record<string, string>)
        .outsideSessions
    expect(await stored(kept.botId)).toBe('editors')
    expect(await stored(picked.botId)).toBe(`user:${other}`)
    expect(await stored(toOrg.botId)).toBe('org')
    expect((await app.app.inject({ method: 'GET', url: url(kept.integrationId) })).json()).toEqual({
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'editors' }
    })
  })

  it('stores a change on the address and pushes who may write to the daemon', async () => {
    const { app, control } = harness()
    const { integrationId, botId } = await withAddress(app)
    const picked = await makeUser('picked', 'collaborator')
    const before = control.upserts.length

    const res = await app.app.inject({
      method: 'PUT',
      url: url(integrationId),
      payload: { whoMayWrite: 'anyone', outsideSessions: { kind: 'member', userId: picked } }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: picked, active: true }
    })
    expect((await prisma.bot.findUnique({ where: { id: botId } }))?.platformConfig).toMatchObject({
      whoMayWrite: 'anyone',
      outsideSessions: `user:${picked}`
    })
    expect(control.upserts.length).toBeGreaterThan(before)
    expect(control.upserts.at(-1)).toMatchObject({ platform: 'email', config: { whoMayWrite: 'anyone' } })

    const org = await app.app.inject({
      method: 'PUT',
      url: url(integrationId),
      payload: { whoMayWrite: 'anyone', outsideSessions: { kind: 'org' } }
    })
    expect(org.json()).toEqual({ whoMayWrite: 'anyone', outsideSessions: { kind: 'org' } })
  })

  it('refuses a pick who is not an active member of the organization', async () => {
    const { app } = harness()
    const { integrationId } = await withAddress(app)
    const res = await app.app.inject({
      method: 'PUT',
      url: url(integrationId),
      payload: { whoMayWrite: 'anyone', outsideSessions: { kind: 'member', userId: randomUUID() } }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'EMAIL_OUTSIDE_MEMBER_UNKNOWN' })
  })

  it('shows a departed pick as inactive', async () => {
    const { app } = harness()
    const { integrationId } = await withAddress(app)
    const picked = await makeUser('departing', 'collaborator')
    await app.app.inject({
      method: 'PUT',
      url: url(integrationId),
      payload: { whoMayWrite: 'anyone', outsideSessions: { kind: 'member', userId: picked } }
    })
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: picked } },
      data: { suspendedAt: new Date() }
    })
    expect((await app.app.inject({ method: 'GET', url: url(integrationId) })).json()).toMatchObject({
      outsideSessions: { kind: 'member', userId: picked, active: false }
    })
  })

  it('lets only an editor of the agent change them, and a viewer write nothing', async () => {
    const { app } = harness()
    const { integrationId } = await withAddress(app)
    const viewer = await makeUser('viewer', 'viewer')
    const { app: asViewer } = harness(viewer)
    expect((await asViewer.app.inject({ method: 'GET', url: url(integrationId) })).statusCode).toBe(200)
    const res = await asViewer.app.inject({
      method: 'PUT',
      url: url(integrationId),
      payload: { whoMayWrite: 'anyone', outsideSessions: { kind: 'org' } }
    })
    expect(res.statusCode).toBe(403)
  })

  it('answers 404 for an integration that is not an address', async () => {
    const { app } = harness()
    expect((await app.app.inject({ method: 'GET', url: url(randomUUID()) })).statusCode).toBe(404)
  })
})
