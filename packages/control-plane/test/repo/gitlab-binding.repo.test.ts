/**
 * Project binding + claim transaction (gitlab-com-integration.md §8.1/§10.2)
 * and the purpose-separated credential stores (§7.3): the deployment-global
 * claim races to one winner, rotation advances generations, and sealed values
 * stay behind their stores.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import {
  PgGitlabAgentAccountRepo,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/repositories/gitlab.repo.js'
import { GitlabProjectClaimConflict } from '../../src/persistence/errors.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const bindings = () => new PgGitlabProjectBindingRepo(prisma)
const accounts = () => new PgGitlabAgentAccountRepo(prisma)
const PROJECT = 4455667n
const ROOT_GROUP = 900n

/** One agent account in the project's root, bound to the given binding (§7.2). */
async function boundAccount(orgId: string, bindingId: string, agentId = randomUUID()) {
  const account = await accounts().ensure({
    orgId,
    agentId,
    rootGroupId: ROOT_GROUP,
    username: `agentconnect-a${agentId.replace(/-/g, '')}-g${ROOT_GROUP}`,
    administeringConnectionId: null
  })
  await accounts().update(account.id, { serviceAccountUserId: 9042n, state: 'ready' })
  await accounts().attachMembership({
    accountId: account.id,
    generation: account.generation,
    bindingId,
    accessLevel: 30
  })
  return account
}

async function otherOrg(): Promise<string> {
  const id = `org-${randomUUID().slice(0, 8)}`
  await prisma.org.create({ data: { id, name: id, slug: id } })
  return id
}

function input(orgId: string) {
  return {
    orgId,
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    defaultBranch: 'main',
    cloneUrl: 'https://gitlab.com/example-group/example-project.git',
    installerConnectionId: randomUUID(),
    axisBaseUrl: 'https://gitlab.com'
  }
}

let nextGitlabUserId = 9000n
async function withConnection(orgId: string) {
  // installerConnectionId references gitlab_connection — create a real one.
  const connection = await prisma.gitlabConnection.create({
    data: {
      orgId,
      gitlabUserId: ++nextGitlabUserId,
      gitlabUsername: 'example-admin',
      state: 'connected'
    }
  })
  return { ...input(orgId), installerConnectionId: connection.id }
}

