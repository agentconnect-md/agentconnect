/**
 * `/members` — the active org's member management (§3.2).
 *
 * Under the devAuth stub the principal is the seeded owner of the default org
 * (role `owner`), so the owner-gated paths are exercised directly. Members are
 * added by email (`POST /members` — no email infra; unknown addresses become
 * invited rows claimed at first SSO sign-in), re-roled (`PATCH`), and removed
 * (`DELETE`), with the last-owner guard keeping the org from orphaning itself.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
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

async function makeOwner(label: string): Promise<string> {
  const suffix = randomUUID()
  const email = `${label}-${suffix}@acme.dev`
  const { userId } = await signup(`${label}-${suffix}`, email)
  await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, 'owner')
  return userId
}

async function holdOwnerTransitions(): Promise<{ release(): void; blocker: Promise<void> }> {
  let releaseLock!: () => void
  let markLocked!: () => void
  const release = new Promise<void>((resolve) => (releaseLock = resolve))
  const locked = new Promise<void>((resolve) => (markLocked = resolve))
  const blocker = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "org"
        WHERE "id" = ${DEFAULT_ORG_ID}
        FOR UPDATE
      `
      markLocked()
      await release
    },
    { timeout: 20_000 }
  )
  await locked

  let released = false
  return {
    release() {
      if (released) return
      released = true
      releaseLock()
    },
    blocker
  }
}

async function waitingLocks(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
    SELECT count(*)::bigint AS "waiting"
    FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
  `
  return Number(rows[0]?.waiting ?? 0n)
}

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

describe('concurrent owner transitions', () => {
  it('allows only one of two owners to leave and transfers both resources to the survivor', async () => {
    const otherOwnerId = await makeOwner('concurrent-leave')
    const firstAgentId = randomUUID()
    const secondAgentId = randomUUID()
    await seedAgent(prisma, firstAgentId, {
      createdByUserId: DEFAULT_OWNER_ID,
      ownerUserId: DEFAULT_OWNER_ID
    })
    await seedAgent(prisma, secondAgentId, {
      createdByUserId: otherOwnerId,
      ownerUserId: otherOwnerId
    })
    const firstApp = buildHttpApp(prisma)
    const secondApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: otherOwnerId })
    const transitionBlocker = await holdOwnerTransitions()
    const pending: Promise<unknown>[] = []

    try {
      const firstLeave = firstApp.app.inject({
        method: 'DELETE',
        url: `${ORG}/members/${DEFAULT_OWNER_ID}`
      })
      const secondLeave = secondApp.app.inject({
        method: 'DELETE',
        url: `${ORG}/members/${otherOwnerId}`
      })
      pending.push(firstLeave, secondLeave)
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(2), { timeout: 5_000 })

      transitionBlocker.release()
      const responses = await Promise.all([firstLeave, secondLeave])
      expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 409])

      const members = await prisma.membership.findMany({ where: { orgId: DEFAULT_ORG_ID } })
      expect(members).toHaveLength(1)
      expect(members[0]!.role).toBe('owner')
      const resources = await prisma.agent.findMany({
        where: { id: { in: [firstAgentId, secondAgentId] } },
        select: { ownerUserId: true }
      })
      expect(resources).toHaveLength(2)
      expect(resources.every((resource) => resource.ownerUserId === members[0]!.userId)).toBe(true)
    } finally {
      transitionBlocker.release()
      await Promise.allSettled([transitionBlocker.blocker, ...pending])
      await Promise.all([firstApp.close(), secondApp.close()])
    }
  })

  it('allows only one of two owners to demote themselves', async () => {
    const otherOwnerId = await makeOwner('concurrent-demote')
    const firstApp = buildHttpApp(prisma)
    const secondApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: otherOwnerId })
    const transitionBlocker = await holdOwnerTransitions()
    const pending: Promise<unknown>[] = []

    try {
      const firstDemote = firstApp.app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${DEFAULT_OWNER_ID}`,
        payload: { role: 'viewer' }
      })
      const secondDemote = secondApp.app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${otherOwnerId}`,
        payload: { role: 'viewer' }
      })
      pending.push(firstDemote, secondDemote)
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(2), { timeout: 5_000 })

      transitionBlocker.release()
      const responses = await Promise.all([firstDemote, secondDemote])
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])

      const members = await prisma.membership.findMany({
        where: { orgId: DEFAULT_ORG_ID },
        orderBy: { userId: 'asc' }
      })
      expect(members.map((member) => member.role).sort()).toEqual(['owner', 'viewer'])
    } finally {
      transitionBlocker.release()
      await Promise.allSettled([transitionBlocker.blocker, ...pending])
      await Promise.all([firstApp.close(), secondApp.close()])
    }
  })

  it('keeps the transfer recipient owned when leave races with demotion', async () => {
    const otherOwnerId = await makeOwner('leave-demote')
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      createdByUserId: DEFAULT_OWNER_ID,
      ownerUserId: DEFAULT_OWNER_ID
    })
    const leavingApp = buildHttpApp(prisma)
    const demotingApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: otherOwnerId })
    const transitionBlocker = await holdOwnerTransitions()
    const pending: Promise<unknown>[] = []

    try {
      const leave = leavingApp.app.inject({
        method: 'DELETE',
        url: `${ORG}/members/${DEFAULT_OWNER_ID}`
      })
      const demote = demotingApp.app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${otherOwnerId}`,
        payload: { role: 'viewer' }
      })
      pending.push(leave, demote)
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(2), { timeout: 5_000 })

      transitionBlocker.release()
      const responses = await Promise.all([leave, demote])
      const statuses = responses.map((response) => response.statusCode)
      expect(statuses.filter((status) => status === 409)).toHaveLength(1)
      expect(statuses.some((status) => status === 200 || status === 204)).toBe(true)

      const owners = await prisma.membership.findMany({
        where: { orgId: DEFAULT_ORG_ID, role: 'owner' },
        select: { userId: true }
      })
      expect(owners).toHaveLength(1)
      expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).ownerUserId).toBe(owners[0]!.userId)
    } finally {
      transitionBlocker.release()
      await Promise.allSettled([transitionBlocker.blocker, ...pending])
      await Promise.all([leavingApp.close(), demotingApp.close()])
    }
  })
})
