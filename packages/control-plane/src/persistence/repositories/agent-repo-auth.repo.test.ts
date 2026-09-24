import { describe, expect, it, vi } from 'vitest'
import { AgentId } from '../../domain/ids.js'
import { AgentWorkspaceRepoConflict } from '../errors.js'
import { PgAgentRepoAuthorizationRepo } from './agent-repo-auth.repo.js'
import { PgAgentRepo } from './agent.repo.js'

const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const REPO = 42n

function transactionalDb(tx: object) {
  return {
    $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx))
  }
}

describe('workspace repository identity and additional grants', () => {
  it('repairs the numeric workspace id and removes a redundant grant without projection cleanup', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      agent: {
        findUnique: vi.fn(async () => ({
          workspaceMode: 'git',
          gitCredentialProvider: 'github',
          workspaceRepoId: null,
          gitRepo: 'https://github.com/acme/infra'
        })),
        update: vi.fn(async () => ({}))
      },
      agentRepoAuthorization: { deleteMany: vi.fn(async () => ({ count: 1 })) }
    }
    const repo = new PgAgentRepo(transactionalDb(tx) as never)

    await expect(repo.setWorkspaceRepoId(AGENT, REPO)).resolves.toBe(true)
    // The repair also advances the agent's configuration revision: `gitRepo`
    // identity feeds AgentSpec.workspace, so it joins the single ordering domain
    // the daemon's revision fence compares (organization-secrets-and-variables.md §5).
    expect(tx.agent.update).toHaveBeenCalledWith({
      where: { id: AGENT },
      data: { workspaceRepoId: REPO, configRevision: { increment: 1 } }
    })
    expect(tx.agentRepoAuthorization.deleteMany).toHaveBeenCalledWith({
      where: { agentId: AGENT, provider: 'github', repoId: REPO }
    })
    // No HookReviewProjection operation is part of redundant-grant repair.
    expect(Object.hasOwn(tx, 'hookReviewProjection')).toBe(false)
  })

  it('refuses to recreate an additional grant after workspace repair wins the shared lock', async () => {
    const create = vi.fn()
    const tx = {
      $queryRaw: vi.fn(async () => []),
      agent: { findUnique: vi.fn(async () => ({ gitCredentialProvider: 'github', workspaceRepoId: REPO })) },
      agentRepoAuthorization: { create }
    }
    const repo = new PgAgentRepoAuthorizationRepo(transactionalDb(tx) as never)

    await expect(
      repo.create({ agentId: AGENT, provider: 'github', repoId: REPO, repoFullName: 'acme/infra', access: 'write' })
    ).rejects.toBeInstanceOf(AgentWorkspaceRepoConflict)
    expect(create).not.toHaveBeenCalled()
  })

  it('lets a gitlab grant name the numeric id a github workspace already holds', async () => {
    const create = vi.fn(async () => ({
      id: 'ra-1',
      agentId: AGENT,
      provider: 'gitlab',
      repoId: REPO,
      repoFullName: 'example-group/example-project',
      access: 'read',
      createdAt: new Date(0),
      createdBy: null
    }))
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: AGENT }]),
      agent: {
        findUnique: vi.fn(async () => ({ gitCredentialProvider: 'github', workspaceRepoId: REPO })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      agentRepoAuthorization: { create }
    }
    const repo = new PgAgentRepoAuthorizationRepo(transactionalDb(tx) as never)

    await repo.create({
      agentId: AGENT,
      provider: 'gitlab',
      repoId: REPO,
      repoFullName: 'example-group/example-project',
      access: 'read'
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('stores a grant as `always` unless told otherwise, spelling `on-demand` the Prisma way', async () => {
    const created: Array<Record<string, unknown>> = []
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: AGENT }]),
      agent: {
        findUnique: vi.fn(async () => ({ gitCredentialProvider: 'github', workspaceRepoId: 7n })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      agentRepoAuthorization: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data)
          return { id: 'ra-1', ...data, createdAt: new Date(0), createdBy: null }
        })
      }
    }
    const repo = new PgAgentRepoAuthorizationRepo(transactionalDb(tx) as never)
    const base = { agentId: AGENT, provider: 'github' as const, repoId: REPO, repoFullName: 'acme/infra' }

    const dflt = await repo.create({ ...base, access: 'read' })
    const onDemand = await repo.create({ ...base, access: 'read', materialize: 'on-demand' })

    expect(created.map((d) => d.materialize)).toEqual(['always', 'on_demand'])
    expect(dflt.materialize).toBe('always')
    expect(onDemand.materialize).toBe('on-demand')
  })

  it('a materialize change advances the agent’s config revision in the same transaction; an unchanged one does not', async () => {
    const row = {
      id: 'ra-1',
      agentId: AGENT,
      provider: 'github',
      repoId: REPO,
      repoFullName: 'acme/infra',
      access: 'read',
      materialize: 'always',
      createdAt: new Date(0),
      createdBy: null
    }
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: AGENT }]),
      agent: { updateMany: vi.fn(async () => ({ count: 1 })) },
      agentRepoAuthorization: {
        findUnique: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: { materialize: string } }) => ({ ...row, ...data }))
      }
    }
    const repo = new PgAgentRepoAuthorizationRepo(transactionalDb(tx) as never)

    expect(await repo.updateMaterialize('ra-1', 'always')).toMatchObject({ materialize: 'always' })
    expect(tx.agentRepoAuthorization.update).not.toHaveBeenCalled()
    expect(tx.agent.updateMany).not.toHaveBeenCalled()

    expect(await repo.updateMaterialize('ra-1', 'on-demand')).toMatchObject({ materialize: 'on-demand' })
    expect(tx.agentRepoAuthorization.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ra-1' }, data: { materialize: 'on_demand' } })
    )
    expect(tx.agent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [AGENT] } },
      data: { configRevision: { increment: 1 } }
    })
  })

  it('an access-only change leaves the config revision alone — the tier is not on the spec', async () => {
    const db = {
      agentRepoAuthorization: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({
          id: 'ra-1',
          agentId: AGENT,
          provider: 'github',
          repoId: REPO,
          repoFullName: 'acme/infra',
          access: 'write',
          materialize: 'always',
          createdAt: new Date(0),
          createdBy: null
        }))
      },
      agent: { updateMany: vi.fn() }
    }
    const repo = new PgAgentRepoAuthorizationRepo(db as never)

    expect(await repo.updateAccess('ra-1', 'write')).toMatchObject({ access: 'write', materialize: 'always' })
    expect(db.agent.updateMany).not.toHaveBeenCalled()
  })

  it('deletes a redundant workspace grant without tombstoning live projections', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      agent: { findUnique: vi.fn(async () => ({ gitCredentialProvider: 'github', workspaceRepoId: REPO })) },
      agentRepoAuthorization: { deleteMany: vi.fn(async () => ({ count: 1 })) }
    }
    const repo = new PgAgentRepoAuthorizationRepo(transactionalDb(tx) as never)

    await repo.removeWithReviewProjectionCleanup(
      '22222222-2222-4222-8222-222222222222',
      AGENT,
      'github',
      REPO,
      new Date('2026-07-11T00:00:00.000Z'),
      'failure'
    )
    expect(tx.agentRepoAuthorization.deleteMany).toHaveBeenCalledOnce()
    expect(Object.hasOwn(tx, 'hookReviewProjection')).toBe(false)
  })
})
