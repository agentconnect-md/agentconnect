// Computers (computer-use.md §2.2, §3.6, §4.1): registration exchange, revocation, visibility and the `computer` principal.
import { createHash, randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { ComputerId, OrgId } from '../../src/domain/ids.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { ComputerChannelGrants } from '../../src/registry/computerChannelGrants.js'
import { RelayRoster } from '../../src/orchestrator/relayRoster.js'
import { PgRelayRepo } from '../../src/persistence/repositories/relay.repo.js'
import { ComputerChannelKeys } from '../../src/registry/computerChannelKeys.js'
import { PgComputerRepo } from '../../src/persistence/repositories/computer.repo.js'
import { systemClock } from '../../src/domain/clock.js'
import { readComputerChannelToken } from '@agentconnect.md/protocol'
import { assertInstallerBaseUrl, type DesktopDistribution } from '../../src/computer-install/desktop-distribution.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REGISTER = '/api/v1/computers/register'
const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function appAs(userId: string = DEFAULT_OWNER_ID, withRelay: boolean | 'relay-turn' = false): HttpApp {
  const roster = new RelayRoster(new PgRelayRepo(prisma), { broadcastRelayRoster: () => {} }, systemClock, 45_000)
  const app = buildHttpApp(
    prisma,
    { DEFAULT_OWNER_ID: userId, PUBLIC_CP_URL: 'https://cp.example.com' },
    undefined,
    undefined,
    withRelay
      ? {
          computerViewer: new ComputerChannelGrants(
            new PgComputerRepo(prisma),
            new ComputerChannelKeys(TEST_API_KEY_PEPPER, 300),
            systemClock,
            {
              staleAfterMs: 45_000,
              relays: async () => [],
              viewerRelays: async () => ['https://relay.example.com'],
              ...(withRelay === 'relay-turn'
                ? { relayTurn: { secret: 'r'.repeat(43), ttlSec: 3600, servers: () => roster.turnServers() } }
                : { turn: { urls: ['turn:turn.example.com:3478'], secret: 'turn-shared-secret-0123', ttlSec: 3600 } }),
              stunUrls: () => roster.stunUrls()
            }
          )
        }
      : undefined
  )
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
      policy: { allowedMembers: [DEFAULT_OWNER_ID], agentMode: 'control', leaseIdleSeconds: 120 },
      // A new Computer admits no agent until someone gives agents access (§4.1).
      agentAccess: { mode: 'none', agents: [] },
      canEdit: true,
      canEditPolicy: true,
      canEditAgentAccess: true
    })
    expect(read.json().policy).not.toHaveProperty('allowedAgents')
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

  it('refuses a token whose registrant was demoted to viewer after minting it', async () => {
    const dana = await makeUser('cmp-demoted', 'collaborator')
    const { token } = await issueToken(appAs(dana))
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: dana } },
      data: { role: 'viewer' }
    })
    const res = await appAs().app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    expect(res.statusCode).toBe(401)
    expect(await prisma.computer.count()).toBe(0)
  })

  it('removing a member deletes their unspent tokens, so re-adding them does not revive one', async () => {
    const dana = await makeUser('cmp-readded', 'collaborator')
    const { token } = await issueToken(appAs(dana))
    expect((await appAs().app.inject({ method: 'DELETE', url: `${ORG}/members/${dana}` })).statusCode).toBe(204)
    expect(await prisma.computerRegistration.count({ where: { createdByUserId: dana } })).toBe(0)
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, 'cmp-readded@acme.dev', 'collaborator')
    const res = await appAs().app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    expect(res.statusCode).toBe(401)
    expect(await prisma.computer.count()).toBe(0)
  })

  it('reaps registration rows a grace period past their expiry, spent or not', async () => {
    const app = appAs()
    const stale = await issueToken(app)
    const spent = await issueToken(app)
    await app.app.inject({ method: 'POST', url: REGISTER, payload: { token: spent.token, ...profile } })
    const live = await issueToken(app)
    const old = new Date(Date.now() - 10 * 86_400_000)
    await prisma.computerRegistration.updateMany({
      where: { id: { in: [stale.id, spent.id] } },
      data: { expiresAt: old }
    })
    const reaped = await app.deps.repos.computer.reapRegistrations(new Date(Date.now() - 7 * 86_400_000))
    expect(reaped).toBe(2)
    expect((await prisma.computerRegistration.findMany()).map((r) => r.id)).toEqual([live.id])
    expect(await prisma.computer.count()).toBe(1)
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

  it('API keys cannot mint registration or viewer tokens, revoke or delete Computers', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    const personal = (
      await app.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
    ).json() as { apiKey: string }
    const headers = { authorization: `Bearer ${personal.apiKey}` }
    for (const request of [
      { method: 'POST' as const, url: `${ORG}/computers/registrations`, payload: {} },
      { method: 'POST' as const, url: `${ORG}/computers/${computerId}/revoke` },
      { method: 'POST' as const, url: `${ORG}/computers/${computerId}/viewer` },
      { method: 'DELETE' as const, url: `${ORG}/computers/${computerId}` }
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
    // The write itself is fenced too, for a revoke that lands after the route's read.
    const late = await app.deps.computers.setPolicy(OrgId(DEFAULT_ORG_ID), ComputerId(computerId), {
      ...res.json().policy,
      agentMode: 'view'
    })
    expect(late).toBeNull()
    const frozen = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })
    expect((frozen.policy as { agentMode: string }).agentMode).toBe('control')
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

describe('console registration status and stop', () => {
  it('tells only the token’s minter when it was spent and by which Computer', async () => {
    const app = appAs()
    const { token, id } = await issueToken(app)
    const before = await app.app.inject({ method: 'GET', url: `${ORG}/computers/registrations/${id}` })
    expect(before.statusCode).toBe(200)
    expect(before.json()).toMatchObject({ registrationId: id, consumedAt: null, computerId: null })
    expect(JSON.stringify(before.json())).not.toContain(token)
    const res = await app.app.inject({ method: 'POST', url: REGISTER, payload: { token, ...profile } })
    const after = await app.app.inject({ method: 'GET', url: `${ORG}/computers/registrations/${id}` })
    expect(after.json()).toMatchObject({ computerId: res.json().computerId })
    expect(after.json().consumedAt).toBeTruthy()
    const other = appAs(await makeUser('cmp-peeker', 'collaborator'))
    expect((await other.app.inject({ method: 'GET', url: `${ORG}/computers/registrations/${id}` })).statusCode).toBe(
      404
    )
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/computers/registrations/not-a-uuid` })).statusCode).toBe(
      404
    )
  })

  it('a console Stop holds the Computer paused until its owner resumes it', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    const stop = await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/stop` })
    expect(stop.statusCode).toBe(200)
    expect(stop.json()).toMatchObject({ stoppedByUserId: DEFAULT_OWNER_ID })
    expect(stop.json().stoppedAt).toBeTruthy()
    // Idempotent: the first stop's time stands.
    const again = await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/stop` })
    expect(again.json().stoppedAt).toBe(stop.json().stoppedAt)
    // A live Computer reads as paused while stopped.
    await prisma.computer.update({ where: { id: computerId }, data: { status: 'online', lastSeenAt: new Date() } })
    const read = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(read.json()).toMatchObject({ status: 'paused' })
    const resume = await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/resume` })
    expect(resume.statusCode).toBe(200)
    expect(resume.json()).toMatchObject({ status: 'online', stoppedAt: null, stoppedByUserId: null })
    // The audit write is best-effort and off the request path.
    await vi.waitFor(async () => {
      const audit = await prisma.auditEvent.findMany({ where: { kind: 'computer_change' } })
      expect(audit.map((a) => (a.details as { action: string }).action)).toEqual(
        expect.arrayContaining(['stop', 'resume'])
      )
    })
    await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/revoke` })
    expect((await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/stop` })).statusCode).toBe(409)
  })

  it('anyone who may revoke may stop, but only the owner resumes', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    const peer = appAs(await makeUser('cmp-stopper', 'collaborator'))
    expect((await peer.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/stop` })).statusCode).toBe(200)
    expect((await peer.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/resume` })).statusCode).toBe(
      403
    )
  })
})

