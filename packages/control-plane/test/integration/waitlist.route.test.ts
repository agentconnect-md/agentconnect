import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { ActivationLinkTokenCodec } from '../../src/registry/activationLinkToken.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const OIDC_AUDIENCE = 'waitlist-test'
const codec = new ActivationLinkTokenCodec(TEST_API_KEY_PEPPER)

let oidcServer: Server
let oidcIssuer = ''
let mintBearer: (subject: string, email?: string) => Promise<string>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'waitlist-test', use: 'sig' }
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
  mintBearer = (subject, email) => {
    const claims: Record<string, unknown> = {}
    if (email) claims.email = email
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'waitlist-test' })
      .setIssuer(oidcIssuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
  }
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      oidcServer.close((err) => (err ? reject(err) : resolve()))
    })
)

/** A waitlist-mode app (real OIDC + gate on). */
const buildApp = () => buildHttpApp(prisma, { OIDC_ISSUER: oidcIssuer, OIDC_AUDIENCE, WAITLIST_MODE: true })
const headers = async (subject: string, email?: string) => ({
  authorization: `Bearer ${await mintBearer(subject, email)}`
})

interface MintOpts {
  expiresInMs?: number
  revoked?: boolean
  note?: string
}

/** Simulate the external admin app minting a link into the one activation-link list.
 *  `email: null` ⇒ an unbound link that binds itself to its first redeemer. */
async function mintLink(email: string | null, opts: MintOpts = {}) {
  const minted = codec.mint()
  const now = Date.now()
  await prisma.activationLink.create({
    data: {
      email,
      boundAt: email ? new Date(now) : null, // born bound vs bound on first use
      tokenHash: minted.hash,
      displayTail: minted.displayTail,
      note: opts.note ?? null,
      expiresAt: new Date(now + (opts.expiresInMs ?? 7 * 24 * 3600 * 1000)),
      revokedAt: opts.revoked ? new Date(now - 1) : null
    }
  })
  return minted.token
}

const linkFor = (token: string) => prisma.activationLink.findUnique({ where: { tokenHash: codec.hash(token)! } })

/** Simulate the external admin app approving an applicant + minting their bound link. */
async function approveAndMint(email: string, opts: MintOpts = {}) {
  await prisma.waitlistEntry.upsert({
    where: { email },
    create: { email, status: 'approved', source: 'admin', approvedAt: new Date() },
    update: { status: 'approved', approvedAt: new Date() }
  })
  return mintLink(email, opts)
}

