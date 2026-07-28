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
      const entry = await prisma.waitlistEntry.findUnique({ where: { email: 'wl-redeem@acme.dev' } })
      expect(entry!.redeemedByUserId).toBe(user!.id)
      expect(entry!.redeemedAt).not.toBeNull()

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

  it('activates even when every preferred personal-org slug is taken', async () => {
    // Regression: the redeem transaction allocated the slug by INSERTing and catching
    // the unique violation. In Postgres a failed statement aborts the WHOLE
    // transaction, so the retry died with 25P02 and the redeem answered 500.
    for (const slug of ['taken', 'taken-2', 'taken-3']) await prisma.org.create({ data: { slug } })
    const { token } = await mintOpenLink()
    const { app, close } = buildApp()
    try {
      const h = await headers('wl-slug-clash', 'taken@acme.dev') // base label → 'taken'
      await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/waitlist/redeem',
        headers: h,
        payload: { token }
      })
      expect(redeem.statusCode).toBe(200)
      const access = await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })
      expect(access.json()).toMatchObject({ status: 'active', activated: true, orgCount: 1 })
    } finally {
      await close()
    }
  })

  it('activates concurrent redeemers competing for the SAME personal-org slug', async () => {
    // Regression: allocating the slug by INSERT-and-catch (or by read-then-insert)
    // loses this race — the loser's failed statement aborts its redeem transaction and
    // the route answers 500. All three share the email local-part, so they derive the
    // same base slug and must be handed distinct ones.
    const links = await Promise.all([mintOpenLink(), mintOpenLink(), mintOpenLink()])
    const identities = [
      ['wl-race-a', 'dup@a.example'],
      ['wl-race-b', 'dup@b.example'],
      ['wl-race-c', 'dup@c.example']
    ] as const
    const { app, close } = buildApp()
    try {
      const hdrs = await Promise.all(identities.map(([sub, email]) => headers(sub, email)))
      for (const h of hdrs) await app.inject({ method: 'GET', url: '/api/v1/me/access', headers: h })

      const results = await Promise.all(
        hdrs.map((h, i) =>
          app.inject({
            method: 'POST',
            url: '/api/v1/waitlist/redeem',
            headers: h,
            payload: { token: links[i]!.token }
          })
        )
      )
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200])

      // Each ends up owning exactly one org, and the slugs are distinct.
      const slugs: string[] = []
      for (const [sub] of identities) {
        const user = await prisma.user.findUnique({ where: { oidcSubject: sub } })
        const owned = await prisma.membership.findMany({
          where: { userId: user!.id, role: 'owner' },
          select: { org: { select: { slug: true } } }
        })
        expect(owned).toHaveLength(1)
        slugs.push(owned[0]!.org.slug)
      }
      expect(new Set(slugs).size).toBe(3)
      expect([...slugs].sort()).toEqual(['dup', 'dup-2', 'dup-3'])
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
