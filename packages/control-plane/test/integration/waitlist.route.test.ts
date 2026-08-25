import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { WaitlistJoinTokenCodec } from '../../src/registry/waitlistJoinToken.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const OIDC_AUDIENCE = 'waitlist-test'
const codec = new WaitlistJoinTokenCodec(TEST_API_KEY_PEPPER)

let oidcServer: Server
let oidcIssuer = ''
/** `issuedAt` (epoch seconds) overrides the `iat` claim — lets a test mint a token
 *  that is demonstrably NEWER than an event, without sleeping a whole second. */
let mintBearer: (subject: string, email?: string, issuedAt?: number) => Promise<string>

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
  mintBearer = (subject, email, issuedAt) => {
    const claims: Record<string, unknown> = {}
    if (email) claims.email = email
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'waitlist-test' })
      .setIssuer(oidcIssuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
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
const headers = async (subject: string, email?: string, issuedAt?: number) => ({
  authorization: `Bearer ${await mintBearer(subject, email, issuedAt)}`
})

/** Simulate the external admin app approving an email + minting its join link. */
async function approveAndMint(email: string, opts: { expiresInMs?: number; revoked?: boolean } = {}) {
  const minted = codec.mint()
  const now = Date.now()
  await prisma.waitlistEntry.upsert({
    where: { email },
    create: {
      email,
      status: 'approved',
      source: 'admin',
      tokenHash: minted.hash,
      displayTail: minted.displayTail,
      joinExpiresAt: new Date(now + (opts.expiresInMs ?? 30 * 24 * 3600 * 1000)),
      revokedAt: opts.revoked ? new Date(now - 1) : null
    },
    update: {
      status: 'approved',
      tokenHash: minted.hash,
      displayTail: minted.displayTail,
      joinExpiresAt: new Date(now + (opts.expiresInMs ?? 30 * 24 * 3600 * 1000)),
      revokedAt: opts.revoked ? new Date(now - 1) : null
    }
  })
  return minted.token
}

/** Simulate the admin app minting a BEARER link — an approved entry with NO email,
 *  redeemable once by any verified identity. Returns the plaintext token + its hash
 *  (the row has no email to look it up by). */
async function mintOpenLink(opts: { expiresInMs?: number; revoked?: boolean } = {}) {
  const minted = codec.mint()
  const now = Date.now()
  await prisma.waitlistEntry.create({
    data: {
      status: 'approved',
      source: 'admin',
      tokenHash: minted.hash,
      displayTail: minted.displayTail,
      joinExpiresAt: new Date(now + (opts.expiresInMs ?? 30 * 24 * 3600 * 1000)),
      revokedAt: opts.revoked ? new Date(now - 1) : null
    }
  })
  return { token: minted.token, tokenHash: minted.hash }
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

      // Nothing conjures an org for them — the list is simply empty.
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
  it('activates the matching user, grants no org, and still enforces the org quota', async () => {
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

      // Activation grants ADMISSION, not an organization — they create their own
      // from org onboarding, like any other new account.
      const access = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(access.json()).toMatchObject({ status: 'active', activated: true, orgCount: 0 })

      const user = await prisma.user.findUnique({ where: { oidcSubject: 'wl-redeem' } })
      expect(user!.activatedAt).not.toBeNull()
      const entry = await prisma.waitlistEntry.findUnique({ where: { email: 'wl-redeem@acme.dev' } })
      expect(entry!.redeemedByUserId).toBe(user!.id)
      expect(entry!.redeemedAt).not.toBeNull()

      // The org they create themselves consumes the default quota of one.
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: h,
        payload: { slug: 'wl-redeem-first' }
      })
      expect(first.statusCode).toBe(201)
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: h,
        payload: { slug: 'wl-redeem-second' }
      })
      expect(create.statusCode).toBe(403)
      expect(create.json()).toMatchObject({ code: 'ORG_CREATION_LIMIT_REACHED' })

      // Repeat redeem is idempotent.
      const again = await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: h, payload: { token } })
      expect(again.statusCode).toBe(200)
    } finally {
      await close()
    }
  })

  it('a bearer link (no email) activates any verified identity and records the redeemer', async () => {
    const { token, tokenHash } = await mintOpenLink()
    const { app, close } = buildApp()
    try {
      // Any verified email — the link was minted with no email to bind.
      const h = await headers('wl-bearer', 'whoever@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })

      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: h,
        payload: { token }
      })
      expect(redeem.statusCode).toBe(200)
      expect(redeem.json()).toEqual({ activated: true })

      const user = await prisma.user.findUnique({ where: { oidcSubject: 'wl-bearer' } })
      expect(user!.activatedAt).not.toBeNull()
      const entry = await prisma.waitlistEntry.findUnique({ where: { tokenHash } })
      expect(entry!.email).toBeNull() // stays a bearer row
      expect(entry!.redeemedByUserId).toBe(user!.id)
      expect(entry!.redeemedEmail).toBe('whoever@acme.dev') // redeemer recorded for audit

      // Idempotent for the SAME user.
      const again = await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: h, payload: { token } })
      expect(again.statusCode).toBe(200)
    } finally {
      await close()
    }
  })

  it('refuses to redeem as an identity the client did not mean (expectSubject)', async () => {
    const { token, tokenHash } = await mintOpenLink()
    const { app, close } = buildApp()
    try {
      // The browser prepared the flow as `wl-expected`, but by the time the request
      // goes out another tab has swapped the session to `wl-swapped`. A bearer link
      // takes any verified identity, so without the assertion this would silently
      // activate the WRONG account.
      const swapped = await headers('wl-swapped', 'swapped@acme.dev')
      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: swapped,
        payload: { token, expectSubject: 'wl-expected' }
      })
      expect(redeem.statusCode).toBe(409)
      expect(redeem.json()).toMatchObject({ code: 'IDENTITY_CHANGED' })
      // Nothing was activated and the one-use link was not consumed.
      expect(await prisma.user.findUnique({ where: { oidcSubject: 'wl-swapped' } })).toMatchObject({
        activatedAt: null
      })
      expect((await prisma.waitlistEntry.findUnique({ where: { tokenHash } }))!.redeemedByUserId).toBeNull()

      // The same request with the identity it actually holds goes through.
      const ok = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: swapped,
        payload: { token, expectSubject: 'wl-swapped' }
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toEqual({ activated: true })
    } finally {
      await close()
    }
  })

  it('a bearer link is one-use — a second, different user is refused', async () => {
    const { token } = await mintOpenLink()
    const { app, close } = buildApp()
    try {
      const first = await headers('wl-bearer-first', 'first@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: first })
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: first, payload: { token } }))
          .statusCode
      ).toBe(200)

      // A different identity now finds the link already consumed → 410.
      const second = await headers('wl-bearer-second', 'second@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: second })
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: second,
        payload: { token }
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'WAITLIST_LINK_UNAVAILABLE' })
    } finally {
      await close()
    }
  })

  it('an already-activated account does NOT consume a bearer link — it stays available', async () => {
    const boundToken = await approveAndMint('wl-already@acme.dev')
    const { token: bearerToken, tokenHash } = await mintOpenLink()
    const { app, close } = buildApp()
    try {
      const redeem = (token: string, hdrs: Record<string, string>) =>
        app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: hdrs, payload: { token } })

      // Activate this user through their OWN bound link first.
      const h = await headers('wl-already', 'wl-already@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect((await redeem(boundToken, h)).statusCode).toBe(200)

      // They now open someone else's bearer link: admitted (already in), link untouched.
      expect((await redeem(bearerToken, h)).statusCode).toBe(200)
      const untouched = await prisma.waitlistEntry.findUnique({ where: { tokenHash } })
      expect(untouched!.redeemedByUserId).toBeNull()
      expect(untouched!.redeemedAt).toBeNull()
      expect(untouched!.redeemedEmail).toBeNull()

      // So a user who actually needs it can still redeem it.
      const fresh = await headers('wl-already-fresh', 'fresh@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: fresh })
      expect((await redeem(bearerToken, fresh)).statusCode).toBe(200)
      const freshUser = await prisma.user.findUnique({ where: { oidcSubject: 'wl-already-fresh' } })
      const consumed = await prisma.waitlistEntry.findUnique({ where: { tokenHash } })
      expect(consumed!.redeemedByUserId).toBe(freshUser!.id)
      expect(consumed!.redeemedEmail).toBe('fresh@acme.dev')
    } finally {
      await close()
    }
  })

  it('same-user retry stays 200 even after the link later expires or is revoked (bound + bearer)', async () => {
    const boundToken = await approveAndMint('wl-retry@acme.dev')
    const { app, close } = buildApp()
    try {
      // ── bound link ──
      const h = await headers('wl-retry', 'wl-retry@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      const redeem = (token: string, hdrs: Record<string, string>) =>
        app.inject({ method: 'POST', url: '/api/v1/waitlist/redeem', headers: hdrs, payload: { token } })

      expect((await redeem(boundToken, h)).statusCode).toBe(200)
      // Expiring the link AFTER redemption must not break the same user's retry.
      await prisma.waitlistEntry.update({
        where: { email: 'wl-retry@acme.dev' },
        data: { joinExpiresAt: new Date(Date.now() - 1000) }
      })
      expect((await redeem(boundToken, h)).statusCode).toBe(200)
      // Nor must a post-redemption revoke.
      await prisma.waitlistEntry.update({ where: { email: 'wl-retry@acme.dev' }, data: { revokedAt: new Date() } })
      expect((await redeem(boundToken, h)).statusCode).toBe(200)

      // ── bearer link ──
      const { token: bearerToken, tokenHash } = await mintOpenLink()
      const hb = await headers('wl-retry-bearer', 'rb@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: hb })
      expect((await redeem(bearerToken, hb)).statusCode).toBe(200)
      await prisma.waitlistEntry.update({ where: { tokenHash }, data: { revokedAt: new Date() } })
      expect((await redeem(bearerToken, hb)).statusCode).toBe(200) // same user, still ok

      // A DIFFERENT user hitting the now-revoked bearer link is refused.
      const other = await headers('wl-retry-other', 'other@acme.dev')
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: other })
      expect((await redeem(bearerToken, other)).statusCode).toBe(410)
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

describe('waitlist admission — auth boundaries', () => {
  it('an invited member passes the gate but still cannot create an org until activated', async () => {
    // Provision + add to the seeded org, without activating.
    const invited = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'wl-invited',
      email: 'wl-invited@acme.dev',
      emailVerified: true
    })
    await new PgUserRepo(prisma).addMember(DEFAULT_ORG_ID, invited.userId, 'collaborator')
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

  it('keeps rejecting a deleted account with ACCOUNT_GONE — the same bearer cannot recreate it', async () => {
    const { app, close } = buildApp()
    const email = 'wl-deleted@acme.dev'
    try {
      const h = await headers('wl-deleted', email)
      // First call provisions the user AND memoizes sub → userId inside the auth plane.
      const before = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(before.statusCode).toBe(200)
      expect(before.json()).toMatchObject({ email })

      // The external admin app deletes the account under the live session.
      await prisma.user.delete({ where: { email } })

      // Same (still valid) bearer, same process, same memo: the plane must notice the
      // row is gone and tell the client to sign out — never serve a dangling identity.
      const after = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(after.statusCode).toBe(401)
      expect(after.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull()

      // …and it must KEEP rejecting it. A retry (or a parallel console poll) with the
      // same authentication must not fall through to JIT provisioning and resurrect
      // the account the admin just removed.
      for (let i = 0; i < 3; i++) {
        const retry = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
        expect(retry.statusCode).toBe(401)
        expect(retry.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
      }
      // Not even a different route / a write may provision behind the rejection.
      const join = await app.inject({ method: 'POST', url: '/api/v1/waitlist', headers: h, payload: {} })
      expect(join.statusCode).toBe(401)
      expect(join.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull()

      // Only a demonstrably NEW authentication (a token issued after the deletion)
      // signs up again — as the new account it is, with nothing inherited.
      const fresh = await headers('wl-deleted', email, Math.floor(Date.now() / 1000) + 5)
      const reSignIn = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: fresh })
      expect(reSignIn.statusCode).toBe(200)
      expect(reSignIn.json()).toMatchObject({ email, activated: false, orgCount: 0 })

      // Admitting that newer token must NOT revive the old one: replaying the
      // pre-deletion bearer against the replacement row keeps the ended session
      // ended (the cutoff is retained, not cleared).
      const replay = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(replay.statusCode).toBe(401)
      expect(replay.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
      // …while the new authentication keeps working.
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: fresh })).statusCode).toBe(200)
    } finally {
      await close()
    }
  })

  it('the deletion itself records the boundary — no CP need be running to observe it', async () => {
    const email = 'wl-unobserved@acme.dev'
    const h = await headers('wl-unobserved', email)

    // Process 1 provisions the account, then goes away entirely.
    const first = buildApp()
    try {
      expect((await first.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).statusCode).toBe(200)
    } finally {
      await first.close()
    }

    // The admin deletes the account with NOTHING running — no request ever sees it,
    // so the auth plane cannot be the one to record the boundary. The trigger is.
    await prisma.user.delete({ where: { email } })
    expect(await prisma.deletedIdentityCutoff.findUnique({ where: { oidcSubject: 'wl-unobserved' } })).not.toBeNull()

    const second = buildApp()
    try {
      // A fresh process, an unknown subject, and a still-valid pre-deletion bearer:
      // this is the ordering that must NOT hand out a replacement account.
      const replay = await second.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(replay.statusCode).toBe(401)
      expect(replay.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull()

      // A genuine new sign-in is still allowed — this is a boundary, not a ban.
      const fresh = await headers('wl-unobserved', email, Math.floor(Date.now() / 1000) + 5)
      expect((await second.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: fresh })).statusCode).toBe(
        200
      )
    } finally {
      await second.close()
    }
  })

  it('an unclaimed invited row being merged away does NOT fence anyone', async () => {
    // upgradeSyntheticEmail deletes the invited (oidcSubject-less) row when a real
    // verified email arrives for a user holding a placeholder. That deletion must not
    // write a cutoff — there is no identity behind it, and fencing the wrong subject
    // would lock out the very person claiming the invite.
    const repo = new PgUserRepo(prisma)
    const invited = await prisma.user.create({ data: { email: 'wl-merge@acme.dev' } }) // no oidcSubject
    await repo.provisionOidcUser({ oidcSubject: 'wl-merge', emailVerified: false }) // synthetic placeholder
    await repo.provisionOidcUser({ oidcSubject: 'wl-merge', email: 'wl-merge@acme.dev', emailVerified: true })

    expect(await prisma.user.findUnique({ where: { id: invited.id } })).toBeNull() // merged away
    expect(await prisma.deletedIdentityCutoff.count()).toBe(0)
    const { app, close } = buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/access',
        headers: await headers('wl-merge', 'wl-merge@acme.dev')
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ email: 'wl-merge@acme.dev' })
    } finally {
      await close()
    }
  })

  it('the deletion boundary survives a CP restart — a pre-deletion bearer cannot re-provision', async () => {
    const email = 'wl-restart@acme.dev'
    const h = await headers('wl-restart', email)

    // ── process 1: the account exists, then an admin deletes it under the session ──
    const first = buildApp()
    try {
      expect((await first.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).statusCode).toBe(200)
      await prisma.user.delete({ where: { email } })
      const rejected = await first.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(rejected.statusCode).toBe(401)
      expect(rejected.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
    } finally {
      await first.close()
    }

    // ── process 2: same database, empty in-memory state (a deploy / crash restart) ──
    // The still-valid pre-deletion bearer must NOT read as a never-seen subject and
    // get JIT-provisioned a replacement account.
    const second = buildApp()
    try {
      const afterRestart = await second.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(afterRestart.statusCode).toBe(401)
      expect(afterRestart.json()).toMatchObject({ code: 'ACCOUNT_GONE' })
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull()

      // A real new sign-in still works, in the fresh process too.
      const fresh = await headers('wl-restart', email, Math.floor(Date.now() / 1000) + 5)
      expect((await second.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: fresh })).statusCode).toBe(
        200
      )
      // …and even then the old bearer stays out.
      expect((await second.app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })).statusCode).toBe(401)
    } finally {
      await second.close()
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
