import { describe, expect, it } from 'vitest'
import {
  REPORTING_MODE_OPTIONS,
  REVIEW_POLICY_OPTIONS,
  effectiveRepoAccess,
  githubReviewCapabilities,
  githubReviewSettingsFromCapabilities,
  hasChecksWritePermission,
  hasPullRequestsReadPermission,
  hasPullRequestsWritePermission,
  installationForRepo,
  isWorkspaceRepo,
  repoAccessSatisfies,
  requiredRepoAccess
} from './github-review-settings'

describe('R1/R2a GitHub review settings', () => {
  it('identifies the App-backed workspace by id and only name-matches without conflicting ids', () => {
    const workspace = {
      mode: 'git' as const,
      provider: 'github' as const,
      repoId: '42',
      repo: 'acme/repo'
    }
    expect(isWorkspaceRepo({ repoId: '42', repoFullName: 'renamed/repo', workspace })).toBe(true)
    expect(isWorkspaceRepo({ repoFullName: 'ACME/REPO', workspace })).toBe(true)
    expect(isWorkspaceRepo({ repoId: '7', repoFullName: 'acme/repo', workspace })).toBe(false)
  })

  it('offers formal review policies and informational Checks only', () => {
    expect(REVIEW_POLICY_OPTIONS.map((option) => option.value)).toEqual(['off', 'comment', 'request_changes', 'full'])
    expect(REPORTING_MODE_OPTIONS.map((option) => option.value)).toEqual(['off', 'check'])
  })

  it('maps any formal review or Check to write, and nothing else to none', () => {
    expect(requiredRepoAccess({ reviewPolicy: 'off', reportingMode: 'off' })).toBe('none')
    expect(requiredRepoAccess({ reviewPolicy: 'comment', reportingMode: 'off' })).toBe('write')
    expect(requiredRepoAccess({ reviewPolicy: 'request_changes', reportingMode: 'off' })).toBe('write')
    expect(requiredRepoAccess({ reviewPolicy: 'full', reportingMode: 'off' })).toBe('write')
    expect(requiredRepoAccess({ reviewPolicy: 'off', reportingMode: 'check' })).toBe('write')
  })

  it('round-trips the hierarchical review policy through capability checkboxes', () => {
    expect(githubReviewCapabilities({ reviewPolicy: 'full', reportingMode: 'check' })).toEqual({
      inlineComments: true,
      requestChanges: true,
      approve: true,
      statusCheck: true
    })
    expect(
      githubReviewSettingsFromCapabilities({
        inlineComments: true,
        requestChanges: true,
        approve: false,
        statusCheck: false
      })
    ).toEqual({ reviewPolicy: 'request_changes', reportingMode: 'off' })
    expect(
      githubReviewSettingsFromCapabilities({
        inlineComments: false,
        requestChanges: false,
        approve: false,
        statusCheck: true
      })
    ).toEqual({ reviewPolicy: 'off', reportingMode: 'check' })
  })

  it('compares access tiers monotonically', () => {
    expect(repoAccessSatisfies('write', 'write')).toBe(true)
    expect(repoAccessSatisfies('read', 'write')).toBe(false)
    // A legacy `comment` grant (still readable until the tier is removed
    // server-side) does not satisfy the write requirement a review now needs.
    expect(repoAccessSatisfies('comment', 'write')).toBe(false)
    expect(repoAccessSatisfies('read', 'none')).toBe(true)
    expect(repoAccessSatisfies('none', 'none')).toBe(true)
  })

  it('gates Checks strictly on the persisted installation-effective permission', () => {
    expect(hasChecksWritePermission({ checksPermission: 'write' })).toBe(true)
    expect(hasChecksWritePermission({ checksPermission: 'missing' })).toBe(false)
    expect(hasChecksWritePermission({ checksPermission: 'unknown' })).toBe(false)
    expect(hasChecksWritePermission(undefined)).toBe(false)

    // GitHub's coarse App-upgrade status is deliberately not an input: an
    // unrelated pending permission update must not disable an exact write grant.
    const outdatedInstallation = { checksPermission: 'write' as const, permissionsStatus: 'outdated' as const }
    expect(hasChecksWritePermission(outdatedInstallation)).toBe(true)
  })

  it('gates formal reviews on exact pull_requests:write', () => {
    expect(hasPullRequestsWritePermission({ pullRequestsPermission: 'write' })).toBe(true)
    expect(hasPullRequestsWritePermission({ pullRequestsPermission: 'read' })).toBe(false)
    expect(hasPullRequestsWritePermission({ pullRequestsPermission: 'missing' })).toBe(false)
    expect(hasPullRequestsWritePermission({ pullRequestsPermission: 'unknown' })).toBe(false)
    expect(hasPullRequestsWritePermission(undefined)).toBe(false)
  })

  it('gates informational Checks on pull_requests:read or write', () => {
    expect(hasPullRequestsReadPermission({ pullRequestsPermission: 'read' })).toBe(true)
    expect(hasPullRequestsReadPermission({ pullRequestsPermission: 'write' })).toBe(true)
    expect(hasPullRequestsReadPermission({ pullRequestsPermission: 'missing' })).toBe(false)
    expect(hasPullRequestsReadPermission({ pullRequestsPermission: 'unknown' })).toBe(false)
    expect(hasPullRequestsReadPermission(undefined)).toBe(false)
  })

  it('resolves an App workspace before explicit grants and allows a manual workspace grant', () => {
    const authorizations = [{ repoFullName: 'acme/docs', access: 'comment' as const }]
    expect(
      effectiveRepoAccess({
        repoFullName: 'ACME/INFRA',
        workspace: { mode: 'git', provider: 'github', repo: 'acme/infra', gitAccess: 'read' },
        authorizations
      })
    ).toBe('read')
    expect(
      effectiveRepoAccess({
        repoFullName: 'acme/docs',
        workspace: { mode: 'git', provider: 'github', repo: 'acme/infra', gitAccess: 'write' },
        authorizations
      })
    ).toBe('comment')
    expect(
      effectiveRepoAccess({
        repoFullName: 'acme/infra',
        workspace: { mode: 'git', repo: 'acme/infra' },
        authorizations: [...authorizations, { repoFullName: 'acme/infra', access: 'write' }]
      })
    ).toBe('write')
  })

  it('uses numeric repo provenance before names and falls back only for legacy rows', () => {
    const authorizations = [
      { repoId: '22', repoFullName: 'acme/renamed', access: 'comment' as const },
      { repoFullName: 'acme/legacy', access: 'write' as const }
    ]
    expect(
      effectiveRepoAccess({
        repoId: '11',
        repoFullName: 'acme/new-name',
        workspace: {
          mode: 'git',
          provider: 'github',
          repoId: '11',
          repo: 'acme/old-name',
          gitAccess: 'write'
        },
        authorizations
      })
    ).toBe('write')
    expect(
      effectiveRepoAccess({
        repoId: '22',
        repoFullName: 'acme/renamed',
        workspace: {
          mode: 'git',
          provider: 'github',
          repoId: '11',
          repo: 'acme/renamed',
          gitAccess: 'write'
        },
        authorizations
      })
    ).toBe('comment')
    // A reused name cannot turn a conflicting numeric id into workspace access.
    expect(
      effectiveRepoAccess({
        repoId: '33',
        repoFullName: 'acme/old-name',
        workspace: {
          mode: 'git',
          provider: 'github',
          repoId: '11',
          repo: 'acme/old-name',
          gitAccess: 'write'
        },
        authorizations
      })
    ).toBe('none')
    expect(
      effectiveRepoAccess({
        repoId: '44',
        repoFullName: 'acme/legacy',
        workspace: { mode: 'scratch' },
        authorizations
      })
    ).toBe('write')
  })

  it('finds the installation by repo owner', () => {
    expect(
      installationForRepo('Acme/infra', [
        { accountLogin: 'other', id: 1 },
        { accountLogin: 'acme', id: 2 }
      ])
    ).toMatchObject({ id: 2 })
  })
})
