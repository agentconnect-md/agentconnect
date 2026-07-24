import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Prisma } from '../../src/generated/prisma/client.js'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { ORG_INVITE_TTL_MS } from '../../src/registry/orgInviteLinkService.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const OWNER_SUBJECT = 'invite-owner'
const OIDC_AUDIENCE = 'invite-link-test'

let oidcServer: Server
let oidcIssuer = ''
let mintBearer: (subject: string, email: string) => Promise<string>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'invite-test', use: 'sig' }
  oidcServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: oidcIssuer, jwks_uri: `${oidcIssuer}/jwks` }))
      return
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    oidcServer.once('error', reject)
    oidcServer.listen(0, '127.0.0.1', resolve)
  })
  const { port } = oidcServer.address() as AddressInfo
  oidcIssuer = `http://127.0.0.1:${port}`
  mintBearer = (subject, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'invite-test' })
      .setIssuer(oidcIssuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      oidcServer.close((err) => (err ? reject(err) : resolve()))
    })
)

interface InviteBody {
  id: string
  displayTail: string
  status: 'active' | 'expired' | 'revoked'
  expiresAt: string
  revokedAt: string | null
  createdAt: string
  token: string
}

const signup = (subject: string, email: string) =>
  new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: subject, email, emailVerified: true })

const buildOidcApp = () => buildHttpApp(prisma, { OIDC_ISSUER: oidcIssuer, OIDC_AUDIENCE })

async function oidcHeaders(subject: string, email: string) {
  return { authorization: `Bearer ${await mintBearer(subject, email)}` }
}

async function ownerHeaders() {
  await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { oidcSubject: OWNER_SUBJECT } })
  return oidcHeaders(OWNER_SUBJECT, DEFAULT_OWNER_EMAIL)
}

