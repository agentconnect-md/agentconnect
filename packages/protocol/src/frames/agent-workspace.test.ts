/**
 * The host-neutral workspace arm (git-workspace-model.md §2/§3): `mode` answers "is there a
 * repository", `credential` answers "who vouches for it". A new code host is a new credential
 * variant, never a new mode — so the union is closed, and the legacy arms stay decodable (§8).
 */
import { describe, expect, it } from 'vitest'
import { WORKSPACE_GIT_V1_FEATURE } from '../consts.js'
import { AgentSpec, AgentWorkspace } from './agent.js'

const REPO = 'https://gitlab.example.test/gitlab/example-group/example-project.git'

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
      additionalRepos: []
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