describe('waitlist admission — GET /me/access', () => {
  it('always reports active when waitlist mode is off', async () => {
    const { app, close } = buildHttpApp(prisma, { OIDC_ISSUER: oidcIssuer, OIDC_AUDIENCE })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/access',
        headers: await headers('wl-off', 'wl-off@acme.dev')
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ waitlistMode: false, status: 'active' })
    } finally {
      await close()
    }
  })

  it('a stranger is "none", is not auto-given an org, and cannot create one', async () => {
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-stranger', 'wl-stranger@acme.dev')
      const access = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(access.json()).toMatchObject({
        waitlistMode: true,
        status: 'none',
        activated: false,
        orgCount: 0,
        email: 'wl-stranger@acme.dev'
      })

      // GET /orgs must NOT self-heal an org into existence under waitlist mode.
      const orgs = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: h })
      expect(orgs.json()).toEqual([])
      const user = await prisma.user.findUnique({ where: { oidcSubject: 'wl-stranger' } })
      expect(await prisma.membership.count({ where: { userId: user!.id } })).toBe(0)

      // POST /orgs is gated.
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: h,
        payload: { slug: 'wl-stranger-org' }
      })
      expect(create.statusCode).toBe(403)
      expect(create.json()).toMatchObject({ code: 'WAITLIST_NOT_ACTIVATED' })
    } finally {
      await close()
    }
  })

  it('reflects pending after self-join, then approved after the admin mints a link', async () => {
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-join', 'wl-join@acme.dev')
      const joined = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist',
        headers: h,
        payload: {
          name: 'Jordan',
          company: 'Northwind',
          platform: ['slack', 'discord'],
          teamSize: '2–10',
          useCase: 'triage #support'
        }
      })
      expect(joined.statusCode).toBe(200)
      expect(joined.json()).toMatchObject({ status: 'pending' })

      // The optional intake is captured as a JSON note (context for the admin app);
      // the email still comes from the verified identity, never the body.
      const entry = await prisma.waitlistEntry.findUnique({ where: { email: 'wl-join@acme.dev' } })
      expect(entry!.source).toBe('self')
      expect(JSON.parse(entry!.note!)).toMatchObject({
        company: 'Northwind',
        platform: ['slack', 'discord'],
        useCase: 'triage #support'
      })
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).json()).toMatchObject({
        status: 'pending'
      })

      await approveAndMint('wl-join@acme.dev')
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).json()).toMatchObject({
        status: 'approved'
      })
    } finally {
      await close()
    }
  })

  it('rejects an incomplete intake at the API boundary (schema-enforced, not just the form)', async () => {
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-incomplete', 'wl-incomplete@acme.dev')
      // Missing company/teamSize and an empty platform array — the console gates this,
      // and the required-field schema rejects a direct call too.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist',
        headers: h,
        payload: { name: 'Jordan', platform: [] }
      })
      expect(res.statusCode).toBe(400)
      // Nothing was written.
      expect(await prisma.waitlistEntry.findUnique({ where: { email: 'wl-incomplete@acme.dev' } })).toBeNull()
    } finally {
      await close()
    }
  })

  it('checks auth BEFORE body validation — a malformed body from an unauthenticated caller is 503, not 400', async () => {
    const { app, close } = buildHttpApp(prisma) // devAuth, no OIDC
    try {
      // A body that would fail schema validation (bogus platform). Because auth runs in
      // preValidation, the OIDC-unavailable response wins over the schema 400 — so an
      // anonymous caller can't probe the field contract.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist',
        payload: { platform: ['bogus'] }
      })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'OIDC_AUTH_UNAVAILABLE' })
    } finally {
      await close()
    }
  })
})

describe('waitlist admission — POST /waitlist/redeem', () => {
  it('activates the matching user, creates their personal org, and unlocks org creation', async () => {
    const token = await approveAndMint('wl-redeem@acme.dev')
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-redeem', 'wl-redeem@acme.dev')
      // Provision the user first (a stranger who was approved out-of-band).
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })

      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: h,
        payload: { token }
      })
      expect(redeem.statusCode).toBe(200)
      expect(redeem.json()).toEqual({ activated: true })

      const access = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(access.json()).toMatchObject({ status: 'active', activated: true, orgCount: 1 })

      const user = await prisma.user.findUnique({ where: { oidcSubject: 'wl-redeem' } })
      expect(user!.activatedAt).not.toBeNull()
      const link = await linkFor(token)
      expect(link!.redeemedByUserId).toBe(user!.id)
      expect(link!.redeemedAt).not.toBeNull()
      // It was already bound at mint time, so the binding stamp predates the redemption.
      expect(link!.email).toBe('wl-redeem@acme.dev')
      expect(link!.boundAt!.getTime()).toBeLessThanOrEqual(link!.redeemedAt!.getTime())

      // Now org creation is allowed.
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: h,
        payload: { slug: 'wl-redeem-second' }
      })
      expect(create.statusCode).toBe(201)

      // Repeat redeem is idempotent.
      const again = await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: h, payload: { token } })
      expect(again.statusCode).toBe(200)
    } finally {
      await close()
    }
  })

  it('refuses when the signed-in email differs from the link email', async () => {
    const token = await approveAndMint('wl-owner@acme.dev')
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-other', 'wl-other@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: h,
        payload: { token }
      })
      expect(redeem.statusCode).toBe(403)
      expect(redeem.json()).toMatchObject({ code: 'WAITLIST_EMAIL_MISMATCH' })
      expect((redeem.json() as { message: string }).message).toContain('wl-owner@acme.dev')
    } finally {
      await close()
    }
  })

  it('rejects revoked, expired, and malformed links with 410', async () => {
    const { app, close } = buildApp()
    try {
      const revokedToken = await approveAndMint('wl-revoked@acme.dev', { revoked: true })
      const hRevoked = await headers('wl-revoked', 'wl-revoked@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: hRevoked })
      const revoked = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: hRevoked,
        payload: { token: revokedToken }
      })
      expect(revoked.statusCode).toBe(410)
      expect(revoked.json()).toMatchObject({ code: 'WAITLIST_LINK_UNAVAILABLE' })

      const expiredToken = await approveAndMint('wl-expired@acme.dev', { expiresInMs: -1000 })
      const hExpired = await headers('wl-expired', 'wl-expired@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: hExpired })
      const expired = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: hExpired,
        payload: { token: expiredToken }
      })
      expect(expired.statusCode).toBe(410)

      const malformed = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: hExpired,
        payload: { token: 'not-a-real-token' }
      })
      expect(malformed.statusCode).toBe(410)
    } finally {
      await close()
    }
  })
})

