/**
 * The §6 outcome table (git-workspace-model.md), offline: provenance comes from
 * `(orgId, gitRepo)` and the tier from the actor, so every row here is a pure
 * decision over stubbed reads — no route, no database, no provider call.
 */
import { describe, expect, it } from 'vitest'
import type { HttpDeps } from '../deps.js'
import type { GithubInstallationRecord } from '../../persistence/ports.js'
import type { PublicRepoLookup } from '../../github/public-repo.js'
import { deriveWorkspaceCredential, WorkspaceCredentialRefused } from './workspace-credential.js'
import { gitlabManagedProjectPath } from '../../domain/git-host.js'

const ORG = 'org-1'
const ACTOR = 'user-1'
const GITLAB_BASE = 'https://gitlab.example.test'

/** Only `id`/`suspendedAt`/`accountLogin` are read here; the rest keeps the record shape. */
const installation = (over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord =>
  ({
    id: 'ins-row',
    orgId: ORG,
    accountLogin: 'acme',
    suspendedAt: null,
    revokedAt: null,
    ...over
  }) as GithubInstallationRecord

const REPO_REF = { repoId: 42n, fullName: 'acme/Infra', private: true, defaultBranch: 'trunk' }

type Parts = {
  installation?: GithubInstallationRecord | null
  repoRef?: typeof REPO_REF | null
  publicLookup?: PublicRepoLookup
  /** Absent ⇒ no anonymous resolver at all, which reads as `unreachable`. */
  resolver?: boolean
  bindings?: Array<{ projectId: bigint; projectPath: string; defaultBranch: string | null; state: string }>
  catalogRow?: { cloneUrl: string | null } | null
  gitlab?: boolean
  authzError?: Error
}

/** The dependency surface `deriveWorkspaceCredential` actually reads, and a log of what it called. */
function makeDeps(parts: Parts = {}) {
  const calls = { upserts: [] as Array<Record<string, unknown>>, publicLookups: 0, assertions: [] as string[] }
  const deps = {
    github: {
      repoRefFor: async () => parts.repoRef ?? null
    },
    githubUserAuthz: {
      assertAccess: async (_userId: string, _ins: GithubInstallationRecord, o: string, r: string, need: string) => {
        calls.assertions.push(`${o}/${r}:${need}`)
        if (parts.authzError) throw parts.authzError
        return { canRead: true, canWrite: true }
      }
    },
    ...(parts.resolver
      ? {
          resolvePublicRepo: async () => {
            calls.publicLookups += 1
            return parts.publicLookup ?? 'unreachable'
          }
        }
      : {}),
    ...(parts.gitlab === false ? {} : { gitlab: { api: { baseUrl: GITLAB_BASE } } }),
    repos: {
      githubInstallation: { liveByOrgAndAccount: async () => parts.installation ?? null },
      gitlabProjectBinding: {
        byProjectPath: async (_orgId: string, path: string) =>
          (parts.bindings ?? []).find((row) => row.projectPath.toLowerCase() === path.toLowerCase()) ?? null
      },
      codeHostRepository: {
        upsert: async (input: Record<string, unknown>) => {
          calls.upserts.push(input)
          return input
        },
        byExternalId: async () => parts.catalogRow ?? null
      }
    }
  } as unknown as HttpDeps
  return { deps, calls }
}

describe('deriveWorkspaceCredential — §6 outcome table', () => {
  it('vouches with the covering installation, converging the catalog on the CANONICAL address', async () => {
    const { deps, calls } = makeDeps({ installation: installation(), repoRef: REPO_REF })

    const derived = await deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra')

    // The address comes from the installation lookup, never from caller input — so
    // a mis-cased or shorthand entry still stores one canonical row.
    expect(derived).toEqual({
      kind: 'github',
      installationId: 'ins-row',
      repoId: 42n,
      gitRepo: 'https://github.com/acme/Infra',
      defaultBranch: 'trunk',
      access: 'write'
    })
    expect(calls.upserts[0]).toMatchObject({
      provider: 'github',
      externalId: 42n,
      displayPath: 'acme/Infra',
      cloneUrl: 'https://github.com/acme/Infra'
    })
    // Unstated tier ⇒ the highest the target carries, and the identity gate is held to it,
    // on the CANONICAL spelling so one repository holds one authz cache entry.
    expect(calls.assertions).toEqual(['acme/Infra:write'])
  })

  it('holds the acting human to the REQUESTED tier, not the target’s ceiling', async () => {
    const { deps, calls } = makeDeps({ installation: installation(), repoRef: REPO_REF })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra', 'read')).resolves.toMatchObject({
      access: 'read'
    })
    expect(calls.assertions).toEqual(['acme/Infra:read'])
  })

  it('refuses a repository the covering installation cannot see, rather than degrading to anonymous', async () => {
    // An installation token reads any PUBLIC repository, so a miss under a covered
    // owner is private-and-ungranted: the actionable answer names the grant.
    const { deps } = makeDeps({ installation: installation(), repoRef: null })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra')).rejects.toBeInstanceOf(
      WorkspaceCredentialRefused
    )
  })

  it('treats a suspended installation as no coverage at all', async () => {
    const { deps } = makeDeps({
      installation: installation({ suspendedAt: new Date() }),
      resolver: true,
      publicLookup: { ...REPO_REF, private: false }
    })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra')).resolves.toMatchObject({
      kind: 'anonymous',
      access: 'read'
    })
  })

  it('falls back to an anonymous read when no installation covers the owner and the repo is public', async () => {
    const { deps } = makeDeps({ resolver: true, publicLookup: { ...REPO_REF, private: false } })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'https://github.com/acme/infra')).resolves.toEqual({
      kind: 'anonymous',
      gitRepo: 'https://github.com/acme/Infra',
      defaultBranch: 'trunk',
      access: 'read',
      host: 'github'
    })
  })

  it('refuses an uncovered address the anonymous read says is not a public repository', async () => {
    const { deps } = makeDeps({ resolver: true, publicLookup: 'not-found' })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra')).rejects.toThrow(
      'install the GitHub App for access to private ones'
    )
  })

  it('keeps an unreachable GitHub anonymous rather than refusing on a blip', async () => {
    // Creation never preflighted at all; the daemon's clone boundary verifies anyway.
    const { deps } = makeDeps({ resolver: true, publicLookup: 'unreachable' })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra')).resolves.toEqual({
      kind: 'anonymous',
      gitRepo: 'https://github.com/acme/infra',
      access: 'read',
      host: 'github'
    })
  })

  it('refuses write on every anonymous outcome, before any preflight', async () => {
    const { deps: github, calls: githubCalls } = makeDeps({ resolver: true, publicLookup: { ...REPO_REF } })
    await expect(deriveWorkspaceCredential(github, ORG, ACTOR, 'acme/infra', 'write')).rejects.toThrow(
      'requires a GitHub App installation'
    )
    expect(githubCalls.publicLookups).toBe(0)

    const { deps: gitlab } = makeDeps({ bindings: [] })
    await expect(
      deriveWorkspaceCredential(gitlab, ORG, ACTOR, `${GITLAB_BASE}/example-group/example-project`, 'write')
    ).rejects.toThrow('requires a managed project')

    const { deps: other } = makeDeps()
    await expect(
      deriveWorkspaceCredential(other, ORG, ACTOR, 'https://git.example.test/team/service.git', 'write')
    ).rejects.toThrow('this host is cloned anonymously')
  })

  it('vouches with a managed GitLab binding, cloning from the CATALOG row', async () => {
    // The persisted provider-authored URL is the authority — never a composed one.
    const { deps } = makeDeps({
      bindings: [
        { projectId: 991n, projectPath: 'Example-Group/Example-Project', defaultBranch: 'trunk', state: 'ready' }
      ],
      catalogRow: { cloneUrl: `${GITLAB_BASE}/example-group/example-project.git` }
    })

    await expect(
      deriveWorkspaceCredential(deps, ORG, ACTOR, `${GITLAB_BASE}/example-group/example-project`)
    ).resolves.toEqual({
      kind: 'gitlab',
      projectId: 991n,
      gitRepo: `${GITLAB_BASE}/example-group/example-project.git`,
      defaultBranch: 'trunk',
      access: 'write'
    })
  })

  it('refuses a binding whose catalog row has no clone URL yet', async () => {
    const { deps } = makeDeps({
      bindings: [
        { projectId: 991n, projectPath: 'example-group/example-project', defaultBranch: null, state: 'ready' }
      ],
      catalogRow: { cloneUrl: null }
    })

    await expect(
      deriveWorkspaceCredential(deps, ORG, ACTOR, `${GITLAB_BASE}/example-group/example-project`)
    ).rejects.toThrow('no clone URL yet')
  })

  it('refuses a binding on its way out rather than demoting it to an anonymous clone', async () => {
    const { deps } = makeDeps({
      bindings: [
        { projectId: 991n, projectPath: 'example-group/example-project', defaultBranch: null, state: 'cleanup_pending' }
      ]
    })

    await expect(
      deriveWorkspaceCredential(deps, ORG, ACTOR, `${GITLAB_BASE}/example-group/example-project`, 'write')
    ).rejects.toThrow('being removed')
  })

  it('clones any other host anonymously, with no preflight at all', async () => {
    const { deps, calls } = makeDeps({ resolver: true, publicLookup: 'not-found' })

    await expect(
      deriveWorkspaceCredential(deps, ORG, ACTOR, 'https://git.example.test/team/service.git')
    ).resolves.toEqual({
      kind: 'anonymous',
      gitRepo: 'https://git.example.test/team/service.git',
      access: 'read',
      host: 'other'
    })
    expect(calls.publicLookups).toBe(0)
  })

  it('lets an identity denial bubble for the routes’ shared error mapping', async () => {
    const authzError = new Error('you do not have write access')
    const { deps } = makeDeps({ installation: installation(), repoRef: REPO_REF, authzError })

    await expect(deriveWorkspaceCredential(deps, ORG, ACTOR, 'acme/infra')).rejects.toBe(authzError)
  })

  it('fails closed when the identity gate is configured but no principal exists', async () => {
    const { deps, calls } = makeDeps({ installation: installation(), repoRef: REPO_REF })

    await expect(deriveWorkspaceCredential(deps, ORG, undefined, 'acme/infra')).rejects.toThrow(
      'signed-in identity is required'
    )
    expect(calls.assertions).toEqual([])
  })

  it('needs no principal where no identity gate is configured (devAuth)', async () => {
    const { deps } = makeDeps({ installation: installation(), repoRef: REPO_REF })
    Reflect.deleteProperty(deps as unknown as Record<string, unknown>, 'githubUserAuthz')

    await expect(deriveWorkspaceCredential(deps, ORG, undefined, 'acme/infra')).resolves.toMatchObject({
      kind: 'github'
    })
  })
})

