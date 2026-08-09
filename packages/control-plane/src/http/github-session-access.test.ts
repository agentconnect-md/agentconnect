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

/** `Clock` reports wall-clock epoch milliseconds, and the verdict caches need
 *  it to: lru-cache reads a falsy entry start as "no TTL recorded", so a clock
 *  left at 0 would make the first entries immortal and hide every expiry
 *  assertion below. */
const EPOCH = 1_777_000_000_000

function make(privateRepo: boolean, permissionForUser = vi.fn(), ttls?: { recheckMs?: number; publicTtlMs?: number }) {
  const clock = new FakeClock(EPOCH)
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
    clock,
    ...(ttls ?? {})
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
const third: SessionAccessViewer = { ...viewer, userId: 'user-3', identitySet: new Set(['user:user-3']) }

const PRIVATE_SHAPE = { repoId: 123n, fullName: 'acme/private-repo', private: true, defaultBranch: 'main' }

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
    // The permission itself is demanded age-zero; the login resolution rides
    // the same 120 s identity lease as the Slack/Feishu session-access checks.
    expect(allowed.permissionForUser).toHaveBeenCalledWith('user-1', installation, 'acme', 'private-repo', {
      maxCacheAgeMs: 0,
      loginMaxAgeMs: 120_000
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

    // The lease boundary is exclusive — an entry goes stale once its age passes
    // the TTL, so the refresh lands the millisecond after the limit.
    h.clock.advance(2)
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

  // The §2 verdict split (session-access-cold-visit.md): a public shape serves
  // for the long lease with §4.2(5) touch-revalidation past the recheck
  // threshold; a private (or out-of-grant) shape stays on the short lease.
  it('serves a public shape at 50 minutes and corrects it through the background re-observation', async () => {
    const h = make(false, vi.fn().mockResolvedValue('read'))

    await h.service.resolve([scope], viewer)
    expect(h.repoRefById).toHaveBeenCalledTimes(1)

    // The repository goes private; the leased public shape keeps serving —
    // with no identity check, which is what the long lease routes around.
    h.repoRefById.mockResolvedValue(PRIVATE_SHAPE)
    h.clock.advance(50 * 60_000)
    await expect(h.service.resolve([scope], other)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    expect(h.permissionForUser).not.toHaveBeenCalled()

    // The same read fired one re-observation; once it lands, the next viewer
    // routes through the permission check.
    await h.service.settle()
    expect(h.service.stats.shapeRevalidations).toBe(1)
    await h.service.resolve([scope], third)
    expect(h.permissionForUser).toHaveBeenCalledTimes(1)
  })

  it('blocks on a fresh shape read past the public serving ceiling', async () => {
    const h = make(false, vi.fn().mockResolvedValue('read'))

    await h.service.resolve([scope], viewer)
    h.repoRefById.mockResolvedValue(PRIVATE_SHAPE)
    h.clock.advance(3_600_001)

    // Past the ceiling the conversion governs THIS read: the fresh private
    // shape demands the permission check before anything serves.
    await h.service.resolve([scope], viewer)
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
    expect(h.permissionForUser).toHaveBeenCalledTimes(1)
    expect(h.service.stats.shapeRevalidations).toBe(0)
  })

  it('keeps a private shape on the recheck lease', async () => {
    const h = make(true, vi.fn().mockResolvedValue('read'))

    await h.service.resolve([scope], viewer)
    h.clock.advance(119_999)
    await h.service.resolve([scope], other)
    expect(h.repoRefById).toHaveBeenCalledTimes(1)

    h.clock.advance(2)
    await h.service.resolve([scope], third)
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
    expect(h.service.stats.shapeRevalidations).toBe(0)
  })

  // §2.2: the allow anchors to the per-viewer check it just ran; leasing it
  // from the warmed shape observation would mint it born expired and disable
  // the decision cache for exactly the warmed-public population.
  it('serves an allow built on an aged public shape for its full lease', async () => {
    const h = make(false, vi.fn().mockResolvedValue('read'))

    await h.service.resolve([scope], viewer)
    h.clock.advance(45 * 60_000)
    await h.service.resolve([scope], other)

    h.clock.advance(60_000)
    await expect(h.service.resolve([scope], other)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    // Both later reads ride the served shape (plus its one re-observation) —
    // never a foreground refetch per request.
    await h.service.settle()
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
    expect(h.service.stats.shapeRevalidations).toBe(1)
  })

  // The other face of §2.2: even once the shape entry itself lapses, an allow
  // inside its own lease keeps answering — under the old evidence-anchored
  // lease it was born expired and this read would refetch the shape.
  it('keeps the allow lease anchored to the viewer check when the shape entry lapses', async () => {
    const h = make(false, vi.fn(), { publicTtlMs: 300_000 })

    await h.service.resolve([scope], viewer)
    h.repoRefById.mockRejectedValueOnce(new Error('provider unavailable'))
    h.clock.advance(240_000)
    // Serves the aged public shape; the re-observation fails, so the entry
    // keeps its original observation time and lapses at the 300 s ceiling.
    await h.service.resolve([scope], other)
    await h.service.settle()

    h.clock.advance(61_000)
    await expect(h.service.resolve([scope], other)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
  })

  // A private-repo allow is identity-backed: the key carries only the local user
  // id, and link/unlink invalidates the identity caches, never this one — so the
  // recheck knob must not stretch the allow past the provider-identity lease.
  it('caps an identity-backed allow at the provider-identity lease under a long recheck', async () => {
    const h = make(true, vi.fn().mockResolvedValue('read'), { recheckMs: 600_000 })

    await h.service.resolve([scope], viewer)
    h.clock.advance(119_999)
    await h.service.resolve([scope], viewer)
    expect(h.permissionForUser).toHaveBeenCalledTimes(1)

    h.clock.advance(2)
    await h.service.resolve([scope], viewer)
    expect(h.permissionForUser).toHaveBeenCalledTimes(2)
  })

  it('fires exactly one background re-observation for concurrent reads past the threshold', async () => {
    const h = make(false)

    await h.service.resolve([scope], viewer)
    h.clock.advance(150_000)
    await Promise.all([h.service.resolve([scope], other), h.service.resolve([scope], third)])
    await h.service.settle()

    expect(h.service.stats.shapeRevalidations).toBe(1)
    expect(h.repoRefById).toHaveBeenCalledTimes(2)
  })

  it('never caches a failed re-observation and keeps serving the leased shape', async () => {
    const h = make(false)

    await h.service.resolve([scope], viewer)
    h.repoRefById.mockRejectedValueOnce(new Error('provider unavailable'))
    h.clock.advance(150_000)
    await expect(h.service.resolve([scope], other)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    await h.service.settle()

    // Had the failure been cached — or evicted the entry — this read would
    // block or degrade; instead the public shape is still serving.
    await expect(h.service.resolve([scope], third)).resolves.toEqual({
      allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }],
      degraded: false
    })
    await h.service.settle()
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
