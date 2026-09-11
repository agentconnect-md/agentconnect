/**
 * Gitea's wire slice (gitea-integration.md §11): the feature string, the pre-spawn host field, the
 * credential arm, the compiled rule, the forwarded metadata, the rerun frame and the two gitcred
 * purposes. One rule is shared by every reader — absent means gitea.com, so a peer talking to a
 * control plane that predates this release is correct without a second negotiation.
 */
import { describe, expect, it } from 'vitest'
import { GITEA_DEFAULT_BASE_URL, GITEA_V1_FEATURE } from '../consts.js'
import { CODE_HOST_PROVIDERS, HOOK_KINDS, isCodeHostProvider } from '../code-host.js'
import { AgentSpec } from './agent.js'
import { GiteaHookMetadata } from './hook.js'
import { GitCredRequest } from './gitcred.js'
import { RcHookAssign, RcHookRerun, codeHostHookRuleOf } from './relay-cp.js'
import { RdMsg } from './relay-daemon.js'

const SELF_HOSTED = 'https://gitea.example.test/gitea'
const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const DAEMON_ID = '33333333-3333-4333-8333-333333333333'

/** How every consumer resolves the axis from a decoded frame: absent is a value, not a mode. */
const resolve = (host: string | undefined): string => host ?? GITEA_DEFAULT_BASE_URL

const giteaCredentialWorkspace = {
  mode: 'git' as const,
  gitRepo: 'https://gitea.example.test/gitea/example-org/example-repo',
  branch: 'main',
  credential: { provider: 'gitea' as const, repoId: '556677' }
}

const hookRule = {
  hookId: HOOK_ID,
  kind: 'gitea' as const,
  agentId: AGENT_ID,
  daemonId: DAEMON_ID,
  sessionMode: 'perThread' as const,
  gitea: {
    repoId: '556677',
    repoPath: 'example-org/example-repo',
    sessionKeyPrefix: 'gitea:556677',
    events: ['merge_request:opened'],
    mentionOnly: false,
    botUserId: '9042',
    botUsername: 'agent-bot',
    signingKey: 'a'.repeat(64)
  }
}

const hookMetadata = {
  repoId: '556677',
  repoPath: 'example-org/example-repo',
  target: { kind: 'pull' as const, index: 7 }
}

describe('gitea is a known code host', () => {
  it('joins the provider vocabulary and therefore the hook kinds', () => {
    expect(CODE_HOST_PROVIDERS).toContain('gitea')
    expect(isCodeHostProvider('gitea')).toBe(true)
    expect(HOOK_KINDS).toContain('gitea')
  })

  it('has one feature string covering gitea.com and a self-hosted address alike', () => {
    expect(GITEA_V1_FEATURE).toBe('gitea-v1')
    expect(GITEA_DEFAULT_BASE_URL).toBe('https://gitea.com')
  })
})

describe('AgentSpec.giteaHost and the gitea credential arm', () => {
  it('round-trips a self-hosted instance beside a gitea-vouched git workspace', () => {
    const parsed = AgentSpec.parse({ name: 'a', workspace: giteaCredentialWorkspace, giteaHost: SELF_HOSTED })
    expect(parsed.giteaHost).toBe(SELF_HOSTED)
    expect(parsed.workspace?.credential).toEqual({ provider: 'gitea', repoId: '556677' })
  })

  it('decodes an absent host as gitea.com and keeps the GitLab axis independent', () => {
    const parsed = AgentSpec.parse({ name: 'a', workspace: giteaCredentialWorkspace, gitlabHost: 'https://gl.test' })
    expect(parsed.giteaHost).toBeUndefined()
    expect(resolve(parsed.giteaHost)).toBe('https://gitea.com')
    expect(parsed.gitlabHost).toBe('https://gl.test')
  })

  it('keys the credential by the rename-stable numeric repository id', () => {
    const bad = { ...giteaCredentialWorkspace, credential: { provider: 'gitea', repoId: 'example-org/example-repo' } }
    expect(AgentSpec.safeParse({ name: 'a', workspace: bad }).success).toBe(false)
    const zero = { ...giteaCredentialWorkspace, credential: { provider: 'gitea', repoId: '0' } }
    expect(AgentSpec.safeParse({ name: 'a', workspace: zero }).success).toBe(false)
  })
})

