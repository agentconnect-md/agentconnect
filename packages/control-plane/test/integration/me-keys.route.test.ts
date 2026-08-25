/**
 * `/me/keys` — the caller's own personal API keys (daemon-api-key-auth.md §8).
 *
 * Under the devAuth stub the principal is the seeded owner of the default org, so
 * a request with NO Authorization header acts as that owner. A request carrying
 * `Authorization: Bearer <key>` is instead authenticated as the personal key —
 * which is how these tests prove a minted key is a live credential, is bound to
 * its org, and dies on revoke.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

interface Minted {
  apiKeyId: string
  apiKey: string
  displayTail: string
}
interface KeyRow {
  id: string
  displayTail: string
  name: string | null
  orgId: string
  orgSlug: string
  orgName: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

describe('POST /me/keys — mint a personal key', () => {
  it('mints a user key in the chosen org, returns the plaintext once, and lists it', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        payload: { orgId: DEFAULT_ORG_ID, name: 'ci-runner' }
      })
      expect(res.statusCode).toBe(201)
      const minted = res.json() as Minted
      expect(minted.apiKey.length).toBeGreaterThan(40) // <secret><crc>
      expect(minted.displayTail).toMatch(/^…/)

      // The plaintext is never stored — only its peppered hash.
      const row = await prisma.apiKey.findUnique({ where: { id: minted.apiKeyId } })
      expect(row?.principalType).toBe('user')
      expect(row?.userId).toBe(DEFAULT_OWNER_ID)
      expect(row?.daemonId).toBeNull()
      expect(row?.hash).not.toBe(minted.apiKey)
      expect(row?.expiresAt).not.toBeNull() // user keys expire (default 90d)

      const list = await app.inject({ method: 'GET', url: '/api/v1/me/keys' })
      expect(list.statusCode).toBe(200)
      const keys = list.json() as KeyRow[]
      expect(keys).toHaveLength(1)
      expect(keys[0]!.id).toBe(minted.apiKeyId)
      expect(keys[0]!.name).toBe('ci-runner')
      expect(keys[0]!.orgId).toBe(DEFAULT_ORG_ID)
      expect(keys[0]!.orgSlug).toBe(DEFAULT_ORG_SLUG)
      expect(keys[0]!.revokedAt).toBeNull()
    } finally {
      await close()
    }
  })

  it('rejects an org the caller does not belong to (404)', async () => {
    // A stranger's own org — the seeded owner is not a member.
    const stranger = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'sub-stranger',
      email: 'stranger@example.test',
      emailVerified: true
    })
    const strangerOrg = await new PgOrgRepo(prisma).create({
      name: null,
      slug: 'stranger-org',
      ownerUserId: stranger.userId
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        payload: { orgId: strangerOrg.id }
      })
      expect(res.statusCode).toBe(404)
      // Nothing was minted for the stranger's org.
      const count = await prisma.apiKey.count({ where: { orgId: strangerOrg.id } })
      expect(count).toBe(0)
    } finally {
      await close()
    }
  })

  it('validates the expiry window (1–365 days)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      for (const bad of [0, 366, -5]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/me/keys',
          payload: { orgId: DEFAULT_ORG_ID, expiresInDays: bad }
        })
        expect(res.statusCode).toBe(400)
      }
    } finally {
      await close()
    }
  })

  it('mints a non-expiring key when expiresInDays is null', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        payload: { orgId: DEFAULT_ORG_ID, expiresInDays: null }
      })
      expect(res.statusCode).toBe(201)
      const minted = res.json() as Minted

      // A null TTL persists as a NULL expiry — the key never expires (like daemon keys).
      const row = await prisma.apiKey.findUnique({ where: { id: minted.apiKeyId } })
      expect(row?.expiresAt).toBeNull()

      const list = await app.inject({ method: 'GET', url: '/api/v1/me/keys' })
      const keys = list.json() as KeyRow[]
      expect(keys.find((k) => k.id === minted.apiKeyId)?.expiresAt).toBeNull()
    } finally {
      await close()
    }
  })
})

describe('a minted key is a live REST credential', () => {
  it('authenticates as the owner, but only in the org it is bound to', async () => {
    // A second org the owner ALSO belongs to — the key must still not reach it.
    const otherOrg = await new PgOrgRepo(prisma).create({
      name: null,
      slug: 'owner-second-org',
      ownerUserId: DEFAULT_OWNER_ID
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const minted = (
        await app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
      ).json() as Minted

      // Identity route: the key resolves to the owner.
      const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(minted.apiKey) })
      expect(me.statusCode).toBe(200)
      expect((me.json() as { userId: string }).userId).toBe(DEFAULT_OWNER_ID)

      // Org-scoped route in the KEY'S org → allowed.
      const inOrg = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        headers: bearer(minted.apiKey)
      })
      expect(inOrg.statusCode).toBe(200)

      // Same owner, DIFFERENT org → the key is bound to its org, so 404.
      const otherOrgRes = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${otherOrg.id}/agents`,
        headers: bearer(minted.apiKey)
      })
      expect(otherOrgRes.statusCode).toBe(404)
    } finally {
      await close()
    }
  })

  it('cannot be used to mint more keys (no self-propagation)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const minted = (
        await app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
      ).json() as Minted
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        headers: bearer(minted.apiKey),
        payload: { orgId: DEFAULT_ORG_ID }
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await close()
    }
  })

  it('rejects a malformed bearer key (401)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        headers: bearer('not-a-real-key-000000')
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await close()
    }
  })
})

describe('DELETE /me/keys/:id — revoke', () => {
  it('revokes the caller’s own key and the key stops authenticating', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const minted = (
        await app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
      ).json() as Minted

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/me/keys/${minted.apiKeyId}` })
      expect(del.statusCode).toBe(200)
      expect((del.json() as KeyRow).revokedAt).not.toBeNull()

      const list = await app.inject({ method: 'GET', url: '/api/v1/me/keys' })
      expect(list.statusCode).toBe(200)
      expect((list.json() as KeyRow[]).some((k) => k.id === minted.apiKeyId)).toBe(false)

      const again = await app.inject({ method: 'DELETE', url: `/api/v1/me/keys/${minted.apiKeyId}` })
      expect(again.statusCode).toBe(200)
      expect((again.json() as KeyRow).revokedAt).not.toBeNull()

      // The revoked key no longer authenticates.
      const after = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(minted.apiKey) })
      expect(after.statusCode).toBe(401)
    } finally {
      await close()
    }
  })

  it('cannot revoke another user’s key (reads as absent, 404)', async () => {
    // A key owned by someone else — the devAuth owner must not be able to kill it.
    const other = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'sub-other',
      email: 'other@acme.dev',
      emailVerified: true
    })
    const foreign = await prisma.apiKey.create({
      data: {
        principalType: 'user',
        orgId: DEFAULT_ORG_ID,
        userId: other.userId,
        hash: 'foreign-hash-value',
        displayTail: '…zzzz'
      }
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/me/keys/${foreign.id}` })
      expect(res.statusCode).toBe(404)
      const row = await prisma.apiKey.findUnique({ where: { id: foreign.id } })
      expect(row?.revokedAt).toBeNull() // untouched
    } finally {
      await close()
    }
  })

  it('404s on an unknown key id', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/me/keys/does-not-exist' })
      expect(res.statusCode).toBe(404)
    } finally {
      await close()
    }
  })
})
