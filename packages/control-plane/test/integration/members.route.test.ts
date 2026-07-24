/**
 * `/members` — the active org's member management (§3.2).
 *
 * Under the devAuth stub the principal is the seeded owner of the default org
 * (role `owner`), so the owner-gated paths are exercised directly. Members are
 * added by email (`POST /members` — no email infra; unknown addresses become
 * invited rows claimed at first SSO sign-in), re-roled (`PATCH`), and removed
 * (`DELETE`), with the last-owner guard keeping the org from orphaning itself.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID, DEFAULT_OWNER_EMAIL } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

interface MemberBody {
  userId: string
  email: string | null
  name: string | null
  role: string
  joinedAt: string
}

const signup = (oidcSubject: string, email: string) =>
  new PgUserRepo(prisma).provisionOidcUser({ oidcSubject, email, emailVerified: true })

describe('GET /members', () => {
  it('lists the seeded owner plus members added to the default org', async () => {
    const dana = await signup('sub-dana', 'dana@acme.dev')
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, 'dana@acme.dev', 'collaborator')
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/members` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MemberBody[]
      expect(body.map((m) => m.userId)).toEqual([DEFAULT_OWNER_ID, dana.userId])
      expect(body[0]!.role).toBe('owner')
      expect(body[0]!.email).toBe(DEFAULT_OWNER_EMAIL)
      expect(body[1]!.role).toBe('collaborator')
    } finally {
      await close()
    }
  })
})

describe('POST /members — add by email', () => {
  it('creates an invited user row for an unknown email (claimed at first sign-in)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${ORG}/members`,
        payload: { email: 'newhire@acme.dev', role: 'viewer' }
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as MemberBody
      expect(body.email).toBe('newhire@acme.dev')
      expect(body.role).toBe('viewer')
      const user = await prisma.user.findUnique({ where: { email: 'newhire@acme.dev' } })
      expect(user?.oidcSubject).toBeNull() // invited, not signed in yet
    } finally {
      await close()
    }
  })

  it('adds an existing user directly, and 409s when they are already a member', async () => {
    await signup('sub-dana', 'dana@acme.dev')
    const { app, close } = buildHttpApp(prisma)
    try {
      const first = await app.inject({ method: 'POST', url: `${ORG}/members`, payload: { email: 'dana@acme.dev' } })
      expect(first.statusCode).toBe(201)
      expect((first.json() as MemberBody).role).toBe('collaborator') // the default

      const dup = await app.inject({ method: 'POST', url: `${ORG}/members`, payload: { email: 'dana@acme.dev' } })
      expect(dup.statusCode).toBe(409)
    } finally {
      await close()
    }
  })
})

describe('PATCH /members/:id — role changes', () => {
  it('changes a role, including granting owner (multiple owners allowed)', async () => {
    const dana = await signup('sub-dana', 'dana@acme.dev')
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, 'dana@acme.dev', 'collaborator')
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${dana.userId}`,
        payload: { role: 'owner' }
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MemberBody).role).toBe('owner')
      const row = await prisma.membership.findUnique({
        where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: dana.userId } }
      })
      expect(row?.role).toBe('owner')
    } finally {
      await close()
    }
  })

  it('refuses to demote the LAST owner (409), allows it once another owner exists', async () => {
    const dana = await signup('sub-dana', 'dana@acme.dev')
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, 'dana@acme.dev', 'collaborator')
    const { app, close } = buildHttpApp(prisma)
    try {
      const solo = await app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${DEFAULT_OWNER_ID}`,
        payload: { role: 'viewer' }
      })
      expect(solo.statusCode).toBe(409)

      // Promote dana to owner, then demoting the seeded owner is fine.
      await app.inject({ method: 'PATCH', url: `${ORG}/members/${dana.userId}`, payload: { role: 'owner' } })
      const now = await app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${DEFAULT_OWNER_ID}`,
        payload: { role: 'viewer' }
      })
      expect(now.statusCode).toBe(200)
    } finally {
      await close()
    }
  })

  it('404s for a user without a membership in the org', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'PATCH', url: `${ORG}/members/no-such-user`, payload: { role: 'viewer' } })
      expect(res.statusCode).toBe(404)
    } finally {
      await close()
    }
  })
})

describe('DELETE /members/:id — removal', () => {
  it('removes a member for good — the next sign-in does NOT re-add them', async () => {
    const dana = await signup('sub-dana', 'dana@acme.dev')
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, 'dana@acme.dev', 'collaborator')
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: `${ORG}/members/${dana.userId}` })
      expect(res.statusCode).toBe(204)

      // Dana signs in again: JIT provisioning must not resurrect the membership.
      await signup('sub-dana', 'dana@acme.dev')
      const row = await prisma.membership.findUnique({
        where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: dana.userId } }
      })
      expect(row).toBeNull()
    } finally {
      await close()
    }
  })

  it('refuses to remove the last owner (409)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: `${ORG}/members/${DEFAULT_OWNER_ID}` })
      expect(res.statusCode).toBe(409)
    } finally {
      await close()
    }
  })
})
