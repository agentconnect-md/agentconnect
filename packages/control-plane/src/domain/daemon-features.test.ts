import { describe, expect, it } from 'vitest'
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_DEFAULT_BASE_URL,
  GITLAB_INSTANCE_V1_FEATURE,
  WORKSPACE_GIT_V1_FEATURE,
  type AgentSpec
} from '@agentconnect.md/protocol'
import {
  daemonSupportsAgent,
  encodeSpecWorkspaceForPeer,
  isSelfManagedGitlabHost,
  requiredDaemonFeatures,
  requiredGitlabFeatures,
  requiredGitlabInstanceFeatures
} from './daemon-features.js'
import type { AgentRecord } from '../persistence/ports.js'

const SELF_MANAGED = 'https://gitlab.example.test'
const workspace = (mode: string) => ({ workspace: { mode } as AgentRecord['workspace'] })

describe('§17.3 snapshot projection gate predicate', () => {
  it('requires nothing for every storable workspace shape today', () => {
    expect(requiredDaemonFeatures(workspace('scratch'))).toEqual([])
    expect(requiredDaemonFeatures(workspace('github'))).toEqual([])
  })

  it('gates a gitlab-shaped workspace on gitlab-com-v1', () => {
    expect(requiredDaemonFeatures(workspace('gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
  })

  it('gates the host-neutral arm on its CREDENTIAL, not on its mode', () => {
    // The `git` arm carries no host in its discriminant, so the gitlab-ness a
    // pre-GitLab daemon cannot decode is only visible on the credential.
    const credentialed = (provider: string) => ({ workspace: { mode: 'git', credential: { provider } } })
    expect(requiredDaemonFeatures(credentialed('gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredDaemonFeatures(credentialed('github'))).toEqual([])
    expect(requiredDaemonFeatures(workspace('git'))).toEqual([])
    expect(daemonSupportsAgent(credentialed('gitlab'), [GITLAB_COM_V1_FEATURE])).toBe(true)
    expect(daemonSupportsAgent(credentialed('gitlab'), [])).toBe(false)
  })

  it('gates a gitlab ADDITIONAL repository, whatever the workspace is', () => {
    // The quieter half: an older daemon strips the unknown `provider` key, so a
    // two-segment project path would read as an owner/repo GitHub entry and be
    // cloned from github.com. Only the assembled spec carries this, which is why
    // the predicate takes it structurally.
    const withGrant = (mode: string, provider: string) => ({
      workspace: { mode, additionalRepos: [{ repoFullName: 'a/b', repoId: '1', provider }] } as never
    })
    expect(requiredDaemonFeatures(withGrant('scratch', 'gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredDaemonFeatures(withGrant('github', 'gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredDaemonFeatures(withGrant('scratch', 'github'))).toEqual([])
    expect(daemonSupportsAgent(withGrant('scratch', 'gitlab'), [])).toBe(false)
    expect(daemonSupportsAgent(withGrant('scratch', 'gitlab'), [GITLAB_COM_V1_FEATURE])).toBe(true)
  })

  it('gates any spec carrying a non-default host, whichever consumer put it there (§24.4)', () => {
    const hosted = (mode: string, gitlabHost: string) => ({ workspace: { mode } as never, gitlabHost })
    // A github workspace whose only GitLab consumer is an enabled hook: nothing in the
    // workspace says gitlab, so the host is the entire signal.
    expect(requiredDaemonFeatures(hosted('github', SELF_MANAGED))).toEqual([GITLAB_INSTANCE_V1_FEATURE])
    expect(requiredDaemonFeatures(hosted('gitlab', SELF_MANAGED))).toEqual([
      GITLAB_COM_V1_FEATURE,
      GITLAB_INSTANCE_V1_FEATURE
    ])
    // GitLab.com is the default value of the axis, not a mode: it gates nothing new.
    expect(requiredDaemonFeatures(hosted('gitlab', GITLAB_DEFAULT_BASE_URL))).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredDaemonFeatures(hosted('github', GITLAB_DEFAULT_BASE_URL))).toEqual([])
    expect(daemonSupportsAgent(hosted('gitlab', SELF_MANAGED), [GITLAB_COM_V1_FEATURE])).toBe(false)
    expect(
      daemonSupportsAgent(hosted('gitlab', SELF_MANAGED), [GITLAB_COM_V1_FEATURE, GITLAB_INSTANCE_V1_FEATURE])
    ).toBe(true)
  })

  it('keeps the two host-keyed feature lists apart', () => {
    // The hook's dispatch target was never gated on gitlab-com-v1, so §24.4 must not
    // start requiring it there.
    expect(requiredGitlabInstanceFeatures(SELF_MANAGED)).toEqual([GITLAB_INSTANCE_V1_FEATURE])
    expect(requiredGitlabInstanceFeatures(GITLAB_DEFAULT_BASE_URL)).toEqual([])
    expect(requiredGitlabInstanceFeatures(undefined)).toEqual([])
    expect(requiredGitlabFeatures(SELF_MANAGED)).toEqual([GITLAB_COM_V1_FEATURE, GITLAB_INSTANCE_V1_FEATURE])
    expect(requiredGitlabFeatures(GITLAB_DEFAULT_BASE_URL)).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredGitlabFeatures(undefined)).toEqual([GITLAB_COM_V1_FEATURE])
    expect(isSelfManagedGitlabHost(SELF_MANAGED)).toBe(true)
    expect(isSelfManagedGitlabHost(GITLAB_DEFAULT_BASE_URL)).toBe(false)
    expect(isSelfManagedGitlabHost(undefined)).toBe(false)
  })

  it('fails closed: absent or feature-less advertisements support only ungated agents', () => {
    expect(daemonSupportsAgent(workspace('github'), undefined)).toBe(true)
    expect(daemonSupportsAgent(workspace('gitlab'), undefined)).toBe(false)
    expect(daemonSupportsAgent(workspace('gitlab'), [])).toBe(false)
    expect(daemonSupportsAgent(workspace('gitlab'), ['some-other-feature'])).toBe(false)
    expect(daemonSupportsAgent(workspace('gitlab'), [GITLAB_COM_V1_FEATURE])).toBe(true)
  })
})

describe('§8 per-peer workspace encoding', () => {
  const gitSpec = (credential?: { provider: 'github' } | { provider: 'gitlab'; projectId: string }) =>
    ({
      workspace: {
        mode: 'git',
        isolation: 'shared',
        gitRepo: 'https://gitlab.example.test/example-group/example-project.git',
        branch: 'release',
        agentDir: 'api',
        ...(credential ? { credential } : {}),
        additionalRepos: []
      }
    }) satisfies Pick<AgentSpec, 'workspace'>
  /** Every legacy arm keeps the shared half verbatim; only the host-shaped tail differs. */
  const legacyTail = {
    isolation: 'shared',
    gitRepo: 'https://gitlab.example.test/example-group/example-project.git',
    branch: 'release',
    agentDir: 'api',
    additionalRepos: []
  }

  it('leaves the host-neutral arm alone for a peer that advertises workspace-git-v1', () => {
    const spec = gitSpec({ provider: 'gitlab', projectId: '4455667' })
    expect(encodeSpecWorkspaceForPeer(spec, [WORKSPACE_GIT_V1_FEATURE])).toBe(spec)
  })

  it('downgrades a gitlab-vouched workspace to the legacy gitlab arm, carrying the project id', () => {
    expect(encodeSpecWorkspaceForPeer(gitSpec({ provider: 'gitlab', projectId: '4455667' }), []).workspace).toEqual({
      mode: 'gitlab',
      ...legacyTail,
      projectId: '4455667'
    })
  })

  it('downgrades an App-vouched workspace to the legacy github arm with its credential mode', () => {
    expect(encodeSpecWorkspaceForPeer(gitSpec({ provider: 'github' }), undefined).workspace).toEqual({
      mode: 'github',
      ...legacyTail,
      gitCredential: 'github-app'
    })
  })

  it('downgrades an anonymous workspace to the host-agnostic legacy github arm, uncredentialed', () => {
    // The legacy `github` arm's gitRepo was never host-checked, so an anonymous
    // clone of any host rides it exactly as it did before the `git` arm existed.
    expect(encodeSpecWorkspaceForPeer(gitSpec(), []).workspace).toEqual({ mode: 'github', ...legacyTail })
  })

  it('is identity for a scratch workspace, whatever the peer advertises', () => {
    const scratch = {
      workspace: { mode: 'scratch', isolation: 'shared', additionalRepos: [] }
    } satisfies Pick<AgentSpec, 'workspace'>
    expect(encodeSpecWorkspaceForPeer(scratch, [])).toBe(scratch)
    expect(encodeSpecWorkspaceForPeer({}, [])).toEqual({})
  })
})
