/**
 * PgUserRepo — WebUI identity JIT-provisioned from a verified OIDC `sub` (§3.2).
 *
 * First sight of a subject is SIGNUP: the user row is created (or an invited,
 * email-only row is claimed) and a personal org is created with the user as its
 * owner. Synthetic `<sub>@oidc.local` placeholder emails behave as before
 * (stored when no email is known, upgraded later, never surfaced). Org context
 * is resolved per request via `resolveOrgContext`.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { isSyntheticEmail } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const repo = () => new PgUserRepo(prisma)

describe('PgUserRepo.provisionOidcUser — signup creates the personal org', () => {
  it('creates the user (real email + display name) and a personal org they own', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-real',
      email: 'dana@acme.com',
      emailVerified: true,
      displayName: 'Dana Reyes'
    })
    const u = await prisma.user.findUnique({ where: { id: userId } })
    expect(u?.email).toBe('dana@acme.com')
    expect(u?.displayName).toBe('Dana Reyes')

    const memberships = await prisma.membership.findMany({ where: { userId }, include: { org: true } })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.role).toBe('owner')
    expect(memberships[0]!.org.name).toBe("Dana's organization")
    expect(memberships[0]!.org.slug).toBe('dana')
  })

  it('is idempotent — a second login does not create a second org', async () => {
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
    expect(await prisma.membership.count({ where: { userId: first.userId } })).toBe(1)
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
    // Attacker got only their personal org, never the invited org membership.
    const memberships = await prisma.membership.findMany({ where: { userId } })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.orgId).not.toBe(DEFAULT_ORG_ID)
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

  it('claims an invited (email-only) row: same user, invited membership kept, personal org added', async () => {
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

    const memberships = await prisma.membership.findMany({ where: { userId }, include: { org: true } })
    expect(memberships).toHaveLength(2) // invited org + fresh personal org
    expect(memberships.map((m) => m.role).sort()).toEqual(['collaborator', 'owner'])
  })

  it('allocates a suffixed slug when the personal slug is taken', async () => {
    await repo().provisionOidcUser({ oidcSubject: 'sub-a', email: 'sam@a.com', emailVerified: true })
    await repo().provisionOidcUser({ oidcSubject: 'sub-b', email: 'sam@b.com', emailVerified: true })
    const slugs = (await prisma.org.findMany({ where: { slug: { startsWith: 'sam' } } })).map((o) => o.slug).sort()
    expect(slugs).toEqual(['sam', 'sam-2'])
  })
})

describe('PgUserRepo.healPersonalOrg — interrupted-signup recovery', () => {
  it('restores the personal org for a membership-less user', async () => {
    // Simulate an interrupted signup: user row exists, org creation never landed.
    const u = await prisma.user.create({ data: { oidcSubject: 'sub-brick', email: 'brick@acme.com' } })
    await repo().healPersonalOrg(u.id)
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: u.id }, include: { org: true } })
    expect(m.role).toBe('owner')
    expect(m.org.slug).toBe('brick')
  })

  it('is a no-op for a user who already owns an org, and for an unknown user', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-ok',
      email: 'ok@acme.com',
      emailVerified: true
    })
    await repo().healPersonalOrg(userId)
    expect(await prisma.membership.count({ where: { userId } })).toBe(1) // no duplicate org
    await repo().healPersonalOrg('usr_nobody') // must not throw
  })
})

describe('PgOrgRepo', () => {
  it('lists the orgs a user belongs to with role + member count', async () => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: 'sub-list',
      email: 'list@acme.com',
      emailVerified: true
    })
    await repo().addMemberByEmail(DEFAULT_ORG_ID, 'list@acme.com', 'collaborator')

    const orgs = await new PgOrgRepo(prisma).listForUser(userId)
    expect(orgs).toHaveLength(2)
    expect(orgs[0]!.role).toBe('owner') // personal org first (insertion order)
    expect(orgs[0]!.memberCount).toBe(1)
    const def = orgs.find((o) => o.id === DEFAULT_ORG_ID)!
    expect(def.role).toBe('collaborator')
    expect(def.memberCount).toBe(2) // seeded owner + this user
  })
})
