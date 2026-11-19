/** A suspended membership stays in the table and reads as absent to every check that asks who is a member. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { OrgMembershipMissing } from '../../src/persistence/errors.js'
import { lockResourceWriteMemberships } from '../../src/persistence/resource-membership-lock.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgWaitlistRepo } from '../../src/persistence/repositories/waitlist.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const users = () => new PgUserRepo(prisma)

async function member(label: string, role: 'owner' | 'collaborator' | 'viewer'): Promise<string> {
  const suffix = randomUUID()
  const email = `${label}-${suffix}@acme.dev`
  const { userId } = await users().provisionOidcUser({ oidcSubject: `${label}-${suffix}`, email, emailVerified: true })
  await users().addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

const suspend = (userId: string) =>
  prisma.membership.update({
    where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId } },
    data: { suspendedAt: new Date(), suspendedBy: 'manual' }
  })
const restore = (userId: string) =>
  prisma.membership.update({
    where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId } },
    data: { suspendedAt: null, suspendedBy: null }
  })

/** The console API as this user sees it. */
async function as<T>(userId: string, run: (app: ReturnType<typeof buildHttpApp>['app']) => Promise<T>): Promise<T> {
  const { app, close } = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  try {
    return await run(app)
  } finally {
    await close()
  }
}

describe('a suspended membership', () => {
  it('closes the organization to the member, leaves their other organizations open, and opens again when lifted', async () => {
    const dana = await member('dana', 'collaborator')
    const other = await new PgOrgRepo(prisma).create({
      name: null,
      slug: `other-${randomUUID().slice(0, 8)}`,
      ownerUserId: dana
    })
    await suspend(dana)

    await as(dana, async (app) => {
      expect((await app.inject({ method: 'GET', url: `${ORG}/agents` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `${ORG}/members` })).statusCode).toBe(404)
      const listed = (await app.inject({ method: 'GET', url: '/api/v1/orgs' })).json() as { id: string }[]
      expect(listed.map((org) => org.id)).toEqual([other.id])
    })
    expect(await new PgOrgRepo(prisma).roleOf(DEFAULT_ORG_ID, dana)).toBeNull()

    await restore(dana)
    await as(dana, async (app) => {
      expect((await app.inject({ method: 'GET', url: `${ORG}/agents` })).statusCode).toBe(200)
    })
  })

  it('is left out of the member list and the member count', async () => {
    const dana = await member('dana', 'collaborator')
    await member('erin', 'viewer')
    await suspend(dana)

    await as(DEFAULT_OWNER_ID, async (app) => {
      const members = (await app.inject({ method: 'GET', url: `${ORG}/members` })).json() as { userId: string }[]
      expect(members.map((m) => m.userId)).not.toContain(dana)
      expect(members).toHaveLength(2)
      const orgs = (await app.inject({ method: 'GET', url: '/api/v1/orgs' })).json() as {
        id: string
        memberCount: number
      }[]
      expect(orgs.find((org) => org.id === DEFAULT_ORG_ID)?.memberCount).toBe(2)
    })
  })

  it('does not count as the owner an organization must keep', async () => {
    const erin = await member('erin', 'owner')
    await suspend(erin)

    await as(DEFAULT_OWNER_ID, async (app) => {
      // The seeded owner is the only active one, so it can neither step down nor leave.
      const demote = await app.inject({
        method: 'PATCH',
        url: `${ORG}/members/${DEFAULT_OWNER_ID}`,
        payload: { role: 'viewer' }
      })
      expect(demote.statusCode).toBe(409)
      expect((await app.inject({ method: 'DELETE', url: `${ORG}/members/${DEFAULT_OWNER_ID}` })).statusCode).toBe(409)

      // Demoting the suspended owner leaves an active one, so it is allowed.
      const other = await app.inject({ method: 'PATCH', url: `${ORG}/members/${erin}`, payload: { role: 'viewer' } })
      expect(other.statusCode).toBe(200)
    })
  })

  it('can be removed by an owner, and cannot act as one', async () => {
    const erin = await member('erin', 'owner')
    const dana = await member('dana', 'collaborator')
    await suspend(erin)
    await suspend(dana)

    await expect(users().removeMember(DEFAULT_ORG_ID, dana, erin)).rejects.toBeInstanceOf(OrgMembershipMissing)
    await expect(users().setMemberRole(DEFAULT_ORG_ID, dana, 'viewer', erin)).rejects.toBeInstanceOf(
      OrgMembershipMissing
    )

    await as(DEFAULT_OWNER_ID, async (app) => {
      const removed = await app.inject({ method: 'DELETE', url: `${ORG}/members/${dana}` })
      expect(removed.statusCode).toBeLessThan(300)
    })
    expect(
      await prisma.membership.findUnique({ where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: dana } } })
    ).toBeNull()
  })

  it('keeps its place in a Selected audience and may not write', async () => {
    const dana = await member('dana', 'collaborator')
    await suspend(dana)

    const kept = await prisma.$transaction((tx) =>
      lockResourceWriteMemberships(tx, {
        orgId: DEFAULT_ORG_ID,
        visibility: 'restricted',
        actorUserId: DEFAULT_OWNER_ID,
        sharedWith: [dana]
      })
    )
    expect(kept.sharedWith).toEqual([dana])

    await expect(
      prisma.$transaction((tx) =>
        lockResourceWriteMemberships(tx, { orgId: DEFAULT_ORG_ID, visibility: 'org', actorUserId: dana })
      )
    ).rejects.toBeInstanceOf(OrgMembershipMissing)
  })

  it('does not admit its account past the waitlist', async () => {
    const dana = await member('dana', 'collaborator')
    const waitlist = new PgWaitlistRepo(prisma)
    expect((await waitlist.accessState(dana)).orgCount).toBe(1)
    await suspend(dana)
    expect((await waitlist.accessState(dana)).orgCount).toBe(0)
  })

  it('disconnects the member’s code-host connection, and lifting it does not reconnect', async () => {
    const dana = await member('dana', 'collaborator')
    const connect = async (userId: string, gitlabUserId: bigint) => {
      const row = await prisma.gitlabConnection.create({
        data: { orgId: DEFAULT_ORG_ID, userId, gitlabUserId, gitlabUsername: `u${gitlabUserId}`, state: 'connected' }
      })
      await prisma.gitlabConnectionSecret.create({
        data: { connectionId: row.id, accessToken: 'sealed-access', refreshToken: 'sealed-refresh' }
      })
      return row.id
    }
    const state = async (id: string) => {
      const row = await prisma.gitlabConnection.findUniqueOrThrow({ where: { id }, include: { secret: true } })
      return { state: row.state, tokenVersion: row.tokenVersion, sealed: row.secret !== null }
    }
    const danas = await connect(dana, 7001n)
    const owners = await connect(DEFAULT_OWNER_ID, 7002n)

    // A change that is not a suspension leaves the connection alone.
    await users().setMemberRole(DEFAULT_ORG_ID, dana, 'viewer', DEFAULT_OWNER_ID)
    expect(await state(danas)).toEqual({ state: 'connected', tokenVersion: 1n, sealed: true })

    await suspend(dana)
    expect(await state(danas)).toEqual({ state: 'disconnected', tokenVersion: 2n, sealed: false })
    expect(await state(owners)).toEqual({ state: 'connected', tokenVersion: 1n, sealed: true })

    await restore(dana)
    expect(await state(danas)).toEqual({ state: 'disconnected', tokenVersion: 2n, sealed: false })
  })
})
