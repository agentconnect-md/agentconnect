/**
 * §24.4 host carriage: the three optional members that carry the GitLab instance, and the
 * one rule every reader shares — absent means GitLab.com, so a peer talking to a control
 * plane that predates this release is correct without a second negotiation.
 */
import { describe, expect, it } from 'vitest'
import { GITLAB_DEFAULT_BASE_URL, GITLAB_INSTANCE_V1_FEATURE } from '../consts.js'
import { AgentSpec } from './agent.js'
import { GitlabHookMetadata } from './hook.js'
import { GitCredGrant } from './gitcred.js'
import { RcHookAssign } from './relay-cp.js'

const SELF_MANAGED = 'https://gitlab.example.test/gitlab'

/** How every consumer resolves the axis from a decoded frame (§24.1: absent is a value). */
const resolve = (host: string | undefined): string => host ?? GITLAB_DEFAULT_BASE_URL

const gitlabWorkspace = {
  mode: 'gitlab' as const,
  gitRepo: 'https://gitlab.example.test/gitlab/example-group/example-project',
  branch: 'main',
  projectId: '4455667'
}

const grant = {
  username: 'agent-bot',
  token: 'glpat-example',
  ttlSec: 3600,
  expiresAt: '2026-08-24T00:00:00.000Z',
  repoFullName: 'example-group/example-project',
  access: 'write' as const,
  provider: 'gitlab' as const,
  externalRepoId: '4455667'
}

const hookRule = {
  hookId: '11111111-1111-4111-8111-111111111111',
  kind: 'gitlab' as const,
  agentId: '22222222-2222-4222-8222-222222222222',
  daemonId: '33333333-3333-4333-8333-333333333333',
  sessionMode: 'perThread' as const,
  gitlab: {
    projectId: '4455667',
    projectPath: 'example-group/example-project',
    sessionKeyPrefix: 'gitlab:4455667',
    events: ['merge_request:opened'],
    labelFilter: [],
    mentionOnly: false,
    serviceAccountUserId: '9042',
    serviceAccountUsername: 'agent-bot',
    signingToken: 'whsec_example'
  }
}

const hookMetadata = {
  projectId: '4455667',
  projectPath: 'example-group/example-project',
  target: { kind: 'merge_request' as const, iid: 7 }
}

describe('§24.4 gitlab-instance-v1', () => {
  it('is its own string, leaving the older feature name alone', () => {
    expect(GITLAB_INSTANCE_V1_FEATURE).toBe('gitlab-instance-v1')
    expect(GITLAB_DEFAULT_BASE_URL).toBe('https://gitlab.com')
  })
})

describe('§24.4 AgentSpec.gitlabHost', () => {
  it('round-trips a self-managed host on a gitlab workspace', () => {
    const parsed = AgentSpec.parse({ name: 'a', workspace: gitlabWorkspace, gitlabHost: SELF_MANAGED })
    expect(parsed.gitlabHost).toBe(SELF_MANAGED)
    expect(resolve(parsed.gitlabHost)).toBe(SELF_MANAGED)
  })

  it('round-trips a host whose only consumer is an additional repository on a scratch workspace', () => {
    const parsed = AgentSpec.parse({
      name: 'a',
      workspace: {
        mode: 'scratch',
        additionalRepos: [{ repoFullName: 'example-group/example-project', repoId: '4455667', provider: 'gitlab' }]
      },
      gitlabHost: SELF_MANAGED
    })
    expect(parsed.gitlabHost).toBe(SELF_MANAGED)
    expect(parsed.workspace?.additionalRepos[0]?.provider).toBe('gitlab')
  })

  it('decodes an absent host as GitLab.com', () => {
    const parsed = AgentSpec.parse({ name: 'a', workspace: gitlabWorkspace })
    expect(parsed.gitlabHost).toBeUndefined()
    expect(resolve(parsed.gitlabHost)).toBe('https://gitlab.com')
  })
})

describe('§24.4 the hook path', () => {
  it('round-trips the compiled rule host', () => {
    const parsed = RcHookAssign.parse({ ...hookRule, gitlab: { ...hookRule.gitlab, host: SELF_MANAGED } })
    expect(parsed.gitlab?.host).toBe(SELF_MANAGED)
  })

  it('decodes a rule without a host as GitLab.com', () => {
    const parsed = RcHookAssign.parse(hookRule)
    expect(parsed.gitlab?.host).toBeUndefined()
    expect(resolve(parsed.gitlab?.host)).toBe('https://gitlab.com')
  })

  it('round-trips the trusted metadata host the relay forwards', () => {
    const parsed = GitlabHookMetadata.parse({ ...hookMetadata, host: SELF_MANAGED })
    expect(parsed.host).toBe(SELF_MANAGED)
    expect(GitlabHookMetadata.parse(hookMetadata).host).toBeUndefined()
    expect(resolve(GitlabHookMetadata.parse(hookMetadata).host)).toBe('https://gitlab.com')
  })
})

describe('§24.4 GitCredGrant.host', () => {
  it('round-trips the echoed host beside the provider and project id', () => {
    const parsed = GitCredGrant.parse({ ...grant, host: SELF_MANAGED })
    expect(parsed.host).toBe(SELF_MANAGED)
    expect(parsed.provider).toBe('gitlab')
    expect(parsed.externalRepoId).toBe('4455667')
  })

  it('decodes a grant without a host as GitLab.com', () => {
    const parsed = GitCredGrant.parse(grant)
    expect(parsed.host).toBeUndefined()
    expect(resolve(parsed.host)).toBe('https://gitlab.com')
  })
})