describe('waitlist admission — unbound links bind on first use', () => {
  it('activates ANY verified email with no waitlist entry at all, and records the binding', async () => {
    const token = await mintLink(null, { note: 'for a conference demo' })
    const { app, close } = buildApp()
    try {
      const h = await headers('oa-any', 'oa-any@acme.dev')
      // A total stranger: never applied, so there is no entry and status is `none`.
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).json()).toMatchObject({
        status: 'none'
      })
      expect((await linkFor(token))!.email).toBeNull() // unbound until claimed

      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: h,
        payload: { token }
      })
      expect(redeem.statusCode).toBe(200)
      // The response is byte-identical to a bound link's, so it leaks nothing about
      // which kind of link the caller held.
      expect(redeem.json()).toEqual({ activated: true })

      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).json()).toMatchObject({
        status: 'active',
        activated: true,
        orgCount: 1
      })
      // No waitlist entry is invented for them — that's the whole point.
      expect(await prisma.waitlistEntry.findUnique({ where: { email: 'oa-any@acme.dev' } })).toBeNull()

      // The binding is recorded: the link now looks exactly like a born-bound one.
      const user = await prisma.user.findUnique({ where: { oidcSubject: 'oa-any' } })
      const link = await linkFor(token)
      expect(link!.email).toBe('oa-any@acme.dev')
      expect(link!.boundAt).not.toBeNull()
      expect(link!.redeemedByUserId).toBe(user!.id)
      expect(link!.boundAt!.getTime()).toBe(link!.redeemedAt!.getTime())

      // Org creation is unlocked, and a repeat by the same user is idempotent.
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: h,
        payload: { slug: 'oa-any-second' }
      })
      expect(create.statusCode).toBe(201)
      const again = await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: h, payload: { token } })
      expect(again.statusCode).toBe(200)
      // The stamps are the FIRST redemption's, not slid forward by the repeat.
      const after = await linkFor(token)
      expect(after!.redeemedAt!.getTime()).toBe(link!.redeemedAt!.getTime())
      expect(after!.boundAt!.getTime()).toBe(link!.boundAt!.getTime())
    } finally {
      await close()
    }
  })

  it('is single-use — a second account gets 410, and is not told whose link it is', async () => {
    const token = await mintLink(null)
    const { app, close } = buildApp()
    try {
      const first = await headers('oa-first', 'oa-first@acme.dev')
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: first, payload: { token } }))
          .statusCode
      ).toBe(200)

      const second = await headers('oa-second', 'oa-second@acme.dev')
      const reused = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: second,
        payload: { token }
      })
      // 410, NOT the 403 email-mismatch a mint-time-bound link would give: the
      // already-redeemed check runs first, so the first claimer's address is not
      // disclosed to whoever else holds the link.
      expect(reused.statusCode).toBe(410)
      expect(reused.json()).toMatchObject({ code: 'WAITLIST_LINK_UNAVAILABLE' })
      expect((reused.json() as { message: string }).message).not.toContain('oa-first@acme.dev')

      // The loser is left unactivated and org-less.
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: second })).json()).toMatchObject({
        status: 'none',
        activated: false,
        orgCount: 0
      })
      // …and the link still records only the first redeemer.
      expect((await linkFor(token))!.email).toBe('oa-first@acme.dev')
    } finally {
      await close()
    }
  })

  it('rejects revoked and expired unbound links with 410, binding nobody', async () => {
    const { app, close } = buildApp()
    try {
      const revokedToken = await mintLink(null, { revoked: true })
      const hRevoked = await headers('oa-revoked', 'oa-revoked@acme.dev')
      const revoked = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: hRevoked,
        payload: { token: revokedToken }
      })
      expect(revoked.statusCode).toBe(410)
      expect((await linkFor(revokedToken))!.email).toBeNull()

      const expiredToken = await mintLink(null, { expiresInMs: -1000 })
      const hExpired = await headers('oa-expired', 'oa-expired@acme.dev')
      const expired = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: hExpired,
        payload: { token: expiredToken }
      })
      expect(expired.statusCode).toBe(410)
      expect((await linkFor(expiredToken))!.email).toBeNull()

      const user = await prisma.user.findUnique({ where: { oidcSubject: 'oa-expired' } })
      expect(user!.activatedAt).toBeNull()
    } finally {
      await close()
    }
  })

  it('an unminted but well-formed token is 410 (no row ⇒ unavailable)', async () => {
    const { app, close } = buildApp()
    try {
      const h = await headers('oa-forged', 'oa-forged@acme.dev')
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: h,
        payload: { token: codec.mint().token } // never persisted
      })
      expect(res.statusCode).toBe(410)
    } finally {
      await close()
    }
  })

  it('will not let an unbound link override an explicit rejection', async () => {
    // Handing a blank link to someone the admin already rejected must not admit them:
    // the entry is only an application record now, but a `rejected` one still wins.
    await prisma.waitlistEntry.create({ data: { email: 'oa-rejected@acme.dev', status: 'rejected', source: 'self' } })
    const token = await mintLink(null)
    const { app, close } = buildApp()
    try {
      const h = await headers('oa-rejected', 'oa-rejected@acme.dev')
      const res = await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: h, payload: { token } })
      expect(res.statusCode).toBe(410)
      // Neither bound nor consumed — the link is still usable by someone eligible.
      const link = await linkFor(token)
      expect(link!.email).toBeNull()
      expect(link!.redeemedByUserId).toBeNull()
    } finally {
      await close()
    }
  })
})

