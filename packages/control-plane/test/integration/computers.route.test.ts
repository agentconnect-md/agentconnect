// Computers (computer-use.md §2.2, §3.6, §4.1): registration exchange, revocation, visibility and the `computer` principal.
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REGISTER = '/api/v1/computers/register'
const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function appAs(userId: string = DEFAULT_OWNER_ID): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId, PUBLIC_CP_URL: 'https://cp.example.com' })
  opened.push(app)
  return app
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

const profile = {
  name: 'ubuntu-desk',
  os: 'linux',
  osVersion: 'Ubuntu 26.04',
  session: 'x11',
  desktopDaemonVersion: '0.1.0',
  driverVersion: '0.35.2',
  capabilities: {
    screenshot: true,
    input: true,
    viewer: true,
    displays: [{ id: '0', width: 1920, height: 1080, scale: 1 }]
  }
}

async function issueToken(app: HttpApp, body: Record<string, unknown> = {}): Promise<{ token: string; id: string }> {
  const res = await app.app.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: body })
  expect(res.statusCode).toBe(201)
  const json = res.json() as { token: string; registrationId: string; exchangeUrl: string; expiresAt: string }
  expect(json.exchangeUrl).toBe('https://cp.example.com/v1/computers/register')
  return { token: json.token, id: json.registrationId }
}

async function register(app: HttpApp, extra: Record<string, unknown> = {}) {
  const { token } = await issueToken(app)
  const res = await app.app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile, ...extra } })
  expect(res.statusCode).toBe(201)
  return res.json() as { computerId: string; orgId: string; apiKey: string; apiKeyId: string; displayTail: string }
}

