import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import type { ExternalScopeRecord, GithubInstallationRecord } from '../persistence/ports.js'
import { UserAuthzDeniedError } from '../github/user-authz.js'
import type { SessionAccessViewer } from './session-access-plugin.js'
import { GithubSessionAccessService } from './github-session-access.js'

const installation: GithubInstallationRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org_1' as GithubInstallationRecord['orgId'],
  installationId: 456n,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all',
  permissions: { metadata: 'read' },
  suspendedAt: null,
  revokedAt: null,
  createdAt: new Date(0)
}

const scope: ExternalScopeRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: installation.orgId,
  provider: 'github',
  realmKey: 'github.com',
  resourceKind: 'repository',
  resourceKey: '123',
  credentialKind: 'github_installation',
  credentialId: installation.id,
  aclRevision: 2n,
  revokedAt: null
}

function scopeAt(index: number): ExternalScopeRecord {
  return {
    ...scope,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    resourceKey: String(index)
  }
}

function make(privateRepo: boolean, permissionForUser = vi.fn()) {
  const clock = new FakeClock()
  const repoRefById = vi.fn().mockResolvedValue({
    repoId: 123n,
    fullName: 'acme/private-repo',
    private: privateRepo,
    defaultBranch: 'main'
  })
  const service = new GithubSessionAccessService({
    installations: { get: vi.fn().mockResolvedValue(installation) } as never,
    github: { repoRefById },
    userAuthz: { permissionForUser },
    clock
  })
  return { service, repoRefById, permissionForUser, clock }
}

const viewer: SessionAccessViewer = {
  request: {} as never,
  orgId: installation.orgId,
  userId: 'user-1',
  identitySet: new Set(['user:user-1'])
}

/** A second console user asking about the same repository. */
const other: SessionAccessViewer = { ...viewer, userId: 'user-2', identitySet: new Set(['user:user-2']) }

describe('GithubSessionAccessService', () => {
  it('resolves allowed scopes beyond the first 200', async () => {
    const h = make(false)
    const scopes = Array.from({ length: 201 }, (_, index) => scopeAt(index + 1))

    const result = await h.service.resolve(scopes, viewer)

    expect(result.degraded).toBe(false)
    expect(result.allowedScopes).toHaveLength(201)
    expect(result.allowedScopes.at(-1)).toEqual({ id: scopes[200]!.id, aclRevision: scopes[200]!.aclRevision })
  })

  it('allows an org member to read a public repository session without a linked GitHub identity', async () => {
    const h = make(false)

    await expect(h.service.resolve([scope], viewer)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    expect(h.permissionForUser).not.toHaveBeenCalled()
  })

  it('requires the linked user to retain read access to a private repository', async () => {
    const allowed = make(true, vi.fn().mockResolvedValue('read'))
    const denied = make(
      true,
      vi.fn().mockRejectedValue(new UserAuthzDeniedError('GitHub identity required', 'GITHUB_IDENTITY_REQUIRED'))
    )

    expect((await allowed.service.resolve([scope], viewer)).allowedScopes).toHaveLength(1)
    expect(allowed.permissionForUser).toHaveBeenCalledWith('user-1', installation, 'acme', 'private-repo', {
      maxCacheAgeMs: 0
    })
    await expect(denied.service.resolve([scope], viewer)).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
  })

  it('refreshes an allowed provider decision at the 120 second hard limit', async () => {
    const h = make(true, vi.fn().mockResolvedValue('read'))

    await h.service.resolve([scope], viewer)
    h.clock.advance(119_999)
    await h.service.resolve([scope], viewer)
    expect(h.permissionForUser).toHaveBeenCalledTimes(1)

    h.clock.advance(1)
    await h.service.resolve([scope], viewer)
    expect(h.permissionForUser).toHaveBeenCalledTimes(2)
  })

  it('fails closed and reports degradation when GitHub cannot resolve the current repository', async () => {
    const h = make(true)
    h.repoRefById.mockRejectedValue(new Error('provider unavailable'))

    await expect(h.service.resolve([scope], viewer)).resolves.toEqual({
      allowedScopes: [],
      degraded: true
    })
  })

  it('reads a repository shape once for every viewer that asks about it', async () => {
    const h = make(false)

    await h.service.resolve([scope], viewer)
    await h.service.resolve([scope], other)

    // The decision cache is keyed per user, but "is this repo public" is not a
    // question about the user — so the second viewer must not pay a lookup.
    expect(h.repoRefById).toHaveBeenCalledTimes(1)
  })

  it('leases an allow from when the shape was observed, not from when it was reused', async () => {
    const h = make(false)

    await h.service.resolve([scope], viewer)
    h.clock.advance(60_000)
    await h.service.resolve([scope], other)
    expect(h.repoRefById).toHaveBeenCalledTimes(1)

    // 120 s after the SHAPE was fetched. Had reuse restarted the lease, the
    // second viewer's allow would still be cached here and nothing would be
    // re-read; instead both the verdict and its evidence have expired.
    h.clock.advance(60_001)
    await h.service.resolve([scope], other)
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed shape lookup a per-request verdict rather than caching it', async () => {
    const h = make(false)
    h.repoRefById.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(h.service.resolve([scope], viewer)).resolves.toEqual({ allowedScopes: [], degraded: true })
    await expect(h.service.resolve([scope], other)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
  })
})