async function generateLink(): Promise<InviteBody> {
  const { app, close } = buildOidcApp()
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${ORG}/invite-links`,
      headers: await ownerHeaders(),
      payload: {}
    })
    expect(res.statusCode).toBe(201)
    return res.json() as InviteBody
  } finally {
    await close()
  }
}

async function acceptAs(subject: string, email: string, token: string) {
  const { app, close } = buildOidcApp()
  try {
    return await app.inject({
      method: 'POST',
      url: '/api/v1/invite-links/accept',
      headers: await oidcHeaders(subject, email),
      payload: { token }
    })
  } finally {
    await close()
  }
}

describe('organization invite-link management', () => {
  it('creates exactly one fixed seven-day link and never lists its token/hash', async () => {
    const before = Date.now()
    const { app, close } = buildOidcApp()
    const headers = await ownerHeaders()
    try {
      const created = await app.inject({ method: 'POST', url: `${ORG}/invite-links`, headers, payload: {} })
      expect(created.statusCode).toBe(201)
      const body = created.json() as InviteBody
      expect(body.status).toBe('active')
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThanOrEqual(before + ORG_INVITE_TTL_MS)
      expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + ORG_INVITE_TTL_MS)

      const duplicate = await app.inject({ method: 'POST', url: `${ORG}/invite-links`, headers, payload: {} })
      expect(duplicate.statusCode).toBe(409)

      const listed = await app.inject({ method: 'GET', url: `${ORG}/invite-links`, headers })
      expect(listed.statusCode).toBe(200)
      expect(listed.json()).toMatchObject({ id: body.id, status: 'active', displayTail: body.displayTail })
      expect(listed.body).not.toContain(body.token)
      expect(listed.body).not.toContain('tokenHash')
    } finally {
      await close()
    }
  })

  it('shows expired/revoked state and permits one replacement link', async () => {
    const first = await generateLink()
    const { app, close } = buildOidcApp()
    const headers = await ownerHeaders()
    try {
      await prisma.orgInviteLink.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() - 1) } })
      const expired = await app.inject({ method: 'GET', url: `${ORG}/invite-links`, headers })
      expect(expired.json()).toMatchObject({ id: first.id, status: 'expired' })

      const replacement = await app.inject({ method: 'POST', url: `${ORG}/invite-links`, headers, payload: {} })
      expect(replacement.statusCode).toBe(201)
      const second = replacement.json() as InviteBody
      expect(second.id).not.toBe(first.id)
      expect(second.token).not.toBe(first.token)
      expect(await prisma.orgInviteLink.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(1)

      const revoked = await app.inject({ method: 'DELETE', url: `${ORG}/invite-links/${second.id}`, headers })
      expect(revoked.statusCode).toBe(204)
      const listed = await app.inject({ method: 'GET', url: `${ORG}/invite-links`, headers })
      expect(listed.json()).toMatchObject({ id: second.id, status: 'revoked' })

      const third = await app.inject({ method: 'POST', url: `${ORG}/invite-links`, headers, payload: {} })
      expect(third.statusCode).toBe(201)
      expect((third.json() as InviteBody).id).not.toBe(second.id)
      expect(await prisma.orgInviteLink.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(1)
    } finally {
      await close()
    }
  })

  it('is owner-only', async () => {
    const dana = await signup('invite-collaborator', 'invite-collaborator@acme.dev')
    await new PgUserRepo(prisma).addMember(DEFAULT_ORG_ID, dana.userId, 'collaborator')
    const { app, close } = buildOidcApp()
    const headers = await oidcHeaders('invite-collaborator', 'invite-collaborator@acme.dev')
    try {
      expect((await app.inject({ method: 'GET', url: `${ORG}/invite-links`, headers })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: `${ORG}/invite-links`, headers, payload: {} })).statusCode).toBe(
        403
      )
    } finally {
      await close()
    }
  })

  it('does not expose management through fixed-principal devAuth', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const listed = await app.inject({ method: 'GET', url: `${ORG}/invite-links` })
      const created = await app.inject({ method: 'POST', url: `${ORG}/invite-links`, payload: {} })
      expect(listed.statusCode).toBe(503)
      expect(created.statusCode).toBe(503)
      expect(created.json()).toMatchObject({ code: 'OIDC_AUTH_UNAVAILABLE' })
    } finally {
      await close()
    }
  })
})

describe('POST /invite-links/accept', () => {
  it('requires real OIDC instead of redeeming as the devAuth principal', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invite-links/accept',
        payload: { token: 'x'.repeat(43) }
      })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'OIDC_AUTH_UNAVAILABLE' })
    } finally {
      await close()
    }
  })

  it('allows unlimited distinct accounts and always grants collaborator', async () => {
    const link = await generateLink()
    const dana = await signup('invite-dana', 'invite-dana@acme.dev')
    const lee = await signup('invite-lee', 'invite-lee@acme.dev')

    const first = await acceptAs('invite-dana', 'invite-dana@acme.dev', link.token)
    const second = await acceptAs('invite-lee', 'invite-lee@acme.dev', link.token)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ status: 'accepted', org: { id: DEFAULT_ORG_ID } })
    expect(second.json()).toMatchObject({ status: 'accepted', org: { id: DEFAULT_ORG_ID } })

    const memberships = await prisma.membership.findMany({
      where: { orgId: DEFAULT_ORG_ID, userId: { in: [dana.userId, lee.userId] } }
    })
    expect(memberships).toHaveLength(2)
    expect(memberships.every((m) => m.role === 'collaborator')).toBe(true)
  })

  it('atomically audits link creation, successful redemption, and revocation', async () => {
    const link = await generateLink()
    const dana = await signup('invite-audit', 'invite-audit@acme.dev')
    expect((await acceptAs('invite-audit', 'invite-audit@acme.dev', link.token)).statusCode).toBe(200)

    const { app, close } = buildOidcApp()
    try {
      const revoked = await app.inject({
        method: 'DELETE',
        url: `${ORG}/invite-links/${link.id}`,
        headers: await ownerHeaders()
      })
      expect(revoked.statusCode).toBe(204)
    } finally {
      await close()
    }

    const rows = await prisma.auditEvent.findMany({
      where: { kind: 'org_invite_change' },
      orderBy: { id: 'asc' }
    })
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => (row.details as { action: string }).action)).toEqual(['created', 'redeemed', 'revoked'])
    expect(rows.map((row) => row.actorUserId)).toEqual([DEFAULT_OWNER_ID, dana.userId, DEFAULT_OWNER_ID])
    expect(rows.every((row) => (row.details as { inviteLinkId: string }).inviteLinkId === link.id)).toBe(true)
  })

  it('does not commit an acceptance after a concurrent revoke completes', async () => {
    const link = await generateLink()
    await signup('invite-revoke-race', 'invite-revoke-race@acme.dev')
    const { app, close } = buildOidcApp()
    const headers = await ownerHeaders()

    let releaseLock!: () => void
    let markLocked!: () => void
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve
    })
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "org_invite_link" WHERE "id" = ${link.id} FOR UPDATE
      `)
      markLocked()
      await release
    })
    await locked

    let released = false
    const unlock = () => {
      if (released) return
      released = true
      releaseLock()
    }
    const waitingLocks = async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>(Prisma.sql`
        SELECT count(*)::bigint AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `)
      return Number(rows[0]?.waiting ?? 0n)
    }

    try {
      const revoke = app.inject({ method: 'DELETE', url: `${ORG}/invite-links/${link.id}`, headers })
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(1))

      const accept = acceptAs('invite-revoke-race', 'invite-revoke-race@acme.dev', link.token)
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(2))

      unlock()
      const [revokeRes, acceptRes] = await Promise.all([revoke, accept])
      expect(revokeRes.statusCode).toBe(204)
      expect(acceptRes.statusCode).toBe(410)
      expect(acceptRes.json()).toMatchObject({ code: 'INVITE_LINK_UNAVAILABLE' })
    } finally {
      unlock()
      await blocker
      await close()
    }
  })

  it('prevents the same account from redeeming the same link again', async () => {
    const link = await generateLink()
    const dana = await signup('invite-reuse', 'invite-reuse@acme.dev')

    expect((await acceptAs('invite-reuse', 'invite-reuse@acme.dev', link.token)).json()).toMatchObject({
      status: 'accepted'
    })
    const secondAttempt = await acceptAs('invite-reuse', 'invite-reuse@acme.dev', link.token)
    expect(secondAttempt.statusCode).toBe(410)
    expect(secondAttempt.json()).toMatchObject({ code: 'INVITE_LINK_UNAVAILABLE' })

    await new PgUserRepo(prisma).removeMember(DEFAULT_ORG_ID, dana.userId)
    const reused = await acceptAs('invite-reuse', 'invite-reuse@acme.dev', link.token)
    expect(reused.statusCode).toBe(410)
    expect(reused.json()).toMatchObject({ code: 'INVITE_LINK_UNAVAILABLE' })
    expect(await prisma.orgInviteRedemption.count({ where: { inviteLinkId: link.id, userId: dana.userId } })).toBe(1)
  })

  it('rejects malformed, expired, and revoked links with the same response', async () => {
    await signup('invite-unavailable', 'invite-unavailable@acme.dev')
    const malformed = await acceptAs('invite-unavailable', 'invite-unavailable@acme.dev', 'bad')
    expect(malformed.statusCode).toBe(410)

    const expired = await generateLink()
    await prisma.orgInviteLink.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1) } })
    const expiredRes = await acceptAs('invite-unavailable', 'invite-unavailable@acme.dev', expired.token)
    expect(expiredRes.statusCode).toBe(410)

    const { app, close } = buildOidcApp()
    const headers = await ownerHeaders()
    try {
      const replacement = await app.inject({ method: 'POST', url: `${ORG}/invite-links`, headers, payload: {} })
      const active = replacement.json() as InviteBody
      await app.inject({ method: 'DELETE', url: `${ORG}/invite-links/${active.id}`, headers })
      const revokedRes = await acceptAs('invite-unavailable', 'invite-unavailable@acme.dev', active.token)
      expect(revokedRes.statusCode).toBe(410)
      expect(revokedRes.body).toBe(expiredRes.body)
    } finally {
      await close()
    }
  })
})