describe('waitlist admission — auth boundaries', () => {
  it('an invited member passes the gate but still cannot create an org until activated', async () => {
    // Provision + add to the seeded org, without activating.
    const invited = await new PgUserRepo(prisma, false).provisionOidcUser({
      oidcSubject: 'wl-invited',
      email: 'wl-invited@acme.dev',
      emailVerified: true
    })
    await new PgUserRepo(prisma, false).addMember(DEFAULT_ORG_ID, invited.userId, 'collaborator')
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-invited', 'wl-invited@acme.dev')
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).json()).toMatchObject({
        status: 'active',
        activated: false,
        orgCount: 1
      })
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: h,
        payload: { slug: 'wl-invited-org' }
      })
      expect(create.statusCode).toBe(403)
      expect(create.json()).toMatchObject({ code: 'WAITLIST_NOT_ACTIVATED' })
    } finally {
      await close()
    }
  })

  it('POST /waitlist and /waitlist/redeem require real OIDC (not devAuth)', async () => {
    const { app, close } = buildHttpApp(prisma) // devAuth, no OIDC
    try {
      const join = await app.inject({ method: 'POST', url: '/api/v1/waitlist', payload: {} })
      expect(join.statusCode).toBe(503)
      expect(join.json()).toMatchObject({ code: 'OIDC_AUTH_UNAVAILABLE' })
      const redeem = await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', payload: { token: 'x' } })
      expect(redeem.statusCode).toBe(503)
    } finally {
      await close()
    }
  })

  it('/me/access reads the email from persistence, ignoring x-ac-user-email', async () => {
    const { app, close } = buildApp()
    try {
      // Bearer has NO email claim; the header is a spoof attempt. The user was
      // provisioned with a synthetic placeholder, so email must be null (not the header).
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/access',
        headers: { ...(await headers('wl-noemail')), 'x-ac-user-email': 'victim@acme.dev' }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ email: null, status: 'none' })
    } finally {
      await close()
    }
  })
})
