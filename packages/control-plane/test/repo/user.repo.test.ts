/**
 * PgUserRepo — WebUI identity JIT-provisioned from a verified OIDC `sub` (§3.2).
 *
 * First sight of a subject is SIGNUP: the user row is created (or an invited,
 * email-only row is claimed) and NO organization is created — a fresh account
 * belongs to none until it creates or joins one. Synthetic `<sub>@oidc.local`
 * placeholder emails behave as before
 * (stored when no email is known, upgraded later, never surfaced). Org context
 * is resolved per request via `resolveOrgContext`.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { isSyntheticEmail } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'

const repo = () => new PgUserRepo(prisma)

describe('PgUserRepo.provisionOidcUser — signup creates no organization', () => {
  it('creates the user (real email + display name) and no membership at all', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-real',
      email: 'dana@acme.com',
      emailVerified: true,
      displayName: 'Dana Reyes'
    })
    const u = await prisma.user.findUnique({ where: { id: userId } })
    expect(u?.email).toBe('dana@acme.com')
    expect(u?.displayName).toBe('Dana Reyes')

    expect(await prisma.membership.count({ where: { userId } })).toBe(0)
  })

  it('is idempotent — a second login returns the same user', async () => {
    const first = await repo().provisionOidcUser({
      oidcSubject: 'sub-again',
      email: 'again@acme.com',
      emailVerified: true
    })
    const second = await repo().provisionOidcUser({
      oidcSubject: 'sub-again',
      email: 'again@acme.com',
      emailVerified: true
    })
    expect(second.userId).toBe(first.userId)
    expect(await prisma.membership.count({ where: { userId: first.userId } })).toBe(0)
  })

  it('stores the avatar on signup and refreshes it when the picture changes', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-avatar',
      email: 'ava@acme.com',
      emailVerified: true,
      picture: 'https://cdn.example/ava-v1.png'
    })
    expect((await prisma.user.findUnique({ where: { id: userId } }))?.picture).toBe('https://cdn.example/ava-v1.png')

    // A custom profile photo is a separate preference. A later sign-in still
    // refreshes the OIDC fallback, but cannot clear the explicit choice.
    const customPhotoAt = new Date('2026-07-14T00:00:00.000Z')
    await repo().setProfilePicture(userId, customPhotoAt)

    // A later sign-in with a new photo URL refreshes the stored OIDC avatar.
    await repo().provisionOidcUser({
      oidcSubject: 'sub-avatar',
      email: 'ava@acme.com',
      emailVerified: true,
      picture: 'https://cdn.example/ava-v2.png'
    })
    const row = await prisma.user.findUnique({ where: { id: userId } })
    expect(row?.picture).toBe('https://cdn.example/ava-v2.png')
    expect(row?.profilePictureUpdatedAt).toEqual(customPhotoAt)
  })

  it('synthesizes a placeholder email when none is known, upgraded on a later VERIFIED login', async () => {
    const { userId } = await repo().provisionOidcUser({ oidcSubject: 'sub-bare' })
    expect(isSyntheticEmail((await prisma.user.findUnique({ where: { id: userId } }))?.email)).toBe(true)

    await repo().provisionOidcUser({ oidcSubject: 'sub-bare', email: 'later@acme.com', emailVerified: true })
    expect((await prisma.user.findUnique({ where: { id: userId } }))?.email).toBe('later@acme.com')
  })

  it('retries a synthetic-email upgrade when a concurrent invite creates the holder', async () => {
    const subject = `sub-concurrent-invite-${randomUUID()}`
    const email = `concurrent-invite-${randomUUID()}@acme.com`
    const { userId: canonicalUserId } = await repo().provisionOidcUser({ oidcSubject: subject })
    const findUnique = prisma.user.findUnique.bind(prisma.user)
    let injected = false
    let invitedUserId: string | undefined
    const findSpy = vi.spyOn(prisma.user, 'findUnique').mockImplementation(
      (args) =>
        (async () => {
          const found = await findUnique(args)
          if (!injected && 'email' in args.where && args.where.email === email && found === null) {
            injected = true
            const invited = await repo().addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
            invitedUserId = invited.userId
          }
          return found
        })() as ReturnType<typeof prisma.user.findUnique>
    )

    try {
      await repo().provisionOidcUser({ oidcSubject: subject, email, emailVerified: true })
    } finally {
      findSpy.mockRestore()
    }

    expect(injected).toBe(true)
    expect(invitedUserId).toBeDefined()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: canonicalUserId } })).email).toBe(email)
    expect(await prisma.user.findUnique({ where: { id: invitedUserId! } })).toBeNull()
    expect(
      await prisma.membership.findUnique({
        where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: canonicalUserId } }
      })
    ).not.toBeNull()
  })

  it('merges invited audience membership into the canonical synthetic-email user', async () => {
    const subject = `sub-authority-merge-${randomUUID()}`
    const email = `authority-merge-${randomUUID()}@acme.com`
    const { userId: canonicalUserId } = await repo().provisionOidcUser({ oidcSubject: subject })
    await repo().addMember(DEFAULT_ORG_ID, canonicalUserId, 'collaborator')
    const invited = await repo().addMemberByEmail(DEFAULT_ORG_ID, email, 'owner')

    const daemonId = randomUUID()
    const agentId = randomUUID()
    const cronId = randomUUID()
    const providerId = randomUUID()
    const sourceId = randomUUID()
    const authority = {
      visibility: 'restricted' as const,
      sharedWith: [invited.userId, canonicalUserId, DEFAULT_OWNER_ID],
      createdByUserId: DEFAULT_OWNER_ID
    }
    await seedDaemon(prisma, daemonId, authority)
    await seedAgent(prisma, agentId, { ...authority, daemonId })
    await prisma.cronDef.create({
      data: {
        id: cronId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        schedule: '0 * * * *',
        timezone: 'UTC',
        trigger: 'verify identity authority merge',
        ...authority
      }
    })
    await prisma.mcpProvider.create({
      data: {
        id: providerId,
        orgId: DEFAULT_ORG_ID,
        name: `authority-merge-${providerId.slice(0, 8)}`,
        url: 'https://mcp.example.com/sse',
        ...authority
      }
    })
    await prisma.skillSource.create({
      data: {
        id: sourceId,
        orgId: DEFAULT_ORG_ID,
        name: `authority-merge-${sourceId.slice(0, 8)}`,
        source: 'example-org/example-kit',
        ...authority
      }
    })

    const upgraded = await repo().provisionOidcUser({ oidcSubject: subject, email, emailVerified: true })
    expect(upgraded.userId).toBe(canonicalUserId)
    expect(await prisma.user.findUnique({ where: { id: invited.userId } })).toBeNull()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: canonicalUserId } })).email).toBe(email)
    expect(
      (
        await prisma.membership.findUniqueOrThrow({
          where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: canonicalUserId } }
        })
      ).role
    ).toBe('owner')

    const select = { sharedWith: true, createdByUserId: true } as const
    const resources = await Promise.all([
      prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select }),
      prisma.daemon.findUniqueOrThrow({ where: { id: daemonId }, select }),
      prisma.cronDef.findUniqueOrThrow({ where: { id: cronId }, select }),
      prisma.mcpProvider.findUniqueOrThrow({ where: { id: providerId }, select }),
      prisma.skillSource.findUniqueOrThrow({ where: { id: sourceId }, select })
    ])
    for (const resource of resources) {
      expect(resource).toEqual({
        sharedWith: [canonicalUserId, DEFAULT_OWNER_ID],
        createdByUserId: DEFAULT_OWNER_ID
      })
    }
  })

  it('IGNORES an unverified email everywhere: no claim, no storage, no upgrade', async () => {
    // An owner pre-invites the victim…
    await repo().addMemberByEmail(DEFAULT_ORG_ID, 'victim@corp.com', 'owner')
    // …and an attacker presents the victim's email as an UNVERIFIED hint.
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-attacker',
      email: 'victim@corp.com',
      emailVerified: false
    })
    const attacker = await prisma.user.findUnique({ where: { id: userId } })
    expect(isSyntheticEmail(attacker?.email)).toBe(true) // not stored
    // The invited row is untouched — still unclaimed, still holding the invite.
    const invited = await prisma.user.findUnique({ where: { email: 'victim@corp.com' } })
    expect(invited?.oidcSubject).toBeNull()
    // The attacker belongs to nothing — the invited org membership never moved.
    expect(await prisma.membership.count({ where: { userId } })).toBe(0)
  })

  it('never overwrites a real email that is already stored', async () => {
    const first = await repo().provisionOidcUser({
      oidcSubject: 'sub-stable',
      email: 'real@acme.com',
      emailVerified: true
    })
    await repo().provisionOidcUser({ oidcSubject: 'sub-stable', email: 'changed@acme.com', emailVerified: true })
    expect((await prisma.user.findUnique({ where: { id: first.userId } }))?.email).toBe('real@acme.com')
  })

  it('claims an invited (email-only) row: same user, invited membership kept, nothing added', async () => {
    // An owner pre-adds the email to the default org…
    const invited = await repo().addMemberByEmail(DEFAULT_ORG_ID, 'newhire@acme.com', 'collaborator')
    // …then the person signs in with SSO for the first time.
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-newhire',
      email: 'NewHire@Acme.com', // different case — normalization must still match
      emailVerified: true,
      displayName: 'New Hire'
    })
    expect(userId).toBe(invited.userId) // claimed, not duplicated
    expect((await prisma.user.findUnique({ where: { id: userId } }))?.oidcSubject).toBe('sub-newhire')

    const memberships = await prisma.membership.findMany({ where: { userId } })
    expect(memberships).toHaveLength(1) // the invited org, and only that
    expect(memberships[0]!.orgId).toBe(DEFAULT_ORG_ID)
    expect(memberships[0]!.role).toBe('collaborator')
  })
})

describe('PgOrgRepo', () => {
  it('lists the orgs a user belongs to with role + member count', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-list',
      email: 'list@acme.com',
      emailVerified: true
    })
    const repos = new PgOrgRepo(prisma)
    const owned = await repos.create({ name: null, slug: 'list-own', ownerUserId: userId })
    await repo().addMemberByEmail(DEFAULT_ORG_ID, 'list@acme.com', 'collaborator')

    const orgs = await repos.listForUser(userId)
    expect(orgs).toHaveLength(2)
    expect(orgs[0]!.id).toBe(owned.id) // the org they created, first (insertion order)
    expect(orgs[0]!.role).toBe('owner')
    expect(orgs[0]!.memberCount).toBe(1)
    const def = orgs.find((o) => o.id === DEFAULT_ORG_ID)!
    expect(def.role).toBe('collaborator')
    expect(def.memberCount).toBe(2) // seeded owner + this user
  })

  it('enforces the non-admin organization quota inside the creation transaction', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-org-quota',
      email: 'quota@acme.com',
      emailVerified: true
    })
    const orgs = new PgOrgRepo(prisma)
    const other = await prisma.user.create({ data: { email: 'quota-other@acme.com' } })
    const invitedOrg = await orgs.create({ name: null, slug: 'quota-invited', ownerUserId: other.id })
    await prisma.membership.create({ data: { orgId: invitedOrg.id, userId, role: 'owner' } })
    // The org they create for themselves in onboarding — the one the quota counts.
    await orgs.create({ name: null, slug: 'quota-first', ownerUserId: userId, maxOrgsPerUser: 1 })

    await expect(
      orgs.create({ name: null, slug: 'quota-denied', ownerUserId: userId, maxOrgsPerUser: 1 })
    ).rejects.toMatchObject({ code: 'ORG_CREATION_LIMIT_REACHED' })

    // An owner membership granted by somebody else does not consume this user's creation quota.
    await expect(
      orgs.create({ name: null, slug: 'quota-allowed', ownerUserId: userId, maxOrgsPerUser: 2 })
    ).resolves.toMatchObject({ slug: 'quota-allowed' })
    await expect(
      orgs.create({ name: null, slug: 'quota-denied-again', ownerUserId: userId, maxOrgsPerUser: 2 })
    ).rejects.toMatchObject({ code: 'ORG_CREATION_LIMIT_REACHED' })
  })
})
