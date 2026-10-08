// Unit tests for the repository-grant re-attestation loop: FakeClock cadence, verdicts, and the upstream-failure stop.
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentRepoAuthorizationRecord,
  GithubInstallationRecord,
  RepoGrantAttestationSubject,
  RepoGrantStaleReason
} from '../persistence/ports.js'
import { GithubApiError } from './api.js'
import { UserAuthzDeniedError } from './user-authz.js'
import {
  RepositoryGrantReattestor,
  strictRepoAccessLookups,
  type RepositoryGrantReattestorConfig
} from './repository-grant-reattestor.js'

const INTERVAL_MS = 10 * 60_000
const AFTER_MS = 24 * 60 * 60_000
const ORG = OrgId('org-a')

type Claimed = AgentRepoAuthorizationRecord & { orgId: OrgId }

function grant(over: Partial<Claimed> = {}): Claimed {
  return {
    id: 'ra-1',
    agentId: AgentId('agent-1'),
    orgId: ORG,
    provider: 'github',
    repoId: 111n,
    repoFullName: 'acme/tools',
    access: 'read',
    materialize: 'always',
    createdAt: new Date(0),
    createdBy: null,
    attestedByUserId: 'user-1',
    stale: null,
    ...over
  }
}

function installation(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
  return {
    id: 'row-1',
    orgId: ORG,
    installationId: 42n,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    permissions: {},
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date(0),
    ...over
  }
}

// A real macrotask so an armed sweep's awaited chain drains before the assertions.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function setup(
  opts: {
    queue?: Claimed[]
    assertAccess?: (userId: string, need: 'read' | 'write') => Promise<unknown>
    installation?: GithubInstallationRecord | null
    repoId?: bigint | null
    flipped?: boolean
    cfg?: Partial<RepositoryGrantReattestorConfig>
  } = {}
) {
  const clock = new FakeClock(1_700_000_000_000)
  const queue = [...(opts.queue ?? [grant()])]
  const claims: Array<{ provider: string; checkedBefore: Date; now: Date }> = []
  const recorded: Array<{
    id: string
    subject: RepoGrantAttestationSubject
    verdict: RepoGrantStaleReason | null
  }> = []
  const needs: Array<{ userId: string; need: 'read' | 'write'; repo: string }> = []
  const audits: unknown[] = []
  const reproject = vi.fn(async () => {})
  const repoLookups = vi.fn(async () =>
    opts.repoId === null
      ? null
      : { repoId: opts.repoId ?? 111n, fullName: 'acme/tools', private: true, defaultBranch: 'main' }
  )
  const reattestor = new RepositoryGrantReattestor(
    {
      grants: {
        claimDueForReattestation: async (provider, checkedBefore, now) => {
          claims.push({ provider, checkedBefore, now })
          return queue.shift() ?? null
        },
        recordAttestation: async (id, subject, verdict) => {
          recorded.push({ id, subject, verdict })
          return opts.flipped ?? false
        }
      },
      installations: {
        liveByOrgAndAccount: async () => (opts.installation === undefined ? installation() : opts.installation)
      },
      github: { repoRefForCommentAuthz: repoLookups },
      authz: {
        assertAccess: async (userId, _ins, owner, repo, need) => {
          needs.push({ userId, need, repo: `${owner}/${repo}` })
          return (await opts.assertAccess?.(userId, need)) as never
        }
      },
      audit: {
        append: async (input) => {
          audits.push(input)
          return {} as never
        }
      },
      reproject,
      clock
    },
    { intervalMs: INTERVAL_MS, reattestAfterMs: AFTER_MS, batch: 25, ...opts.cfg }
  )
  return { clock, reattestor, claims, recorded, needs, audits, reproject, repoLookups }
}