describe('PgGitlabProjectBindingRepo (§10.2 claim transaction)', () => {
  it('two organizations racing one project: exactly one claim winner, loser mutates nothing', async () => {
    const orgB = await otherOrg()
    const [a, b] = await Promise.allSettled([
      bindings().createWithClaim(await withConnection(DEFAULT_ORG_ID)),
      bindings().createWithClaim(await withConnection(orgB))
    ])
    const winners = [a, b].filter((r) => r.status === 'fulfilled')
    const losers = [a, b].filter((r) => r.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(GitlabProjectClaimConflict)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab', externalId: PROJECT } })).toBe(1)
    expect(await prisma.gitlabProjectBinding.count()).toBe(1)
    const claim = await prisma.codeHostRepositoryClaim.findFirstOrThrow({ where: { provider: 'gitlab' } })
    const binding = await prisma.gitlabProjectBinding.findFirstOrThrow({})
    expect(claim.bindingRef).toBe(binding.id)
    expect(claim.orgId).toBe(binding.orgId)
  })

  it('bumpCredentialEpoch is the org-fenced purge fence', async () => {
    const created = await bindings().createWithClaim(await withConnection(DEFAULT_ORG_ID))
    expect(await bindings().bumpCredentialEpoch('not-the-org', created.id)).toBeNull()
    expect(await bindings().bumpCredentialEpoch(DEFAULT_ORG_ID, created.id)).toBe(created.credentialEpoch + 1n)
  })
})

describe('credential + webhook secret stores (§7.3)', () => {
  it('rotation commits metadata, sealed value, and the epoch fence atomically', async () => {
    const binding = await bindings().createWithClaim(await withConnection(DEFAULT_ORG_ID))
    const account = await boundAccount(DEFAULT_ORG_ID, binding.id)
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)
    const first = await creds.commitRotation({
      accountId: account.id,
      purpose: 'read',
      externalTokenId: 111n,
      scopes: ['read_api', 'read_repository'],
      providerExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
      sealedToken: 'glpat-read-1'
    })
    expect(await store.get(DEFAULT_ORG_ID, first.id)).toBe('glpat-read-1')
    const rotated = await creds.commitRotation({
      accountId: account.id,
      purpose: 'read',
      externalTokenId: 222n,
      scopes: ['read_api', 'read_repository'],
      providerExpiresAt: new Date('2027-02-18T00:00:00.000Z'),
      sealedToken: 'glpat-read-2'
    })
    expect(rotated.id).toBe(first.id)
    expect(rotated.generation).toBe(first.generation + 1n)
    expect(rotated.externalTokenId).toBe(222n)
    expect(await store.get(DEFAULT_ORG_ID, first.id)).toBe('glpat-read-2')
    // Each rotation advanced the ACCOUNT's purge fence with it (§7.2).
    expect((await accounts().get(account.id))!.credentialEpoch).toBe(account.credentialEpoch + 2n)
    // Org fence on the sealed value.
    expect(await store.get('not-the-org', first.id)).toBeNull()
    expect((await creds.listForAccount(account.id)).map((c) => c.purpose)).toEqual(['read'])
  })

  it('organization deletion releases an unmutated claim and tombstones a mutated one', async () => {
    // Unmutated: no provider resource was ever created — the claim frees the project.
    const orgA = await otherOrg()
    await bindings().createWithClaim(await withConnection(orgA))
    await prisma.org.delete({ where: { id: orgA } })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab', externalId: PROJECT } })).toBe(0)

    // Mutated: provider facts exist — the claim survives, detached, with the
    // metadata-only cleanup tombstone (§10.2/§19.4).
    const orgB = await otherOrg()
    const bound = await bindings().createWithClaim(await withConnection(orgB))
    await bindings().update(orgB, bound.id, { webhookId: 7n })
    const account = await boundAccount(orgB, bound.id)
    await new PgGitlabProjectCredentialRepo(prisma).commitRotation({
      accountId: account.id,
      purpose: 'effect',
      externalTokenId: 333n,
      scopes: ['api'],
      providerExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
      sealedToken: 'glpat-effect'
    })
    await prisma.org.delete({ where: { id: orgB } })
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitlab', externalId: PROJECT } }
    })
    expect(claim.state).toBe('cleanup_pending')
    expect(claim.bindingRef).toBeNull()
    expect(claim.tombstone).toMatchObject({
      serviceAccountUserIds: [9042],
      webhookId: '7',
      externalTokenIds: [333]
    })
  })

  it('a crash before any external id lands still tombstones once mutation was marked (§10.2)', async () => {
    // The saga durably flips the claim out of `provisioning` BEFORE its first
    // provider write; a binding that dies with all-null external ids must then
    // tombstone, never release.
    const orgC = await otherOrg()
    const bound = await bindings().createWithClaim(await withConnection(orgC))
    await bindings().markProviderMutationStarted(
      orgC,
      bound.id,
      PROJECT,
      'crashed-run',
      new Date(Date.now() + 600_000),
      new Date()
    )
    await prisma.org.delete({ where: { id: orgC } })
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitlab', externalId: PROJECT } }
    })
    expect(claim.state).toBe('cleanup_pending')
    expect(claim.bindingRef).toBeNull()
  })

  it('seals the webhook signing key behind its store, org-fenced', async () => {
    const binding = await bindings().createWithClaim(await withConnection(DEFAULT_ORG_ID))
    const store = new PgGitlabWebhookSecretStore(prisma, cipher)
    await store.put(DEFAULT_ORG_ID, binding.id, 'whsec_example')
    expect(await store.get(DEFAULT_ORG_ID, binding.id)).toBe('whsec_example')
    expect(await store.get('not-the-org', binding.id)).toBeNull()
    await store.delete(DEFAULT_ORG_ID, binding.id)
    expect(await store.get(DEFAULT_ORG_ID, binding.id)).toBeNull()
  })
})
