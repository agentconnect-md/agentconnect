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

describe('PgUserRepo Google account id (google-chat-integration.md §10.6)', () => {
  it('records, moves off a stale holder, and clears the id', async () => {
    const first = await repo().provisionOidcUser({
      oidcSubject: 'sub-google-a',
      email: 'a@acme.com',
      emailVerified: true
    })
    const second = await repo().provisionOidcUser({
      oidcSubject: 'sub-google-b',
      email: 'b@acme.com',
      emailVerified: true
    })
    expect(await repo().getGoogleAccountId(first.userId)).toBeNull()

    await repo().setGoogleAccountId(first.userId, '100000000000000000009')
    expect(await repo().getGoogleAccountId(first.userId)).toBe('100000000000000000009')

    // The identity provider now reports the account on another user, so the unique id moves there.
    await repo().setGoogleAccountId(second.userId, '100000000000000000009')
    expect(await repo().getGoogleAccountId(second.userId)).toBe('100000000000000000009')
    expect(await repo().getGoogleAccountId(first.userId)).toBeNull()

    await repo().setGoogleAccountId(second.userId, null)
    expect(await repo().getGoogleAccountId(second.userId)).toBeNull()
  })
})

describe('PgUserRepo verified address', () => {
  const AT = new Date('2026-01-01T00:00:00Z')
  const NONE = { verified: [], tenant: [], asserted: [] }
  const social = (...verified: string[]) => ({ verified, tenant: [], asserted: [] })
  const microsoft = (...tenant: string[]) => ({ verified: [], tenant, asserted: [] })
  const sso = (connectorId: string, email: string) => ({ verified: [], tenant: [], asserted: [{ connectorId, email }] })
  const member = async (email: string, role: 'owner' | 'collaborator' | 'viewer' = 'collaborator') => {
    const { userId } = await repo().provisionOidcUser({
      oidcSubject: `sub-${randomUUID()}`,
      email,
      emailVerified: true
    })
    await repo().addMember(DEFAULT_ORG_ID, userId, role)
    return userId
  }
  const evidenceOf = (userId: string) =>
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true, emailSsoConnectorIds: true, linkedEmails: true, tenantEmails: true }
    })
  const otherOrg = async () => (await prisma.org.create({ data: { slug: `org-${randomUUID()}` } })).id
  const connect = (orgId: string, logtoConnectorId: string, activatedAt: Date | null = AT) =>
    prisma.orgSsoConnection.create({
      data: { orgId, logtoConnectorId, protocol: 'oidc', activatedAt, configChangedAt: AT }
    })
  const claim = (orgId: string, domain: string, verifiedAt: Date | null = AT) =>
    prisma.orgDomain.create({
      data: {
        orgId,
        domain,
        challenge: `challenge-${randomUUID()}`,
        challengeExpiresAt: new Date(Date.now() + 60_000),
        verifiedAt
      }
    })
  const matches = async (orgId: string, email: string) => (await repo().memberByVerifiedEmail(orgId, email)) !== null

  it('matches a member only once a sign-in method that verifies addresses reports the stored one', async () => {
    const userId = await member('verified@example.test')
    expect(await matches(DEFAULT_ORG_ID, 'verified@example.test')).toBe(false)

    // An address the sign-in methods report for another mailbox proves nothing about the stored one.
    await repo().recordEmailEvidence(userId, social('elsewhere@example.test'), AT)
    expect((await evidenceOf(userId)).emailVerifiedAt).toBeNull()
    expect(await matches(DEFAULT_ORG_ID, 'verified@example.test')).toBe(false)

    await repo().recordEmailEvidence(userId, social('elsewhere@example.test', ' Verified@Example.Test '), AT)
    expect((await evidenceOf(userId)).emailVerifiedAt).toEqual(AT)
    expect(await repo().memberByVerifiedEmail(DEFAULT_ORG_ID, ' Verified@Example.TEST')).toMatchObject({
      userId,
      email: 'verified@example.test',
      role: 'collaborator'
    })
    expect(await matches(`org-${randomUUID()}`, 'verified@example.test')).toBe(false)
  })

  it('matches a member by any address a verifying sign-in method reports, in every organization, until it is unlinked', async () => {
    const userId = await member('primary@example.test')
    const second = await otherOrg()
    await repo().addMember(second, userId, 'collaborator')
    await repo().recordEmailEvidence(userId, social('primary@example.test', ' Work@Corp.Example.Test '), AT)
    expect((await evidenceOf(userId)).linkedEmails).toEqual(['primary@example.test', 'work@corp.example.test'])
    expect(await repo().memberByVerifiedEmail(DEFAULT_ORG_ID, 'work@corp.example.test')).toMatchObject({ userId })
    expect(await matches(second, 'work@corp.example.test')).toBe(true)

    await repo().recordEmailEvidence(userId, social('primary@example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'work@corp.example.test')).toBe(false)
    expect(await matches(DEFAULT_ORG_ID, 'primary@example.test')).toBe(true)
  })

  it('counts a Microsoft address only under a domain the organization has verified now', async () => {
    const userId = await member('primary@example.test')
    await repo().recordEmailEvidence(userId, microsoft('member@tenant.example.test'), AT)
    expect(await evidenceOf(userId)).toMatchObject({
      emailVerifiedAt: null,
      tenantEmails: ['member@tenant.example.test']
    })
    expect(await matches(DEFAULT_ORG_ID, 'member@tenant.example.test')).toBe(false)

    const domain = await claim(DEFAULT_ORG_ID, 'tenant.example.test')
    expect(await matches(DEFAULT_ORG_ID, 'member@tenant.example.test')).toBe(true)
    await prisma.orgDomain.delete({ where: { id: domain.id } })
    expect(await matches(DEFAULT_ORG_ID, 'member@tenant.example.test')).toBe(false)

    // A Microsoft identity reporting the stored address does not verify it either.
    await repo().recordEmailEvidence(userId, microsoft('primary@example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'primary@example.test')).toBe(false)
  })

  it('names nobody when two members both hold the address', async () => {
    const first = await member('first@example.test')
    const second = await member('second@example.test')
    await repo().recordEmailEvidence(first, social('shared@example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'shared@example.test')).toBe(true)

    await repo().recordEmailEvidence(second, social('shared@example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'shared@example.test')).toBe(false)
  })

  it('keeps the first mark while the address stays vouched for, and drops it when it no longer is', async () => {
    const userId = await member('kept@example.test')
    await repo().recordEmailEvidence(userId, social('kept@example.test'), AT)
    await repo().recordEmailEvidence(userId, social('kept@example.test'), new Date('2026-02-01T00:00:00Z'))
    expect((await evidenceOf(userId)).emailVerifiedAt).toEqual(AT)

    await repo().recordEmailEvidence(userId, NONE, new Date('2026-03-01T00:00:00Z'))
    expect((await evidenceOf(userId)).emailVerifiedAt).toBeNull()
    expect(await matches(DEFAULT_ORG_ID, 'kept@example.test')).toBe(false)
  })

  it('never matches an invited row, a suspended member, or a service account', async () => {
    const owner = await member('owner-verified@example.test', 'owner')
    const invited = await repo().addMemberByEmail(DEFAULT_ORG_ID, 'invited@example.test', 'viewer', owner)
    expect((await evidenceOf(invited.userId)).emailVerifiedAt).toBeNull()
    expect(await matches(DEFAULT_ORG_ID, 'invited@example.test')).toBe(false)

    const suspended = await member('suspended@example.test')
    await repo().recordEmailEvidence(suspended, social('suspended@example.test'), AT)
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: suspended } },
      data: { suspendedAt: AT }
    })
    expect(await matches(DEFAULT_ORG_ID, 'suspended@example.test')).toBe(false)

    const account = await repo().createServiceAccount(DEFAULT_ORG_ID, { name: 'mailer', role: 'collaborator' })
    await repo().recordEmailEvidence(account.userId, social(account.email), AT)
    expect((await evidenceOf(account.userId)).emailVerifiedAt).toBeNull()
    // Even a mark written some other way does not make a service account a mail sender.
    await prisma.user.update({ where: { id: account.userId }, data: { emailVerifiedAt: AT } })
    expect(await matches(DEFAULT_ORG_ID, account.email)).toBe(false)
  })

  it('takes an organization’s own connection at its word inside that organization only', async () => {
    const userId = await member('sso@corp.example.test')
    const second = await otherOrg()
    await repo().addMember(second, userId, 'collaborator')
    await connect(DEFAULT_ORG_ID, 'connector-corp')
    await claim(DEFAULT_ORG_ID, 'corp.example.test')

    await repo().recordEmailEvidence(userId, sso('connector-corp', 'SSO@corp.example.test'), AT)
    expect(await evidenceOf(userId)).toMatchObject({ emailVerifiedAt: null, emailSsoConnectorIds: ['connector-corp'] })
    expect(await matches(DEFAULT_ORG_ID, 'sso@corp.example.test')).toBe(true)
    expect(await matches(second, 'sso@corp.example.test')).toBe(false)

    // A connection of its own does not let the second organization read the first one's evidence.
    await connect(second, 'connector-second')
    await claim(second, 'second.example.test')
    expect(await matches(second, 'sso@corp.example.test')).toBe(false)
  })

  it('needs the address’s domain verified by that organization now, and its connection still there', async () => {
    const userId = await member('sso@pending.example.test')
    await connect(DEFAULT_ORG_ID, 'connector-pending')
    const pending = await claim(DEFAULT_ORG_ID, 'pending.example.test', null)
    await repo().recordEmailEvidence(userId, sso('connector-pending', 'sso@pending.example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'sso@pending.example.test')).toBe(false)

    await prisma.orgDomain.update({ where: { id: pending.id }, data: { verifiedAt: AT } })
    expect(await matches(DEFAULT_ORG_ID, 'sso@pending.example.test')).toBe(true)

    // Releasing the domain deletes its row, and a subdomain or a sibling domain never stands in for it.
    await prisma.orgDomain.delete({ where: { id: pending.id } })
    await claim(DEFAULT_ORG_ID, 'example.test')
    expect(await matches(DEFAULT_ORG_ID, 'sso@pending.example.test')).toBe(false)

    await claim(DEFAULT_ORG_ID, 'pending.example.test')
    expect(await matches(DEFAULT_ORG_ID, 'sso@pending.example.test')).toBe(true)
    await prisma.orgSsoConnection.delete({ where: { orgId: DEFAULT_ORG_ID } })
    expect(await matches(DEFAULT_ORG_ID, 'sso@pending.example.test')).toBe(false)
  })

  it('counts the organization’s connection only while it is active', async () => {
    const userId = await member('sso@draft.example.test')
    // A draft connection: a test sign-in can leave an identity on it before it is ever activated.
    await connect(DEFAULT_ORG_ID, 'connector-draft', null)
    await claim(DEFAULT_ORG_ID, 'draft.example.test')
    await repo().recordEmailEvidence(userId, sso('connector-draft', 'sso@draft.example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'sso@draft.example.test')).toBe(false)

    await prisma.orgSsoConnection.update({ where: { orgId: DEFAULT_ORG_ID }, data: { activatedAt: AT } })
    expect(await matches(DEFAULT_ORG_ID, 'sso@draft.example.test')).toBe(true)

    // Deactivating keeps the connection and its identities, and still ends the match.
    await prisma.orgSsoConnection.update({ where: { orgId: DEFAULT_ORG_ID }, data: { activatedAt: null } })
    expect(await matches(DEFAULT_ORG_ID, 'sso@draft.example.test')).toBe(false)
  })

  it('ignores a connection that asserts another address, and forgets one whose identity is gone', async () => {
    const userId = await member('stored@corp.example.test')
    await connect(DEFAULT_ORG_ID, 'connector-corp')
    await claim(DEFAULT_ORG_ID, 'corp.example.test')

    await repo().recordEmailEvidence(userId, sso('connector-corp', 'colleague@corp.example.test'), AT)
    expect((await evidenceOf(userId)).emailSsoConnectorIds).toEqual([])
    expect(await matches(DEFAULT_ORG_ID, 'stored@corp.example.test')).toBe(false)
    expect(await matches(DEFAULT_ORG_ID, 'colleague@corp.example.test')).toBe(false)

    await repo().recordEmailEvidence(userId, sso('connector-corp', 'stored@corp.example.test'), AT)
    expect(await matches(DEFAULT_ORG_ID, 'stored@corp.example.test')).toBe(true)
    await repo().recordEmailEvidence(userId, NONE, AT)
    expect((await evidenceOf(userId)).emailSsoConnectorIds).toEqual([])
    expect(await matches(DEFAULT_ORG_ID, 'stored@corp.example.test')).toBe(false)
  })

  it('takes the deployment’s connector at its word everywhere only while it reports verified addresses', async () => {
    const userId = await member('staff@example.test')
    const second = await otherOrg()
    await repo().addMember(second, userId, 'collaborator')
    const asserted = [{ connectorId: 'connector-deployment', email: 'staff@example.test' }]

    // Trusting unverified addresses: the address is only asserted, by a connector no organization owns.
    await repo().recordEmailEvidence(userId, { verified: [], tenant: [], asserted }, AT)
    expect(await matches(DEFAULT_ORG_ID, 'staff@example.test')).toBe(false)

    // Not trusting them: the sync reports the same address as verified.
    await repo().recordEmailEvidence(userId, { verified: ['staff@example.test'], tenant: [], asserted }, AT)
    expect(await matches(DEFAULT_ORG_ID, 'staff@example.test')).toBe(true)
    expect(await matches(second, 'staff@example.test')).toBe(true)

    await repo().recordEmailEvidence(userId, { verified: [], tenant: [], asserted }, AT)
    expect(await matches(DEFAULT_ORG_ID, 'staff@example.test')).toBe(false)
  })
})

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

describe('PgUserRepo.provisionOidcUser — a row the organization’s directory manages', () => {
  const CONNECTOR = 'connector-acme'
  const connect = (logtoConnectorId: string, activatedAt: Date | null = new Date()) =>
    prisma.orgSsoConnection.create({
      data: { orgId: DEFAULT_ORG_ID, logtoConnectorId, protocol: 'oidc', activatedAt, configChangedAt: new Date() }
    })
  /** An email-only row whose membership the directory manages, as the directory creates it. */
  async function managed(email: string): Promise<string> {
    const { userId } = await repo().addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId } },
      data: { managedBy: 'directory', directoryExternalId: `ext-${randomUUID()}` }
    })
    return userId
  }
  const subjectOf = async (userId: string) => (await prisma.user.findUnique({ where: { id: userId } }))?.oidcSubject

  it('is claimed only by a sign-in through that organization’s own active connection', async () => {
    await connect(CONNECTOR)
    const row = await managed('dana@acme.dev')
    const signIn = (oidcSubject: string, ssoConnectorId: string | null) =>
      repo().provisionOidcUser({ oidcSubject, email: 'dana@acme.dev', emailVerified: true, ssoConnectorId })

    // A verified address alone, or another organization's connector, gets its own account and leaves the row waiting.
    for (const [subject, connector] of [
      ['sub-social', null],
      ['sub-elsewhere', 'connector-other']
    ] as const) {
      const { userId } = await signIn(subject, connector)
      expect(userId).not.toBe(row)
      expect(isSyntheticEmail((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email)).toBe(true)
      expect(await prisma.membership.count({ where: { userId } })).toBe(0)
    }
    expect(await subjectOf(row)).toBeNull()

    expect((await signIn('sub-dana', CONNECTOR)).userId).toBe(row)
    expect(await subjectOf(row)).toBe('sub-dana')
  })

  it('waits while the connection is not active, and an ordinary invite is claimed as before', async () => {
    await connect(CONNECTOR, null)
    const row = await managed('erin@acme.dev')
    const first = await repo().provisionOidcUser({
      oidcSubject: 'sub-erin',
      email: 'erin@acme.dev',
      emailVerified: true,
      ssoConnectorId: CONNECTOR
    })
    expect(first.userId).not.toBe(row)

    const invited = await repo().addMemberByEmail(DEFAULT_ORG_ID, 'frank@acme.dev', 'viewer')
    const frank = await repo().provisionOidcUser({
      oidcSubject: 'sub-frank',
      email: 'frank@acme.dev',
      emailVerified: true
    })
    expect(frank.userId).toBe(invited.userId)
  })

  it('is merged into an account that signed in earlier only once that account signs in through the connection', async () => {
    await connect(CONNECTOR)
    // The account exists first, with no address; the directory then creates the row for its address.
    const { userId } = await repo().provisionOidcUser({ oidcSubject: 'sub-gail' })
    const row = await managed('gail@acme.dev')
    const signIn = (ssoConnectorId: string | null) =>
      repo().provisionOidcUser({ oidcSubject: 'sub-gail', email: 'gail@acme.dev', emailVerified: true, ssoConnectorId })

    await signIn(null)
    expect(await prisma.membership.count({ where: { userId } })).toBe(0)
    expect(await prisma.user.findUnique({ where: { id: row } })).not.toBeNull()

    await signIn(CONNECTOR)
    expect(await prisma.user.findUnique({ where: { id: row } })).toBeNull()
    expect(await prisma.membership.findMany({ where: { userId } })).toMatchObject([
      { orgId: DEFAULT_ORG_ID, role: 'collaborator', managedBy: 'directory' }
    ])
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email).toBe('gail@acme.dev')
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
