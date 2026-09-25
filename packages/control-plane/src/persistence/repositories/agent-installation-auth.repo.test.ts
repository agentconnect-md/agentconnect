import { describe, expect, it, vi } from 'vitest'
import { AgentId } from '../../domain/ids.js'
import { PgAgentInstallationAuthorizationRepo } from './agent-installation-auth.repo.js'

const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const INSTALLATION = 12345n
const BUMP = { where: { id: { in: [AGENT] } }, data: { configRevision: { increment: 1 } } }

function transactionalDb(tx: object) {
  return { $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)) }
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ia-1',
    agentId: AGENT,
    provider: 'github',
    installationId: INSTALLATION,
    accountLogin: 'example-org',
    access: 'read',
    materialize: 'on_demand',
    createdByUserId: null,
    createdAt: new Date(0),
    createdBy: null,
    ...over
  }
}

/** One transaction client whose grant row is `current` and whose agent revision writes are recorded. */
function harness(current: ReturnType<typeof row> | null = row()) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: AGENT }]),
    agent: { updateMany: vi.fn(async () => ({ count: 1 })) },
    agentInstallationAuthorization: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      findUnique: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...current!, ...data })),
      // Honors the conditional writes' `access in` and `materialize not`, as Postgres would.
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { access?: { in: string[] }; materialize?: { not: string } }
          data: Record<string, unknown>
        }) => {
          if (!current) return { count: 0 }
          if (where.access && !where.access.in.includes(current.access)) return { count: 0 }
          if (where.materialize && current.materialize === where.materialize.not) return { count: 0 }
          current = { ...current, ...data }
          return { count: 1 }
        }
      ),
      deleteMany: vi.fn(async () => ({ count: current ? 1 : 0 }))
    }
  }
  return { tx, repo: new PgAgentInstallationAuthorizationRepo(transactionalDb(tx) as never) }
}

describe('installation grants (agent-multi-repo-authorization.md decision 10)', () => {
  it('creates a github grant as `on-demand` unless told otherwise, bumping the revision in the same transaction', async () => {
    const { tx, repo } = harness()
    const base = { agentId: AGENT, installationId: INSTALLATION, accountLogin: 'example-org', access: 'read' as const }

    const dflt = await repo.create(base)
    const decided = await repo.create({ ...base, access: 'comment', materialize: 'decision' })

    expect(tx.agentInstallationAuthorization.create.mock.calls.map(([arg]) => arg.data)).toEqual([
      expect.objectContaining({ provider: 'github', installationId: INSTALLATION, materialize: 'on_demand' }),
      expect.objectContaining({ access: 'comment', materialize: 'decision' })
    ])
    // The wire spelling comes back out, whatever the Prisma member is called.
    expect(dflt).toMatchObject({ provider: 'github', installationId: INSTALLATION, materialize: 'on-demand' })
    expect(decided).toMatchObject({ access: 'comment', materialize: 'decision' })
    expect(tx.agent.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.agent.updateMany).toHaveBeenCalledWith(BUMP)
  })

  it('an access raise or materialize change bumps the revision once; an unchanged or lower patch writes nothing', async () => {
    const { tx, repo } = harness()

    expect(await repo.update('ia-1', { access: 'read', materialize: 'on-demand' })).toMatchObject({ access: 'read' })
    expect(tx.agent.updateMany).not.toHaveBeenCalled()

    // Access is projected for a grant (unlike a repository row), so it advances the revision too.
    expect(await repo.update('ia-1', { access: 'write', materialize: 'decision' })).toMatchObject({
      access: 'write',
      materialize: 'decision'
    })
    expect(tx.agentInstallationAuthorization.updateMany).toHaveBeenCalledWith({
      where: { id: 'ia-1', access: { in: ['read', 'comment'] } },
      data: { access: 'write' }
    })
    expect(tx.agentInstallationAuthorization.updateMany).toHaveBeenCalledWith({
      where: { id: 'ia-1', materialize: { not: 'decision' } },
      data: { materialize: 'decision' }
    })
    expect(tx.agent.updateMany).toHaveBeenCalledOnce()
    expect(tx.agent.updateMany).toHaveBeenCalledWith(BUMP)

    // A stale lower tier writes nothing and keeps the revision.
    expect(await repo.update('ia-1', { access: 'comment' })).toMatchObject({ access: 'write' })
    expect(tx.agent.updateMany).toHaveBeenCalledOnce()
  })

  it('refreshes the projected account login only when it changed', async () => {
    const { tx, repo } = harness()

    await repo.updateAccountLogin('ia-1', 'example-org')
    expect(tx.agent.updateMany).not.toHaveBeenCalled()

    await repo.updateAccountLogin('ia-1', 'example-org-renamed')
    expect(tx.agentInstallationAuthorization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { accountLogin: 'example-org-renamed' } })
    )
    expect(tx.agent.updateMany).toHaveBeenCalledWith(BUMP)
  })

  it('a missing row updates to null and removes as false, touching no revision', async () => {
    const { tx, repo } = harness(null)

    expect(await repo.update('ia-1', { access: 'write' })).toBeNull()
    expect(await repo.remove('ia-1')).toBe(false)
    expect(tx.agent.updateMany).not.toHaveBeenCalled()
  })

  it('a removal bumps the owning agent’s revision in the same transaction', async () => {
    const { tx, repo } = harness()

    expect(await repo.remove('ia-1')).toBe(true)
    expect(tx.agentInstallationAuthorization.deleteMany).toHaveBeenCalledWith({ where: { id: 'ia-1' } })
    expect(tx.agent.updateMany).toHaveBeenCalledWith(BUMP)
  })
})
