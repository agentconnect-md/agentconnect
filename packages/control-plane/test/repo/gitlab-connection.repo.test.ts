/**
 * Atomic, version-fenced GitLab connection transitions (gitlab-com-integration.md
 * §9.3/§9.4 + the M1 review round): metadata and the sealed pair commit
 * together; stale refresh outcomes lose to newer intent; disconnect defeats an
 * in-flight refresh; membership removal takes the OAuth authority with it.
 */
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import {
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore
} from '../../src/persistence/repositories/gitlab.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { GitlabMembershipGone } from '../../src/persistence/errors.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const repo = () => new PgGitlabConnectionRepo(prisma)
const store = () => new PgGitlabConnectionSecretStore(prisma, cipher)

const pair = (tag: string) => ({ accessToken: `at-${tag}`, refreshToken: `rt-${tag}` })

async function connected() {
  return repo().upsertOnCallback({
    orgId: DEFAULT_ORG_ID,
    userId: DEFAULT_OWNER_ID,
    gitlabUserId: 4242n,
    gitlabUsername: 'example-admin',
    scopes: ['api'],
    accessExpiresAt: null,
    sealedPair: pair('v1')
  })
}

describe('PgGitlabConnectionRepo transitions', () => {
  it('upserts metadata and the sealed pair atomically; reconnect advances the version', async () => {
    const first = await connected()
    expect(await store().get(DEFAULT_ORG_ID, first.id)).toEqual(pair('v1'))
    const again = await repo().upsertOnCallback({
      orgId: DEFAULT_ORG_ID,
      userId: DEFAULT_OWNER_ID,
      gitlabUserId: 4242n,
      gitlabUsername: 'example-admin',
      scopes: ['api'],
      accessExpiresAt: null,
      sealedPair: pair('v2')
    })
    expect(again.id).toBe(first.id)
    expect(again.tokenVersion).toBe(first.tokenVersion + 1n)
    expect(await store().get(DEFAULT_ORG_ID, first.id)).toEqual(pair('v2'))
  })

  it('commitRefresh is a CAS: the stale writer loses and cannot resurrect a pair', async () => {
    const record = await connected()
    expect(await repo().commitRefresh(record.id, record.tokenVersion, null, pair('r1'))).toBe(true)
    // The same expected version again — a raced second writer — must lose.
    expect(await repo().commitRefresh(record.id, record.tokenVersion, null, pair('r2'))).toBe(false)
    expect(await store().get(DEFAULT_ORG_ID, record.id)).toEqual(pair('r1'))
  })

  it('disconnect bumps the version and deletes the pair, defeating an in-flight refresh', async () => {
    const record = await connected()
    expect(await repo().disconnect(DEFAULT_ORG_ID, record.id)).toBe(true)
    expect(await store().get(DEFAULT_ORG_ID, record.id)).toBeNull()
    // The refresh that was in flight before the disconnect commits nothing.
    expect(await repo().commitRefresh(record.id, record.tokenVersion, null, pair('late'))).toBe(false)
    expect(await store().get(DEFAULT_ORG_ID, record.id)).toBeNull()
    expect((await repo().get(DEFAULT_ORG_ID, record.id))!.state).toBe('disconnected')
  })

  it('markReauthRequired is version-fenced: a stale outcome keeps newer state', async () => {
    const record = await connected()
    expect(await repo().markReauthRequired(record.id, record.tokenVersion - 1n)).toBe(false)
    expect((await repo().get(DEFAULT_ORG_ID, record.id))!.state).toBe('connected')
    expect(await repo().markReauthRequired(record.id, record.tokenVersion)).toBe(true)
    expect((await repo().get(DEFAULT_ORG_ID, record.id))!.state).toBe('reauth_required')
  })

  it('membership removal disconnects the departed member connections (§9.4)', async () => {
    const users = new PgUserRepo(prisma)
    const member = await users.addMemberByEmail(DEFAULT_ORG_ID, 'departing@example.test', 'collaborator')
    const record = await repo().upsertOnCallback({
      orgId: DEFAULT_ORG_ID,
      userId: member.userId,
      gitlabUserId: 777n,
      gitlabUsername: 'departing',
      scopes: ['api'],
      accessExpiresAt: null,
      sealedPair: pair('member')
    })
    await users.removeMember(DEFAULT_ORG_ID, member.userId, DEFAULT_OWNER_ID)
    const after = (await repo().get(DEFAULT_ORG_ID, record.id))!
    expect(after.state).toBe('disconnected')
    expect(after.tokenVersion).toBe(record.tokenVersion + 1n)
    expect(await store().get(DEFAULT_ORG_ID, record.id)).toBeNull()
    // The version bump also fences any refresh that was in flight at removal time.
    expect(await repo().commitRefresh(record.id, record.tokenVersion, null, pair('late'))).toBe(false)
  })

  it('a raw membership delete disconnects too — the trigger, not the repo method, is the authority', async () => {
    const users = new PgUserRepo(prisma)
    const member = await users.addMemberByEmail(DEFAULT_ORG_ID, 'raw-departing@example.test', 'collaborator')
    const record = await repo().upsertOnCallback({
      orgId: DEFAULT_ORG_ID,
      userId: member.userId,
      gitlabUserId: 778n,
      gitlabUsername: 'raw-departing',
      scopes: ['api'],
      accessExpiresAt: null,
      sealedPair: pair('raw')
    })
    await prisma.membership.delete({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: member.userId } }
    })
    const after = (await repo().get(DEFAULT_ORG_ID, record.id))!
    expect(after.state).toBe('disconnected')
    expect(await store().get(DEFAULT_ORG_ID, record.id)).toBeNull()
  })

  it('account deletion (cascade path the repo never sees) disconnects as well (§9.4)', async () => {
    const users = new PgUserRepo(prisma)
    const member = await users.addMemberByEmail(DEFAULT_ORG_ID, 'deleted-account@example.test', 'collaborator')
    const record = await repo().upsertOnCallback({
      orgId: DEFAULT_ORG_ID,
      userId: member.userId,
      gitlabUserId: 779n,
      gitlabUsername: 'deleted-account',
      scopes: ['api'],
      accessExpiresAt: null,
      sealedPair: pair('gone')
    })
    // The external admin app deletes app_user directly: memberships cascade,
    // the connection userId SET-NULLs — both triggers close both orderings.
    await prisma.user.delete({ where: { id: member.userId } })
    const after = (await repo().get(DEFAULT_ORG_ID, record.id))!
    expect(after.state).toBe('disconnected')
    expect(after.userId).toBeNull()
    expect(await store().get(DEFAULT_ORG_ID, record.id)).toBeNull()
  })

  it('the callback upsert refuses a departed starter inside the same transaction', async () => {
    const users = new PgUserRepo(prisma)
    const member = await users.addMemberByEmail(DEFAULT_ORG_ID, 'toctou@example.test', 'collaborator')
    await prisma.membership.delete({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: member.userId } }
    })
    await expect(
      repo().upsertOnCallback({
        orgId: DEFAULT_ORG_ID,
        userId: member.userId,
        gitlabUserId: 780n,
        gitlabUsername: 'toctou',
        scopes: ['api'],
        accessExpiresAt: null,
        sealedPair: pair('never')
      })
    ).rejects.toThrow(GitlabMembershipGone)
    expect(await prisma.gitlabConnection.count({ where: { gitlabUserId: 780n } })).toBe(0)
  })
})