describe('console viewer', () => {
  const live = (computerId: string) =>
    prisma.computer.update({ where: { id: computerId }, data: { status: 'online', lastSeenAt: new Date() } })

  it('names the TURN servers relays register, with credentials for the viewer and the desktop', async () => {
    const app = appAs(DEFAULT_OWNER_ID, 'relay-turn')
    const { computerId } = await register(app)
    await live(computerId)
    const url = `${ORG}/computers/${computerId}/viewer`
    expect((await app.app.inject({ method: 'POST', url })).json()).toMatchObject({ iceServers: [], directMedia: true })
    const turnUrls = ['turn:turn-0.example.com:3478?transport=udp', 'turns:turn-0.example.com:443?transport=tcp']
    const row = await new PgRelayRepo(prisma).upsertByName(
      'relay-turn-0',
      'wss://relay.example.com/relays/0',
      new Date(),
      [],
      null,
      turnUrls
    )
    expect(row.turnUrls).toEqual(turnUrls)
    const body = (await app.app.inject({ method: 'POST', url })).json() as {
      token: string
      iceServers: { urls: string[]; username: string }[]
    }
    expect(body.iceServers).toEqual([
      expect.objectContaining({
        urls: turnUrls,
        username: expect.stringMatching(new RegExp(`:viewer-${DEFAULT_OWNER_ID}$`))
      })
    ])
    expect(readComputerChannelToken(body.token)?.ice?.[0]).toMatchObject({
      urls: turnUrls,
      username: expect.stringMatching(new RegExp(`:computer-${computerId}$`))
    })
  })

  it('mints a view token for an allowed member with the relays and TURN credentials, and refuses everyone else', async () => {
    const app = appAs(DEFAULT_OWNER_ID, true)
    const { computerId } = await register(app)
    const url = `${ORG}/computers/${computerId}/viewer`
    // Offline: nothing to watch yet.
    expect((await app.app.inject({ method: 'POST', url })).statusCode).toBe(409)
    await live(computerId)
    const res = await app.app.inject({ method: 'POST', url })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      token: string
      expiresInMs: number
      mode: string
      relays: string[]
      iceServers: { username: string }[]
    }
    expect(body).toMatchObject({ mode: 'control', relays: ['https://relay.example.com'] })
    expect(body.expiresInMs).toBeGreaterThan(0)
    expect(body.expiresInMs).toBeLessThanOrEqual(120_000)
    expect(body.iceServers[0]?.username).toMatch(new RegExp(`:viewer-${DEFAULT_OWNER_ID}$`))
    expect(readComputerChannelToken(body.token)).toMatchObject({ aud: 'view', cmp: computerId, usr: DEFAULT_OWNER_ID })
    expect(body).toMatchObject({ stunUrls: [] })

    // A relay that serves STUN: the owner, the only one allowed to watch, may hole-punch through it.
    await prisma.relay.create({
      data: {
        id: randomUUID(),
        name: 'relay-stun-0',
        daemonUrl: 'wss://relay.example.com/relays/0',
        stunUrl: 'stun:stun-0.example.com:3478',
        lastSeenAt: new Date()
      }
    })
    // A desktop that predates relay STUN would refuse a token carrying it, so it gets none.
    expect((await app.app.inject({ method: 'POST', url })).json()).toMatchObject({ stunUrls: [] })
    await prisma.computer.update({
      where: { id: computerId },
      data: { capabilities: { viewer: true, viewerStun: true } }
    })
    const punched = (await app.app.inject({ method: 'POST', url })).json() as { token: string; stunUrls: string[] }
    expect(punched.stunUrls).toEqual(['stun:stun-0.example.com:3478'])
    expect(readComputerChannelToken(punched.token)?.stun).toEqual(['stun:stun-0.example.com:3478'])

    // An org owner who can see the Computer but is not one of its allowed members may not watch it.
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    const peerId = await makeUser('cmp-watcher', 'viewer')
    const peer = appAs(peerId, true)
    expect((await peer.app.inject({ method: 'POST', url })).statusCode).toBe(403)
    // Once allowed, an organization viewer watches without taking over.
    const policy = (await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })).json().policy
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: { ...policy, allowedMembers: [DEFAULT_OWNER_ID, peerId] }
    })
    const watched = await peer.app.inject({ method: 'POST', url })
    expect(watched.statusCode).toBe(200)
    // Another member watching would learn the desktop's public IP, so no STUN unless the policy says so.
    expect(watched.json()).toMatchObject({ mode: 'view', stunUrls: [] })

    await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/revoke` })
    expect((await app.app.inject({ method: 'POST', url })).statusCode).toBe(409)
  })

  it('answers 503 when no relay can carry the viewer', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    await live(computerId)
    expect((await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/viewer` })).statusCode).toBe(
      503
    )
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
      { method: 'POST' as const, url: `${ORG}/computers/${computerId}/viewer` },
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

    // The registrant always stays in a Selected audience, so a non-member list still keeps them.
    const stale = await appAs(dana).app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: ['someone-else'] }
    })
    expect(stale.statusCode).toBe(200)
    expect(stale.json().sharedWith).toEqual([dana])
  })

  it('a collaborator or org owner cannot drop the registrant from a Selected audience', async () => {
    const dana = await makeUser('cmp-keep-dana', 'collaborator')
    const erin = await makeUser('cmp-keep-erin', 'collaborator')
    const { computerId } = await register(appAs(dana))
    const danaApp = appAs(dana)
    await danaApp.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [dana, erin] }
    })
    for (const [actor, sharedWith] of [
      [erin, [erin]],
      [DEFAULT_OWNER_ID, [DEFAULT_OWNER_ID]]
    ] as const) {
      const res = await appAs(actor).app.inject({
        method: 'PUT',
        url: `${ORG}/computers/${computerId}/sharing`,
        payload: { visibility: 'restricted', sharedWith }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().sharedWith).toEqual([dana, ...sharedWith])
    }
    expect((await danaApp.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })).statusCode).toBe(200)
    const policy = await danaApp.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: {}
    })
    expect(policy.statusCode).toBe(200)
  })

  it('the registrant sets the policy and the owner stays a member', async () => {
    const app = appAs()
    const { computerId } = await register(app)
    const bob = await makeUser('cmp-bob', 'collaborator')

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: {
        allowedMembers: [bob, 'not-a-member'],
        agentMode: 'view',
        approvals: { launchApp: 'session' },
        redactApps: ['org.keepassxc.KeePassXC'],
        quietHours: { tz: 'Asia/Shanghai', ranges: ['22:00-23:59'] },
        leaseIdleSeconds: 60,
        leaseMaxSeconds: 600,
        leaseWaitSeconds: 120
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().policy).toEqual({
      allowedMembers: [DEFAULT_OWNER_ID, bob],
      agentMode: 'view',
      approvals: { firstInputPerSession: true, launchApp: 'session', submitLikeKeys: true },
      redactApps: ['org.keepassxc.KeePassXC'],
      exposeDriverTools: false,
      quietHours: { tz: 'Asia/Shanghai', ranges: ['22:00-23:59'] },
      leaseIdleSeconds: 60,
      leaseMaxSeconds: 600,
      leaseWaitSeconds: 120
    })
    // The policy carries no agents: agent access is its own relation.
    expect(res.json().agentAccess).toEqual({ mode: 'none', agents: [] })

    const invalid = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: { leaseIdleSeconds: 900, leaseMaxSeconds: 600 }
    })
    expect(invalid.statusCode).toBe(400)
  })
})