describe('the compiled gitea rule (§7)', () => {
  it('carries the repository id, the single bot user and the signing key inline', () => {
    const parsed = RcHookAssign.parse({ ...hookRule, gitea: { ...hookRule.gitea, host: SELF_HOSTED } })
    expect(parsed.gitea?.repoId).toBe('556677')
    expect(parsed.gitea?.botUserId).toBe('9042')
    expect(parsed.gitea?.signingKey).toBe('a'.repeat(64))
    expect(parsed.gitea?.host).toBe(SELF_HOSTED)
  })

  it('reads through the decode-time view keyed by the rule kind', () => {
    const view = codeHostHookRuleOf(RcHookAssign.parse(hookRule))
    expect(view?.provider).toBe('gitea')
    expect(view?.repo).toEqual({ provider: 'gitea', externalId: '556677', path: 'example-org/example-repo' })
    // A kind whose member is absent carries no rule at all, so a consumer fails closed.
    expect(codeHostHookRuleOf({ kind: 'gitea' })).toBeUndefined()
  })

  it('decodes a rule without a host as gitea.com, and refuses a non-numeric match key', () => {
    expect(resolve(RcHookAssign.parse(hookRule).gitea?.host)).toBe('https://gitea.com')
    expect(RcHookAssign.safeParse({ ...hookRule, gitea: { ...hookRule.gitea, repoId: 'org/repo' } }).success).toBe(
      false
    )
    expect(RcHookAssign.safeParse({ ...hookRule, gitea: { ...hookRule.gitea, signingKey: '' } }).success).toBe(false)
  })
})

describe('the forwarded metadata and the rerun frame', () => {
  it('round-trips the trusted metadata host the relay forwards', () => {
    expect(GiteaHookMetadata.parse({ ...hookMetadata, host: SELF_HOSTED }).host).toBe(SELF_HOSTED)
    expect(resolve(GiteaHookMetadata.parse(hookMetadata).host)).toBe('https://gitea.com')
  })

  it('rides rd/msg as a third optional member beside github and gitlab', () => {
    const parsed = RdMsg.parse({
      source: 'hook',
      agentId: AGENT_ID,
      sessionKey: 'gitea:556677:pull:7',
      msgId: `${HOOK_ID}:delivery-1`,
      hookId: HOOK_ID,
      deliveryKey: 'delivery-1',
      firedAt: '2026-09-12T00:00:00.000Z',
      event: 'merge_request:opened',
      gitea: hookMetadata,
      context: { source: 'gitea', event: 'pull_request', action: 'opened', number: 7 }
    })
    expect(parsed.source === 'hook' ? parsed.gitea?.target : undefined).toEqual({ kind: 'pull', index: 7 })
  })

  it('admits exactly one provider member on rc/hook-rerun', () => {
    const base = {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'rerun_1',
      configRevision: '3',
      dispatchRevision: '5',
      event: 'merge_request:rerun'
    }
    expect(RcHookRerun.safeParse({ ...base, gitea: hookMetadata }).success).toBe(true)
    // The pre-Gitea sender stays valid, and neither two members nor none decode.
    const gitlab = { projectId: '4455667', projectPath: 'g/p', target: { kind: 'issue' as const, iid: 7 } }
    expect(RcHookRerun.safeParse({ ...base, gitlab }).success).toBe(true)
    expect(RcHookRerun.safeParse({ ...base, gitlab, gitea: hookMetadata }).success).toBe(false)
    expect(RcHookRerun.safeParse(base).success).toBe(false)
  })
})

describe('the gitcred purposes (§10.1, §10.2)', () => {
  it('admits the two gitea purposes beside the github and gitlab ones', () => {
    for (const purpose of ['gitea_hook_reply', 'gitea_effect', 'gitlab_effect', 'github_hook_reply']) {
      expect(GitCredRequest.safeParse({ agentId: AGENT_ID, purpose }).success, purpose).toBe(true)
    }
    expect(GitCredRequest.safeParse({ agentId: AGENT_ID, purpose: 'gitea_review' }).success).toBe(false)
  })
})
