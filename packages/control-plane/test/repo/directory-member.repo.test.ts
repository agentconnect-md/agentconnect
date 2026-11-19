/** The membership changes an organization's directory makes: keyed by its own id, repeatable, audited to its connection. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { MemberDirectoryManaged } from '../../src/persistence/errors.js'
import { PgDirectoryMemberRepo } from '../../src/persistence/repositories/directory-member.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const CONNECTION = 'connection-1'
const directory = () => new PgDirectoryMemberRepo(prisma)
const users = () => new PgUserRepo(prisma)
const org = () => new PgOrgRepo(prisma)
const address = (label: string) => `${label}-${randomUUID()}@acme.dev`
const provision = (externalId: string, email: string, role: 'owner' | 'collaborator' | 'viewer' = 'collaborator') =>
  directory().provision(DEFAULT_ORG_ID, CONNECTION, { externalId, email, role })
const memberAudit = async (userId: string) =>
  (await prisma.auditEvent.findMany({ where: { kind: 'member_change' }, orderBy: { id: 'asc' } }))
    .filter((event) => (event.details as { userId?: string }).userId === userId)
    .map((event) => ({ actor: event.actorUserId, ...(event.details as object) }))

describe('provision', () => {
  it('creates a waiting row with a managed membership, once, however often it is asked', async () => {
    const email = address('dana')
    const first = await provision('ext-dana', email.toUpperCase())
    expect(first).toMatchObject({
      outcome: 'changed',
      member: { externalId: 'ext-dana', email, role: 'collaborator', suspendedBy: null }
    })
    if (first.outcome !== 'changed') throw new Error('unreachable')
    const { userId } = first.member
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ email, oidcSubject: null })
    expect(await prisma.membership.findMany({ where: { userId } })).toMatchObject([
      { orgId: DEFAULT_ORG_ID, managedBy: 'directory', directoryExternalId: 'ext-dana', suspendedAt: null }
    ])

    // A replay, and a replay carrying another address or role, name the same member and change nothing.
    expect(await provision('ext-dana', email)).toEqual({ outcome: 'unchanged', member: first.member })
    expect(await provision('ext-dana', address('renamed'), 'owner')).toEqual({
      outcome: 'unchanged',
      member: first.member
    })
    expect(await memberAudit(userId)).toEqual([
      {
        actor: null,
        action: 'member_added',
        userId,
        role: 'collaborator',
        source: 'directory',
        connectionId: CONNECTION
      }
    ])
  })

  it('settles two simultaneous requests for one member on a single membership', async () => {
    const email = address('twice')
    const results = await Promise.all([provision('ext-twice', email), provision('ext-twice', email)])
    expect(results.map((result) => result.outcome).sort()).toEqual(['changed', 'unchanged'])
    expect(await prisma.membership.count({ where: { orgId: DEFAULT_ORG_ID, directoryExternalId: 'ext-twice' } })).toBe(
      1
    )
  })

  it('gives an address that already has an account a membership only', async () => {
    const email = address('erin')
    const account = await users().provisionOidcUser({ oidcSubject: `sub-${randomUUID()}`, email, emailVerified: true })
    const result = await provision('ext-erin', email)
    expect(result).toMatchObject({ outcome: 'changed', member: { userId: account.userId } })
    expect(await prisma.user.count({ where: { email } })).toBe(1)
  })

  it('leaves alone a member who is here by invitation, a second directory id for one person, and what is not a person', async () => {
    const invited = address('frank')
    await users().addMemberByEmail(DEFAULT_ORG_ID, invited, 'viewer')
    expect(await provision('ext-frank', invited)).toEqual({ outcome: 'conflict' })
    expect(
      await prisma.membership.findFirst({ where: { orgId: DEFAULT_ORG_ID, user: { email: invited } } })
    ).toMatchObject({ managedBy: 'manual', directoryExternalId: null })

    const managed = address('gail')
    await provision('ext-gail', managed)
    expect(await provision('ext-gail-again', managed)).toEqual({ outcome: 'conflict' })

    const service = await users().createServiceAccount(DEFAULT_ORG_ID, { name: 'builder', role: 'collaborator' })
    expect(await provision('ext-service', service.email)).toEqual({ outcome: 'conflict' })
  })
})

describe('setSuspended', () => {
  it('suspends and restores its own member, and repeats to the same result', async () => {
    const created = await provision('ext-hank', address('hank'))
    if (created.outcome !== 'changed') throw new Error('unreachable')
    const { userId } = created.member
    const set = (suspended: boolean) => directory().setSuspended(DEFAULT_ORG_ID, CONNECTION, 'ext-hank', suspended)

    expect(await set(true)).toMatchObject({ outcome: 'changed', member: { suspendedBy: 'directory' } })
    expect(await set(true)).toMatchObject({ outcome: 'unchanged', member: { suspendedBy: 'directory' } })
    expect(await org().roleOf(DEFAULT_ORG_ID, userId)).toBeNull()

    expect(await set(false)).toMatchObject({ outcome: 'changed', member: { suspendedBy: null } })
    expect(await set(false)).toMatchObject({ outcome: 'unchanged', member: { suspendedBy: null } })
    expect(await org().roleOf(DEFAULT_ORG_ID, userId)).toBe('collaborator')

    expect((await memberAudit(userId)).map((event) => (event as { action?: string }).action)).toEqual([
      'member_added',
      'member_suspended',
      'member_restored'
    ])
    expect(await directory().setSuspended(DEFAULT_ORG_ID, CONNECTION, 'ext-nobody', true)).toEqual({
      outcome: 'not_found'
    })
  })

  it('does not relabel or lift a suspension an owner made', async () => {
    const created = await provision('ext-ivy', address('ivy'))
    if (created.outcome !== 'changed') throw new Error('unreachable')
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: created.member.userId } },
      data: { suspendedAt: new Date(), suspendedBy: 'manual' }
    })
    const set = (suspended: boolean) => directory().setSuspended(DEFAULT_ORG_ID, CONNECTION, 'ext-ivy', suspended)
    expect(await set(true)).toMatchObject({ outcome: 'unchanged', member: { suspendedBy: 'manual' } })
    expect(await set(false)).toMatchObject({ outcome: 'held', member: { suspendedBy: 'manual' } })
    expect(await org().roleOf(DEFAULT_ORG_ID, created.member.userId)).toBeNull()
  })
})

describe('setRole', () => {
  it('changes the role with the previous one on record, and nothing when it already holds', async () => {
    const created = await provision('ext-jo', address('jo'))
    if (created.outcome !== 'changed') throw new Error('unreachable')
    const { userId } = created.member
    const set = (role: 'owner' | 'viewer') => directory().setRole(DEFAULT_ORG_ID, CONNECTION, 'ext-jo', role)
    expect(await set('viewer')).toMatchObject({ outcome: 'changed', member: { role: 'viewer' } })
    expect(await set('viewer')).toMatchObject({ outcome: 'unchanged', member: { role: 'viewer' } })
    expect((await memberAudit(userId)).at(-1)).toEqual({
      actor: null,
      action: 'role_changed',
      userId,
      role: 'viewer',
      previousRole: 'collaborator',
      source: 'directory',
      connectionId: CONNECTION
    })
    expect(await directory().setRole(DEFAULT_ORG_ID, CONNECTION, 'ext-nobody', 'viewer')).toEqual({
      outcome: 'not_found'
    })
  })

  it('may demote or suspend the only owner, which an owner in the console may not', async () => {
    const { userId: ownerId } = await users().provisionOidcUser({
      oidcSubject: `sub-${randomUUID()}`,
      email: address('owner'),
      emailVerified: true
    })
    const created = await org().create({ name: null, slug: `dir-${randomUUID().slice(0, 8)}`, ownerUserId: ownerId })
    await prisma.membership.update({
      where: { orgId_userId: { orgId: created.id, userId: ownerId } },
      data: { managedBy: 'directory', directoryExternalId: 'ext-owner' }
    })
    expect(await directory().setSuspended(created.id, CONNECTION, 'ext-owner', true)).toMatchObject({
      outcome: 'changed'
    })
    expect(await directory().setRole(created.id, CONNECTION, 'ext-owner', 'viewer')).toMatchObject({
      outcome: 'changed',
      member: { role: 'viewer', suspendedBy: 'directory' }
    })
  })
})

describe('a member the directory manages, in the console', () => {
  it('keeps the role the directory gave: an owner’s change is refused with a code', async () => {
    const created = await provision('ext-kim', address('kim'))
    if (created.outcome !== 'changed') throw new Error('unreachable')
    const { userId } = created.member
    await expect(users().setMemberRole(DEFAULT_ORG_ID, userId, 'owner', DEFAULT_OWNER_ID)).rejects.toBeInstanceOf(
      MemberDirectoryManaged
    )
    // Saving the role it already has is not a change.
    await expect(
      users().setMemberRole(DEFAULT_ORG_ID, userId, 'collaborator', DEFAULT_OWNER_ID)
    ).resolves.toMatchObject({ role: 'collaborator' })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/members/${userId}`,
        payload: { role: 'viewer' }
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'MEMBER_DIRECTORY_MANAGED' })
    } finally {
      await close()
    }
    expect(await org().roleOf(DEFAULT_ORG_ID, userId)).toBe('collaborator')
  })
})
