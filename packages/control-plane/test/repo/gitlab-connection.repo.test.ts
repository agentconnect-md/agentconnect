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

/** One provisioning binding administered by `installerConnectionId`. */
const binding = (installerConnectionId: string) => ({
  orgId: DEFAULT_ORG_ID,
  projectId: 4455667n,
  projectPath: 'example-group/example-project',
  installerConnectionId,
  state: 'provisioning'
})

/** Let the other transaction reach its lock before this one asks for it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 150))

async function connected() {
  return repo().upsertOnCallback({
    orgId: DEFAULT_ORG_ID,
    userId: DEFAULT_OWNER_ID,
    gitlabUserId: 4242n,
    gitlabUsername: 'example-admin',
    scopes: ['api'],
    accessExpiresAt: null,
    sealedPair: pair('v1'),
    axisBaseUrl: 'https://gitlab.com'
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
      sealedPair: pair('v2'),
      axisBaseUrl: 'https://gitlab.com'
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

  it('remove is state-fenced: only an already-released row goes (§9.4)', async () => {
    const record = await connected()
    expect(await repo().remove(DEFAULT_ORG_ID, record.id)).toEqual({ outcome: 'not_disconnected' })
    expect((await repo().get(DEFAULT_ORG_ID, record.id))!.state).toBe('connected')
    await repo().disconnect(DEFAULT_ORG_ID, record.id)
    expect(await repo().remove(DEFAULT_ORG_ID, record.id)).toEqual({ outcome: 'removed' })
    expect(await repo().get(DEFAULT_ORG_ID, record.id)).toBeNull()
    expect(await repo().remove(DEFAULT_ORG_ID, record.id)).toEqual({ outcome: 'missing' })
  })

  it('a binding attached mid-removal meets the refusal, not a silent detach (§9.4)', async () => {
    const record = await connected()
    await repo().disconnect(DEFAULT_ORG_ID, record.id)

    // Transaction A inserts a binding and holds its installer FK lock open.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const inserting = prisma.$transaction(
      async (tx) => {
        await tx.gitlabProjectBinding.create({ data: binding(record.id) })
        await held
      },
      { timeout: 20_000 }
    )
    await tick()

    // Transaction B wants the row: FOR UPDATE waits for A, then counts what A added.
    const removing = repo().remove(DEFAULT_ORG_ID, record.id)
    await tick()
    release()
    await inserting

    expect(await removing).toEqual({ outcome: 'blocked', assignedProjects: 1 })
    const row = await prisma.gitlabProjectBinding.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row.installerConnectionId).toBe(record.id)
  })

  it('negative control: the unfenced state-only delete detaches that binding instead', async () => {
    const record = await connected()
    await repo().disconnect(DEFAULT_ORG_ID, record.id)
    await prisma.gitlabProjectBinding.create({ data: binding(record.id) })
    // The shape `remove` deliberately is not: no lock, no count, so ON DELETE SET
    // NULL quietly orphans an administered project.
    await prisma.gitlabConnection.deleteMany({ where: { id: record.id, state: 'disconnected' } })
    const row = await prisma.gitlabProjectBinding.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row.installerConnectionId).toBeNull()
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
      sealedPair: pair('member'),
      axisBaseUrl: 'https://gitlab.com'
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
      sealedPair: pair('raw'),
      axisBaseUrl: 'https://gitlab.com'
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
      sealedPair: pair('gone'),
      axisBaseUrl: 'https://gitlab.com'
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
        sealedPair: pair('never'),
        axisBaseUrl: 'https://gitlab.com'
      })
    ).rejects.toThrow(GitlabMembershipGone)
    expect(await prisma.gitlabConnection.count({ where: { gitlabUserId: 780n } })).toBe(0)
  })
})