describe('RepositoryGrantReattestor', () => {
  it('start() arms one sweep per interval; stop() cancels it', async () => {
    const { clock, reattestor, claims } = setup({ queue: [] })
    reattestor.start()
    expect(clock.pendingTimers()).toBe(1)

    clock.advance(INTERVAL_MS - 1)
    expect(claims).toHaveLength(0)
    clock.advance(1)
    await flush()
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ provider: 'github' })
    expect(claims[0]!.checkedBefore.getTime()).toBe(clock.now() - AFTER_MS)

    clock.advance(INTERVAL_MS)
    await flush()
    expect(claims).toHaveLength(2)

    reattestor.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('a member who still has access keeps the grant honored, checked at the tier the grant needs', async () => {
    const { reattestor, recorded, needs, audits, reproject } = setup({
      queue: [grant({ access: 'comment' }), grant({ id: 'ra-2', access: 'write' })]
    })

    const sweep = await reattestor.sweep()

    expect(sweep).toMatchObject({ checked: 2, held: 2, stale: 0, flipped: 0, deferred: false })
    expect(needs.map((n) => n.need)).toEqual(['read', 'write'])
    expect(recorded.map((r) => r.verdict)).toEqual([null, null])
    expect(recorded[1]!.subject).toEqual({ attestedByUserId: 'user-1', access: 'write' })
    expect(audits).toEqual([])
    expect(reproject).not.toHaveBeenCalled()
  })

  it.each([
    ['USER_NO_ACCESS', 'access_lost'],
    ['GITHUB_IDENTITY_REQUIRED', 'identity_unlinked']
  ] as const)('a %s denial marks the grant %s, audits it and re-pushes the spec', async (code, reason) => {
    const { reattestor, recorded, audits, reproject } = setup({
      flipped: true,
      assertAccess: async () => {
        throw new UserAuthzDeniedError('denied', code)
      }
    })

    const sweep = await reattestor.sweep()

    expect(sweep).toMatchObject({ checked: 1, stale: 1, flipped: 1 })
    expect(recorded).toEqual([{ id: 'ra-1', subject: { attestedByUserId: 'user-1', access: 'read' }, verdict: reason }])
    expect(audits).toEqual([
      expect.objectContaining({
        kind: 'agent_repo_change',
        orgId: ORG,
        agentId: 'agent-1',
        details: expect.objectContaining({ repoAuthId: 'ra-1', staleReason: reason })
      })
    ])
    expect(reproject).toHaveBeenCalledWith(ORG, 'agent-1')
  })

  it('a grant whose attester was removed goes stale without asking GitHub', async () => {
    const { reattestor, recorded, repoLookups, needs } = setup({ queue: [grant({ attestedByUserId: null })] })

    await reattestor.sweep()

    expect(recorded.map((r) => r.verdict)).toEqual(['attester_removed'])
    expect(repoLookups).not.toHaveBeenCalled()
    expect(needs).toEqual([])
  })

  it('an unreachable host marks nothing and stops the sweep', async () => {
    const { reattestor, recorded, claims } = setup({
      queue: [grant(), grant({ id: 'ra-2' })],
      assertAccess: async () => {
        throw new GithubApiError('upstream unavailable', 503, 'INTERNAL', true)
      }
    })

    const sweep = await reattestor.sweep()

    expect(sweep).toMatchObject({ checked: 1, deferred: true, stale: 0, held: 0 })
    expect(recorded).toEqual([])
    expect(claims).toHaveLength(1)
  })

  it('a missing installation or a repository that no longer resolves is left to the mint gate', async () => {
    const noInstallation = setup({ installation: null })
    const suspended = setup({ installation: installation({ suspendedAt: new Date(0) }) })
    const reused = setup({ repoId: 999n })
    const gone = setup({ repoId: null })

    for (const run of [noInstallation, suspended, reused, gone]) {
      expect(await run.reattestor.sweep()).toMatchObject({ checked: 1, skipped: 1 })
      expect(run.recorded).toEqual([])
      expect(run.needs).toEqual([])
    }
  })

  it('checks at most `batch` grants per sweep', async () => {
    const queue = Array.from({ length: 5 }, (_, i) => grant({ id: `ra-${i}` }))
    const { reattestor, recorded } = setup({ queue, cfg: { batch: 3 } })

    expect(await reattestor.sweep()).toMatchObject({ checked: 3 })
    expect(recorded.map((r) => r.id)).toEqual(['ra-0', 'ra-1', 'ra-2'])
  })
})

describe('strictRepoAccessLookups', () => {
  it('reads the privacy flag and folds triage into read, as the creation gate does', async () => {
    const lookups = strictRepoAccessLookups({
      repoRefForCommentAuthz: async () => ({
        repoId: 1n,
        fullName: 'acme/tools',
        private: false,
        defaultBranch: 'main'
      }),
      userRepoPermissionForCommentAuthz: async () => 'triage'
    })

    await expect(lookups.getRepoMeta(installation(), 'acme', 'tools')).resolves.toEqual({ private: false })
    await expect(lookups.userRepoPermission(installation(), 'acme', 'tools', 'octocat')).resolves.toBe('read')
  })

  it('lets a credential failure through instead of reading it as no access', async () => {
    const failure = new GithubApiError('bad credentials', 401, 'LEASE_DENIED', false)
    const lookups = strictRepoAccessLookups({
      repoRefForCommentAuthz: async () => {
        throw failure
      },
      userRepoPermissionForCommentAuthz: async () => 'none'
    })

    await expect(lookups.getRepoMeta(installation(), 'acme', 'tools')).rejects.toBe(failure)
  })
})
