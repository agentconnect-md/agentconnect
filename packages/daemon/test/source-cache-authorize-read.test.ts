import { describe, expect, it } from 'vitest'
import { AgentSchema, type Agent } from '../src/agents/agent-schema.js'
import type { CodeHostRefResolver, ResolveRefRequest } from '../src/codehost/ref-resolver.js'
import type { RepositoryReadTokens, RepositoryTokenAsk, ResolveRefResult } from '../src/codehost/repository.js'
import { GitCredUnavailableError } from '../src/cp/git-credential.js'
import { createCredentialedCacheReadAuthorizer } from '../src/source-cache/index.js'

const SHA = 'e'.repeat(40)

function agent(workspace: Record<string, unknown>, extra: Record<string, unknown> = {}): Agent {
  return AgentSchema.parse({
    id: 'agent-1',
    name: 'agent-1',
    status: 'active',
    runtime: 'claude',
    workspace: { path: '/tmp/ws', ...workspace },
    integrations: [],
    output: { mode: 'low' },
    ...extra
  })
}

function harness(opts: { echo?: string; tokenError?: Error; result?: ResolveRefResult } = {}) {
  const asks: RepositoryTokenAsk[] = []
  const requests: ResolveRefRequest[] = []
  const tokens: RepositoryReadTokens = {
    async get(_agentId, ask) {
      asks.push(ask)
      if (opts.tokenError) throw opts.tokenError
      return { token: 't', ...(opts.echo !== undefined ? { externalRepoId: opts.echo } : {}) }
    },
    invalidate() {}
  }
  const resolver: Pick<CodeHostRefResolver, 'resolveRef'> = {
    async resolveRef(request) {
      requests.push(request)
      return opts.result ?? { ok: true, commit: SHA, checkedAt: 42 }
    }
  }
  return { authorize: createCredentialedCacheReadAuthorizer({ resolver, tokens }), asks, requests }
}

const github = {
  mode: 'git-repo',
  gitRepo: 'https://github.com/Acme/Infra',
  gitBranch: 'dev',
  gitCredential: 'github-app'
}
const gitlab = {
  mode: 'git-repo',
  gitRepo: 'https://gitlab.com/group/sub/proj.git',
  gitCredential: 'gitlab',
  gitlabProjectId: '77'
}

describe('authorizeCredentialedCacheRead', () => {
  it('refuses anonymous and scratch workspaces without asking for a token', async () => {
    const h = harness()
    expect(await h.authorize(agent({ mode: 'git-repo', gitRepo: 'https://github.com/acme/pub' }))).toMatchObject({
      ok: false,
      reason: 'anonymous'
    })
    expect(await h.authorize(agent({ mode: 'from-scratch', gitCredential: 'github-app' }))).toMatchObject({
      ok: false,
      reason: 'anonymous'
    })
    expect(h.asks).toHaveLength(0)
  })

  it('resolves a GitHub workspace under the id the grant echoed', async () => {
    const h = harness({ echo: '501' })
    expect(await h.authorize(agent(github))).toEqual({
      ok: true,
      repository: { provider: 'github', externalId: '501' },
      credRepoId: 'github:501',
      ref: 'refs/heads/dev',
      commit: SHA,
      checkedAt: 42
    })
    expect(h.asks[0]).toEqual({ plane: 'git' })
    expect(h.requests[0]).toMatchObject({
      agentId: 'agent-1',
      ref: 'refs/heads/dev',
      repository: { provider: 'github', externalId: '501', path: 'acme/infra' }
    })
  })

  it('refuses a GitHub workspace whose grant echoed no id', async () => {
    const h = harness()
    expect(await h.authorize(agent(github))).toEqual({ ok: false, reason: 'unavailable', detail: 'identity_unknown' })
    expect(h.requests).toHaveLength(0)
  })

  it('resolves a GitLab workspace by the spec project id on the read plane', async () => {
    const h = harness({ echo: '77' })
    expect(await h.authorize(agent(gitlab))).toMatchObject({
      ok: true,
      credRepoId: 'gitlab:77',
      ref: 'refs/heads/main'
    })
    expect(h.asks[0]).toEqual({ plane: 'glab', provider: 'gitlab', externalRepoId: '77', requestedAccess: 'read' })
    expect(h.requests[0]!.repository).toMatchObject({ provider: 'gitlab', externalId: '77', path: 'group/sub/proj' })
  })

  it('addresses a self-managed instance through its path prefix', async () => {
    const h = harness({ echo: '77' })
    const self = { ...gitlab, gitRepo: 'https://git.example.com/gitlab/group/proj.git' }
    expect(await h.authorize(agent(self, { gitlabHost: 'https://git.example.com/gitlab' }))).toMatchObject({ ok: true })
    expect(h.requests[0]).toMatchObject({
      hosts: { gitlabHost: 'https://git.example.com/gitlab' },
      repository: { path: 'group/proj' }
    })
  })

  it('refuses when the spec id and the grant echo disagree', async () => {
    const h = harness({ echo: '78' })
    expect(await h.authorize(agent(gitlab))).toMatchObject({ ok: false, reason: 'replaced' })
  })

  it('refuses an origin that is not on the managed host', async () => {
    const h = harness({ echo: '77' })
    expect(await h.authorize(agent({ ...gitlab, gitRepo: 'https://elsewhere.example/group/proj.git' }))).toMatchObject({
      ok: false,
      detail: 'identity_unknown'
    })
    expect(h.asks).toHaveLength(0)
  })

  it('maps a credential refusal to access_denied', async () => {
    const h = harness({ tokenError: new GitCredUnavailableError('no', true, 'agent') })
    expect(await h.authorize(agent(gitlab))).toMatchObject({ ok: false, reason: 'access_denied' })
  })

  it('passes a resolver failure through unchanged', async () => {
    const h = harness({
      echo: '501',
      result: { ok: false, reason: 'ref_not_found', detail: 'status_404', checkedAt: 1 }
    })
    expect(await h.authorize(agent(github))).toEqual({ ok: false, reason: 'ref_not_found', detail: 'status_404' })
  })
})