describe('gitlabManagedProjectPath', () => {
  it('matches https on host+port and strips the base path prefix', () => {
    expect(gitlabManagedProjectPath(`${GITLAB_BASE}/example-group/example-project`, GITLAB_BASE)).toBe(
      'example-group/example-project'
    )
    expect(gitlabManagedProjectPath(`${GITLAB_BASE}/a/b/c.git`, `${GITLAB_BASE}/`)).toBe('a/b/c')
    expect(gitlabManagedProjectPath('https://example.test/gitlab/a/b', 'https://example.test/gitlab')).toBe('a/b')
  })

  it('rejects a different host, a path outside the prefix, and a project with no namespace', () => {
    expect(gitlabManagedProjectPath('https://gitlab.com/a/b', GITLAB_BASE)).toBeNull()
    expect(gitlabManagedProjectPath('https://example.test/other/a/b', 'https://example.test/gitlab')).toBeNull()
    expect(gitlabManagedProjectPath(`${GITLAB_BASE}/lonely`, GITLAB_BASE)).toBeNull()
    expect(gitlabManagedProjectPath(`${GITLAB_BASE}/a/b`, 'not a url')).toBeNull()
  })

  it('matches ssh on the bare host, and only when the base carries no prefix', () => {
    expect(gitlabManagedProjectPath('git@gitlab.example.test:example-group/example-project.git', GITLAB_BASE)).toBe(
      'example-group/example-project'
    )
    expect(gitlabManagedProjectPath('git@example.test:a/b.git', 'https://example.test/gitlab')).toBeNull()
  })
})