describe('registration exchange', () => {
  it('exchanges a one-time token for a Computer bound to the registrant and a hash-only computer key', async () => {
    const app = appAs()
    const { token, id } = await issueToken(app, { name: 'Office desktop', ttlMinutes: 30 })
    const res = await app.app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { computerId: string; orgId: string; apiKey: string; apiKeyId: string }
    expect(body.orgId).toBe(DEFAULT_ORG_ID)

    const computer = await prisma.computer.findUniqueOrThrow({ where: { id: body.computerId } })
    expect(computer).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      name: 'Office desktop', // the console's name wins over the hostname
      ownerUserId: DEFAULT_OWNER_ID,
      kind: 'self_hosted',
      isolation: 'none',
      os: 'linux',
      session: 'x11',
      status: 'offline',
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    const parsed = codec.parse(body.apiKey)!
    const key = await prisma.apiKey.findUniqueOrThrow({ where: { hash: codec.hash(parsed.secret) } })
    expect(key).toMatchObject({ id: body.apiKeyId, principalType: 'computer', computerId: body.computerId })
    expect(key.daemonId).toBeNull()
    expect(key.userId).toBeNull()
    const registration = await prisma.computerRegistration.findUniqueOrThrow({ where: { id } })
    expect(registration.consumedAt).not.toBeNull()
    expect(registration.computerId).toBe(body.computerId)

    // The console reads the reported platform, the default policy and the caller's rights.
    const read = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${body.computerId}` })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({
      kind: 'self-hosted',
      session: 'x11',
      capabilities: { screenshot: true, textInput: 'full', displays: [{ width: 1920 }] },
      policy: { allowedAgents: [], allowedMembers: [DEFAULT_OWNER_ID], agentMode: 'control', leaseIdleSeconds: 120 },
      canEdit: true,
      canEditPolicy: true
    })
  })

  it('spends a token once, even under concurrent exchanges', async () => {
    const app = appAs()
    const { token } = await issueToken(app)
    const [a, b] = await Promise.all([
      app.app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } }),
      app.app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 401])
    const again = await app.app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    expect(again.statusCode).toBe(401)
    expect(await prisma.computer.count()).toBe(1)
  })

  it('refuses an expired, unknown or malformed token alike and creates nothing', async () => {
    const app = appAs()
    const { token, id } = await issueToken(app)
    await prisma.computerRegistration.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    for (const t of [token, codec.mint().token, 'not-a-token']) {
      const res = await app.app.inject({ method: 'POST', url: REGISTER, payload: { token: t, ...profile } })
      expect(res.statusCode).toBe(401)
      expect(res.json().message).toBe('invalid or expired registration token')
    }
    expect(await prisma.computer.count()).toBe(0)
    expect(await prisma.apiKey.count({ where: { principalType: 'computer' } })).toBe(0)
  })

  it('refuses a token whose registrant has left the organization', async () => {
    const dana = await makeUser('cmp-dana', 'collaborator')
    const { token } = await issueToken(appAs(dana))
    await prisma.membership.deleteMany({ where: { orgId: DEFAULT_ORG_ID, userId: dana } })
    const res = await appAs().app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    expect(res.statusCode).toBe(401)
    expect(await prisma.computer.count()).toBe(0)
  })

  it('cannot claim to be a managed computer, and validates the reported profile', async () => {
    const app = appAs()
    const { token } = await issueToken(app)
    const managed = await app.app.inject({
      method: 'POST',
      url: REGISTER,
      payload: { token, ...profile, kind: 'managed' }
    })
    expect(managed.statusCode).toBe(400)
    const badSession = await app.app.inject({
      method: 'POST',
      url: REGISTER,
      payload: { token, ...profile, session: 'tty' }
    })
    expect(badSession.statusCode).toBe(400)
  })

  it('serves the exchange at the public /v1 alias the handed-out URL names', async () => {
    const app = appAs()
    const { token } = await issueToken(app)
    const res = await app.app.inject({ method: 'POST', url: '/v1/computers/register', payload: { token, ...profile } })
    expect(res.statusCode).toBe(201)
  })

  it('a viewer cannot mint a registration token', async () => {
    const viewer = await makeUser('cmp-viewer', 'viewer')
    const res = await appAs(viewer).app.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
    expect(res.statusCode).toBe(403)
  })
})

describe('the computer principal', () => {
  it('authenticates only the Computer channel: never the REST surface or the daemon WebSocket', async () => {
    const app = appAs()
    const { computerId, apiKey } = await register(app)
    expect(await app.deps.computers.authenticate(apiKey)).toMatchObject({ computerId, orgId: DEFAULT_ORG_ID })

    const rest = await app.app.inject({
      method: 'GET',
      url: `${ORG}/computers`,
      headers: { authorization: `Bearer ${apiKey}` }
    })
    expect(rest.statusCode).toBe(401)
    const mcp = await app.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {}
    })
    expect(mcp.statusCode).toBe(401)

    const ws = await app.deps.auth.authenticate(
      { apiKey, agentVersion: '1.0.0' },
      { remoteAddr: '127.0.0.1', subprotocol: 'agentconnect.v1' }
    )
    expect(ws).toMatchObject({ ok: false, closeCode: 4401 })
  })

  it('refuses a daemon or personal key on the Computer channel', async () => {
    const app = appAs()
    const daemon = (await app.app.inject({ method: 'POST', url: `${ORG}/daemons/token` })).json() as { apiKey: string }
    const personal = (
      await app.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
    ).json() as { apiKey: string }
    expect(await app.deps.computers.authenticate(daemon.apiKey)).toBeNull()
    expect(await app.deps.computers.authenticate(personal.apiKey)).toBeNull()
  })

  it('API keys cannot mint registration tokens or revoke Computers', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    const personal = (
      await app.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
    ).json() as { apiKey: string }
    const headers = { authorization: `Bearer ${personal.apiKey}` }
    for (const request of [
      { method: 'POST' as const, url: `${ORG}/computers/registrations`, payload: {} },
      { method: 'POST' as const, url: `${ORG}/computers/${computerId}/revoke` }
    ]) {
      const res = await app.app.inject({ ...request, headers })
      expect(res.statusCode, request.url).toBe(403)
      expect(res.json().message).toBe('interactive sign-in required')
    }
    expect(await prisma.computerRegistration.count()).toBe(1)
    expect((await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).status).toBe('offline')
    // Reading stays open to a key, like every other documented route.
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/computers`, headers })
    expect(list.statusCode).toBe(200)
  })
})