describe('Linux installer', () => {
  const sha = createHash('sha256').update('bundle-bytes').digest('hex')
  const dist: DesktopDistribution = {
    bundle: 'bundle-bytes',
    legal: 'MIT notices',
    sha256: sha,
    linuxInstaller: (base) => `CP_URL='${assertInstallerBaseUrl(base)}' SHA='${sha}'`
  }
  const withDist = (): HttpApp => {
    const app = buildHttpApp(
      prisma,
      { DEFAULT_OWNER_ID, PUBLIC_CP_URL: 'https://cp.example.com' },
      undefined,
      undefined,
      { desktopDistribution: dist }
    )
    opened.push(app)
    return app
  }

  it('names the installer in a registration only when the bundle ships', async () => {
    const without = await appAs().app.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
    expect(without.json().linuxInstallerUrl).toBeNull()
    const res = await withDist().app.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
    expect(res.json().linuxInstallerUrl).toBe('https://cp.example.com/v1/computers/install.sh')
    // A checkout carries the dev version, so the console's Docker command falls back to latest.
    expect(without.json().desktopImage).toBe('ghcr.io/agentconnect-md/desktop:latest')
  })

  it('serves the installer filled in for this CP, and the bundle by checksum, on both prefixes without auth', async () => {
    const app = withDist()
    for (const prefix of ['/api/v1', '/v1']) {
      const script = await app.app.inject({ method: 'GET', url: `${prefix}/computers/install.sh` })
      expect(script.statusCode).toBe(200)
      expect(script.headers['content-type']).toBe('text/x-shellscript; charset=utf-8')
      expect(script.body).toBe(`CP_URL='https://cp.example.com' SHA='${sha}'`)

      const bundle = await app.app.inject({
        method: 'GET',
        url: `${prefix}/computers/desktop/${sha}/agentconnect-desktop.mjs`
      })
      expect(bundle.statusCode).toBe(200)
      expect(bundle.body).toBe('bundle-bytes')
      expect(bundle.headers.etag).toBe(`"${sha}"`)
      const cached = await app.app.inject({
        method: 'GET',
        url: `${prefix}/computers/desktop/${sha}/agentconnect-desktop.mjs`,
        headers: { 'if-none-match': `"${sha}"` }
      })
      expect(cached.statusCode).toBe(304)
      const legal = await app.app.inject({
        method: 'GET',
        url: `${prefix}/computers/desktop/${sha}/agentconnect-desktop.mjs.LEGAL.txt`
      })
      expect(legal.body).toBe('MIT notices')
    }
    const other = await app.app.inject({ method: 'GET', url: `/v1/computers/desktop/${sha}/..%2Fpackage.json` })
    expect(other.statusCode).toBe(400)
  })

  it('answers 404 with a retry hint for another bundle, as a replica mid-upgrade would hold', async () => {
    const res = await withDist().app.inject({
      method: 'GET',
      url: `/v1/computers/desktop/${'0'.repeat(64)}/agentconnect-desktop.mjs`
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().message).toMatch(/different desktop bundle; retry/)
  })

  it('answers 404 when this CP ships no bundle', async () => {
    const app = appAs()
    expect((await app.app.inject({ method: 'GET', url: '/v1/computers/install.sh' })).statusCode).toBe(404)
    const bundle = await app.app.inject({ method: 'GET', url: `/v1/computers/desktop/${sha}/agentconnect-desktop.mjs` })
    expect(bundle.statusCode).toBe(404)
  })

  it('refuses a Host header that would break out of the script', async () => {
    const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID }, undefined, undefined, { desktopDistribution: dist })
    opened.push(app)
    const res = await app.app.inject({
      method: 'GET',
      url: '/v1/computers/install.sh',
      headers: { host: "x';reboot;'" }
    })
    expect(res.statusCode).toBe(400)
  })
})
