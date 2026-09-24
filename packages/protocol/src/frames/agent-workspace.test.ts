/**
 * The host-neutral workspace arm (git-workspace-model.md §2/§3): `mode` answers "is there a
 * repository", `credential` answers "who vouches for it". A new code host is a new credential
 * variant, never a new mode — so the union is closed, and the legacy arms stay decodable (§8).
 */
import { describe, expect, it } from 'vitest'
import { WORKSPACE_GIT_V1_FEATURE } from '../consts.js'
import {
  AgentAdditionalInstallation,
  AgentAdditionalRepo,
  AgentSpec,
  AgentWorkspace,
  RepoMaterialization
} from './agent.js'

const REPO = 'https://gitlab.example.test/gitlab/example-group/example-project.git'

describe('additionalInstallations (agent-multi-repo-authorization.md decision 10)', () => {
  const variants = [
    { mode: 'scratch' },
    { mode: 'git', gitRepo: 'https://github.com/example-org/example-repo' },
    { mode: 'github', gitRepo: 'https://github.com/example-org/example-repo' },
    { mode: 'gitlab', gitRepo: REPO, projectId: '9' }
  ]

  it('decodes every variant without the field as no grants, so an older control plane’s spec decodes unchanged', () => {
    for (const variant of variants) {
      expect(AgentWorkspace.parse(variant).additionalInstallations).toEqual([])
    }
  })

  it('defaults a grant to github and `on-demand`, and keeps an explicit value', () => {
    expect(AgentAdditionalInstallation.parse({ accountLogin: 'example-org', access: 'read' })).toEqual({
      provider: 'github',
      accountLogin: 'example-org',
      access: 'read',
      materialize: 'on-demand'
    })
    for (const variant of variants) {
      const parsed = AgentWorkspace.parse({
        ...variant,
        additionalInstallations: [{ accountLogin: 'example-org', access: 'comment', materialize: 'decision' }]
      })
      expect(parsed.additionalInstallations).toEqual([
        { provider: 'github', accountLogin: 'example-org', access: 'comment', materialize: 'decision' }
      ])
      expect(parsed.additionalRepos).toEqual([])
    }
  })

  it('strips an unknown key but refuses a tier outside the three', () => {
    expect(
      AgentAdditionalInstallation.parse({ accountLogin: 'example-org', access: 'write', installationId: '12345' })
    ).not.toHaveProperty('installationId')
    expect(() => AgentAdditionalInstallation.parse({ accountLogin: 'example-org', access: 'admin' })).toThrow()
  })
})

describe('additionalRepos `materialize` (multi-repository-workspaces.md decision 13)', () => {
  it('names the three modes on the wire', () => {
    expect(RepoMaterialization.options).toEqual(['always', 'decision', 'on-demand'])
  })

  it('decodes an entry without the field as `always`, so an older control plane’s list means what it meant', () => {
    expect(AgentAdditionalRepo.parse({ repoFullName: 'example-org/example-repo', repoId: '815' })).toEqual({
      repoFullName: 'example-org/example-repo',
      repoId: '815',
      provider: 'github',
      materialize: 'always'
    })
  })

  it('keeps an explicit value and refuses one outside the enum', () => {
    const parsed = AgentWorkspace.parse({
      mode: 'scratch',
      additionalRepos: [{ repoFullName: 'example-org/example-repo', repoId: '815', materialize: 'on-demand' }]
    })
    expect(parsed.additionalRepos[0]?.materialize).toBe('on-demand')
    expect(() =>
      AgentAdditionalRepo.parse({ repoFullName: 'example-org/example-repo', repoId: '815', materialize: 'never' })
    ).toThrow()
  })
})

describe('§8 workspace-git-v1', () => {
  it('is its own feature string', () => {
    expect(WORKSPACE_GIT_V1_FEATURE).toBe('workspace-git-v1')
  })
})

describe('§3 AgentWorkspace `git` arm', () => {
  it('decodes a gitlab-credentialed workspace, defaulting branch/isolation/additionalRepos', () => {
    const parsed = AgentWorkspace.parse({
      mode: 'git',
      gitRepo: REPO,
      credential: { provider: 'gitlab', projectId: '5' }
    })
    expect(parsed).toEqual({
      mode: 'git',
      isolation: 'shared',
      gitRepo: REPO,
      branch: 'main',
      credential: { provider: 'gitlab', projectId: '5' },
      additionalRepos: [],
      additionalInstallations: []
    })
  })

  it('decodes the github credential with no installation id on the wire', () => {
    const parsed = AgentWorkspace.parse({
      mode: 'git',
      gitRepo: 'https://github.com/acme/repo',
      branch: 'release',
      agentDir: 'services/api',
      credential: { provider: 'github' }
    })
    expect(parsed.mode).toBe('git')
    expect(parsed).toMatchObject({ branch: 'release', agentDir: 'services/api' })
    expect(parsed.mode === 'git' && parsed.credential).toEqual({ provider: 'github' })
  })

  it('decodes an absent credential as the anonymous clone', () => {
    const parsed = AgentWorkspace.parse({ mode: 'git', gitRepo: 'https://git.example.test/team/repo.git' })
    expect(parsed.mode === 'git' && parsed.credential).toBeUndefined()
  })

  it('refuses a credential provider the union does not name', () => {
    expect(() =>
      AgentWorkspace.parse({ mode: 'git', gitRepo: REPO, credential: { provider: 'bitbucket', projectId: '5' } })
    ).toThrow()
    // The rename-stable project id stays a positive integer string on both arms.
    expect(() =>
      AgentWorkspace.parse({ mode: 'git', gitRepo: REPO, credential: { provider: 'gitlab', projectId: 'group/proj' } })
    ).toThrow()
    // `provider: 'github'` carries nothing else — a projectId on it is not a gitlab credential.
    expect(AgentWorkspace.parse({ mode: 'git', gitRepo: REPO, credential: { provider: 'github' } }).mode).toBe('git')
  })

  it('rides AgentSpec beside the host axis, and leaves the legacy arms decodable', () => {
    const spec = AgentSpec.parse({
      name: 'a',
      workspace: { mode: 'git', gitRepo: REPO, credential: { provider: 'gitlab', projectId: '4455667' } },
      gitlabHost: 'https://gitlab.example.test/gitlab'
    })
    expect(spec.workspace?.mode).toBe('git')
    expect(AgentWorkspace.parse({ mode: 'github', gitRepo: 'https://github.com/acme/repo' }).mode).toBe('github')
    expect(AgentWorkspace.parse({ mode: 'gitlab', gitRepo: REPO, projectId: '9' }).mode).toBe('gitlab')
  })
})