describe('revoke and delete', () => {
  it('revoking marks the Computer revoked, kills its keys at once, and is idempotent', async () => {
    const app = appAs()
    const { computerId, apiKey } = await register(app)
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/revoke` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'revoked', canEditPolicy: false })
    expect(res.json().revokedAt).toBeTruthy()
    expect(await app.deps.computers.authenticate(apiKey)).toBeNull()
    expect(await prisma.apiKey.count({ where: { computerId, revokedAt: null } })).toBe(0)

    const again = await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/revoke` })
    expect(again.statusCode).toBe(200)
    // A revoked Computer's policy is frozen; delete is how it leaves.
    const policy = await app.app.inject({ method: 'PUT', url: `${ORG}/computers/${computerId}/policy`, payload: {} })
    expect(policy.statusCode).toBe(409)
    const audit = await prisma.auditEvent.findMany({ where: { kind: 'computer_change' } })
    expect(audit.map((a) => (a.details as { action: string }).action)).toEqual(
      expect.arrayContaining(['registration_create', 'register', 'revoke'])
    )
  })

  it('deleting removes the Computer and cascades its keys', async () => {
    const app = appAs()
    const { computerId, apiKey } = await register(app)
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/computers/${computerId}` })
    expect(res.statusCode).toBe(204)
    expect(await prisma.computer.count({ where: { id: computerId } })).toBe(0)
    expect(await prisma.apiKey.count({ where: { computerId } })).toBe(0)
    expect(await app.deps.computers.authenticate(apiKey)).toBeNull()
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })).statusCode).toBe(404)
  })

  it('removing the registrant from the organization revokes their Computers', async () => {
    const dana = await makeUser('cmp-leaver', 'collaborator')
    const { computerId, apiKey } = await register(appAs(dana))
    const res = await appAs().app.inject({ method: 'DELETE', url: `${ORG}/members/${dana}` })
    expect(res.statusCode).toBe(204)
    const row = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })
    expect(row.status).toBe('revoked')
    // The Selected audience was repaired to a remaining owner, so the Computer is still governable.
    expect(row.sharedWith).toEqual([DEFAULT_OWNER_ID])
    expect(await appAs().deps.computers.authenticate(apiKey)).toBeNull()
  })
})

describe('visibility and policy', () => {
  it('a personal desktop is visible to its registrant and organization owners only', async () => {
    const dana = await makeUser('cmp-owner-dana', 'collaborator')
    const erin = await makeUser('cmp-erin', 'collaborator')
    const { computerId } = await register(appAs(dana))

    const erinApp = appAs(erin)
    expect((await erinApp.app.inject({ method: 'GET', url: `${ORG}/computers` })).json()).toEqual([])
    for (const request of [
      { method: 'GET' as const, url: `${ORG}/computers/${computerId}` },
      { method: 'PUT' as const, url: `${ORG}/computers/${computerId}/policy`, payload: {} },
      { method: 'PUT' as const, url: `${ORG}/computers/${computerId}/sharing`, payload: { visibility: 'org' } },
      { method: 'POST' as const, url: `${ORG}/computers/${computerId}/revoke` },
      { method: 'DELETE' as const, url: `${ORG}/computers/${computerId}` }
    ]) {
      expect((await erinApp.app.inject(request)).statusCode, `${request.method} ${request.url}`).toBe(404)
    }

    // The org owner sees it by role and may revoke it, but may not grant agents control of someone else's desktop.
    const ownerApp = appAs()
    const seen = (await ownerApp.app.inject({ method: 'GET', url: `${ORG}/computers` })).json() as Array<{
      id: string
      canEdit: boolean
      canEditPolicy: boolean
    }>
    expect(seen).toEqual([expect.objectContaining({ id: computerId, canEdit: true, canEditPolicy: false })])
    const ownerPolicy = await ownerApp.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: {}
    })
    expect(ownerPolicy.statusCode).toBe(403)

    // Sharing with a collaborator lets them see and manage it, still not change who controls it.
    const share = await appAs(dana).app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [dana, erin] }
    })
    expect(share.statusCode).toBe(200)
    const erinRead = await erinApp.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(erinRead.json()).toMatchObject({ canEdit: true, canEditPolicy: false })
    expect(
      (await erinApp.app.inject({ method: 'PUT', url: `${ORG}/computers/${computerId}/policy`, payload: {} }))
        .statusCode
    ).toBe(403)

    // Selected must keep a member.
    const empty = await appAs(dana).app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: ['someone-else'] }
    })
    expect(empty.statusCode).toBe(409)
  })

  it('the registrant sets the policy; agents must be visible and the owner stays a member', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { name: 'desk-agent' })
    const bob = await makeUser('cmp-bob', 'collaborator')

    const unknown = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: { allowedAgents: [randomUUID()] }
    })
    expect(unknown.statusCode).toBe(400)

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: {
        allowedAgents: [agentId, agentId],
        allowedMembers: [bob, 'not-a-member'],
        agentMode: 'view',
        approvals: { launchApp: 'session' },
        redactApps: ['org.keepassxc.KeePassXC'],
        quietHours: { tz: 'Asia/Shanghai', ranges: ['22:00-23:59'] },
        leaseIdleSeconds: 60,
        leaseMaxSeconds: 600
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().policy).toEqual({
      allowedAgents: [agentId],
      allowedMembers: [DEFAULT_OWNER_ID, bob],
      agentMode: 'view',
      approvals: { firstInputPerSession: true, launchApp: 'session', submitLikeKeys: true },
      redactApps: ['org.keepassxc.KeePassXC'],
      exposeDriverTools: false,
      quietHours: { tz: 'Asia/Shanghai', ranges: ['22:00-23:59'] },
      leaseIdleSeconds: 60,
      leaseMaxSeconds: 600
    })
    const stored = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })
    expect((stored.policy as { allowedAgents: string[] }).allowedAgents).toEqual([agentId])

    const invalid = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: { leaseIdleSeconds: 900, leaseMaxSeconds: 600 }
    })
    expect(invalid.statusCode).toBe(400)
  })
})
