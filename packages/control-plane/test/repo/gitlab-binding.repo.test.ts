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
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/repositories/gitlab.repo.js'
import { GitlabProjectClaimConflict } from '../../src/persistence/errors.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const bindings = () => new PgGitlabProjectBindingRepo(prisma)
const PROJECT = 4455667n

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
    installerConnectionId: randomUUID()
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
  it('rotation replaces per (binding, purpose) and advances the generation', async () => {
    const binding = await bindings().createWithClaim(await withConnection(DEFAULT_ORG_ID))
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)
    const first = await creds.upsert({
      bindingId: binding.id,
      purpose: 'read',
      externalTokenId: 111n,
      scopes: ['read_api', 'read_repository'],
      providerExpiresAt: new Date('2026-11-20T00:00:00.000Z')
    })
    await store.put(DEFAULT_ORG_ID, first.id, 'glpat-read-1')
    const rotated = await creds.upsert({
      bindingId: binding.id,
      purpose: 'read',
      externalTokenId: 222n,
      scopes: ['read_api', 'read_repository'],
      providerExpiresAt: new Date('2027-02-18T00:00:00.000Z')
    })
    expect(rotated.id).toBe(first.id)
    expect(rotated.generation).toBe(first.generation + 1n)
    await store.put(DEFAULT_ORG_ID, first.id, 'glpat-read-2')
    expect(await store.get(DEFAULT_ORG_ID, first.id)).toBe('glpat-read-2')
    // Org fence on the sealed value.
    expect(await store.get('not-the-org', first.id)).toBeNull()
    expect((await creds.listForBinding(binding.id)).map((c) => c.purpose)).toEqual(['read'])
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
