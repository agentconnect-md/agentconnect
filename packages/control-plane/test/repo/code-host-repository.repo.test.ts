import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgCodeHostRepositoryRepo } from '../../src/persistence/repositories/code-host-repository.repo.js'

const REPO_ID = 987654321n

describe('PgCodeHostRepositoryRepo (gitlab-com-integration.md §8.1)', () => {
  it('upserts convergently: one row per (org, provider, externalId), hints refreshed', async () => {
    const repo = new PgCodeHostRepositoryRepo(prisma)
    const first = await repo.upsert({
      orgId: DEFAULT_ORG_ID,
      provider: 'github',
      externalId: REPO_ID,
      displayPath: 'acme/infra',
      cloneUrl: 'https://github.com/acme/infra'
    })
    expect(first.defaultBranch).toBeNull()

    // A rename refreshes the mutable hints; the numeric identity and row survive.
    const renamed = await repo.upsert({
      orgId: DEFAULT_ORG_ID,
      provider: 'github',
      externalId: REPO_ID,
      displayPath: 'acme/platform',
      cloneUrl: 'https://github.com/acme/platform',
      defaultBranch: 'main'
    })
    expect(renamed.id).toBe(first.id)
    expect(renamed.displayPath).toBe('acme/platform')
    expect(renamed.defaultBranch).toBe('main')

    // A partial upsert keeps hints it does not carry.
    const partial = await repo.upsert({
      orgId: DEFAULT_ORG_ID,
      provider: 'github',
      externalId: REPO_ID,
      displayPath: 'acme/platform'
    })
    expect(partial.cloneUrl).toBe('https://github.com/acme/platform')
    expect(partial.defaultBranch).toBe('main')

    expect(await repo.byExternalId(DEFAULT_ORG_ID, 'github', REPO_ID)).toMatchObject({ id: first.id })
    expect(await repo.byExternalId(DEFAULT_ORG_ID, 'gitlab', REPO_ID)).toBeNull()
  })

  it('keys per provider: the same numeric id under gitlab is a distinct row', async () => {
    const repo = new PgCodeHostRepositoryRepo(prisma)
    await repo.upsert({
      orgId: DEFAULT_ORG_ID,
      provider: 'github',
      externalId: REPO_ID,
      displayPath: 'acme/infra'
    })
    await repo.upsert({
      orgId: DEFAULT_ORG_ID,
      provider: 'gitlab',
      externalId: REPO_ID,
      displayPath: 'example-group/sub/example-project'
    })
    const rows = await repo.listForOrg(DEFAULT_ORG_ID)
    expect(rows.map((r) => `${r.provider}:${r.externalId}`).sort()).toEqual([`github:${REPO_ID}`, `gitlab:${REPO_ID}`])
  })
})
