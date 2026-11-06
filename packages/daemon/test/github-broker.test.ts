// The GitHub broker: opening and editing a pull request under the agent's own grant, draft state through GraphQL.
import { describe, expect, it } from 'vitest'
import type { GitCredGrant } from '@agentconnect.md/protocol'
import { GithubBroker } from '../src/github/broker.js'
import { GitCredentialCache, type GitCredentialCacheDeps } from '../src/cp/git-credential.js'
import type { BrokerCapability, CodeHostEffectTarget } from '../src/codehost/broker.js'

const BASE = 'https://api.github.example.test'
const TARGET: CodeHostEffectTarget = {
  agentId: 'agent-1',
  provider: 'github',
  repoId: 'example-org/example-repo',
  repoPath: 'example-org/example-repo',
  sessionKey: 'session-1'
}

const PULL = {
  number: 42,
  node_id: 'PR_node42',
  title: 'Add a thing',
  state: 'open',
  draft: false,
  html_url: 'https://github.com/example-org/example-repo/pull/42',
  head: { ref: 'feature' },
  base: { ref: 'main' }
}

interface Call {
  method: string
  url: string
  body?: Record<string, unknown>
}

function fakeFetch(bodies: unknown[]) {
  const calls: Call[] = []
  let n = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> })
    })
    const body = bodies[Math.min(n++, bodies.length - 1)]
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function broker(fetchImpl: typeof fetch, access: BrokerCapability = 'write') {
  return new GithubBroker({ lease: async () => ({ token: 'gh-token', access }), baseUrl: BASE, fetchImpl })
}

describe('the lease the daemon mints for the GitHub broker', () => {
  // The CP's mint reports a grant's access from its contents level, absent contents reading as `read` (installation-token.service.ts).
  function cpMint(tier: 'read' | 'write') {
    const seen: Parameters<GitCredentialCacheDeps['request']>[0][] = []
    const request: GitCredentialCacheDeps['request'] = async (payload) => {
      seen.push(payload)
      const grant: GitCredGrant = {
        username: 'x-access-token',
        token: `gh-${tier}`,
        ttlSec: 3600,
        expiresAt: '2026-11-06T12:00:00.000Z',
        repoFullName: payload.repoFullName ?? '',
        access: payload.capabilities?.includes('contents') ? tier : 'read'
      }
      return grant
    }
    const cache = new GitCredentialCache({ request, log: { warn: () => {} } })
    return { cache, seen }
  }

  function brokerOn(cache: GitCredentialCache, fetchImpl: typeof fetch) {
    return new GithubBroker({
      lease: async (target) => {
        const entry = await cache.getGithubEffectToken(target.agentId, target.repoPath ?? target.repoId)
        return { token: entry.token, access: entry.access }
      },
      baseUrl: BASE,
      fetchImpl
    })
  }

  const create = {
    kind: 'createMergeRequest' as const,
    sourceBranch: 'feature',
    targetBranch: 'main',
    title: 'Add a thing'
  }

  it('carries a write repository tier through to the broker, so a pull request opens', async () => {
    const { cache, seen } = cpMint('write')
    const { fetchImpl, calls } = fakeFetch([PULL])
    await brokerOn(cache, fetchImpl).execute(TARGET, create)
    expect(seen[0]).toMatchObject({
      repoFullName: 'example-org/example-repo',
      capabilities: ['contents', 'pull_requests']
    })
    expect(calls.map((c) => c.method)).toEqual(['POST'])
  })

  it('refuses before any write on a read-only repository', async () => {
    const { cache } = cpMint('read')
    const { fetchImpl, calls } = fakeFetch([PULL])
    await expect(brokerOn(cache, fetchImpl).execute(TARGET, create)).rejects.toThrow('needs write authority')
    expect(calls).toEqual([])
  })
})

describe('GithubBroker', () => {
  it('opens a pull request from the trusted repository with only the settable fields', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL])
    const result = await broker(fetchImpl).execute(TARGET, {
      kind: 'createMergeRequest',
      sourceBranch: 'feature',
      targetBranch: 'main',
      title: 'Add a thing',
      description: 'Body',
      draft: true
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${BASE}/repos/example-org/example-repo/pulls`,
        body: { title: 'Add a thing', head: 'feature', base: 'main', body: 'Body', draft: true }
      }
    ])
    expect(result).toEqual({
      pullRequest: {
        number: 42,
        title: 'Add a thing',
        state: 'open',
        draft: false,
        htmlUrl: PULL.html_url,
        sourceBranch: 'feature',
        targetBranch: 'main'
      }
    })
  })

  it('edits fields with REST and moves draft state through GraphQL by the node id', async () => {
    const { fetchImpl, calls } = fakeFetch([
      PULL,
      { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } }
    ])
    const result = (await broker(fetchImpl).execute(TARGET, {
      kind: 'updateMergeRequest',
      iid: 42,
      description: 'New body',
      draft: true
    })) as { pullRequest: { draft: boolean } }
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PATCH', `${BASE}/repos/example-org/example-repo/pulls/42`],
      ['POST', `${BASE}/graphql`]
    ])
    expect(calls[0]!.body).toEqual({ body: 'New body' })
    expect(calls[1]!.body).toMatchObject({ variables: { id: 'PR_node42' } })
    expect(String(calls[1]!.body!.query)).toContain('convertPullRequestToDraft')
    expect(result.pullRequest.draft).toBe(true)
  })

  it('reads the pull request for a draft-only change and skips GraphQL when the state already matches', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL])
    await broker(fetchImpl).execute(TARGET, { kind: 'updateMergeRequest', iid: 42, draft: false })
    expect(calls.map((c) => [c.method, c.url])).toEqual([['GET', `${BASE}/repos/example-org/example-repo/pulls/42`]])
  })

  it('reports a GraphQL error instead of claiming the draft state moved', async () => {
    const { fetchImpl } = fakeFetch([PULL, { errors: [{ message: 'Resource not accessible by integration' }] }])
    await expect(
      broker(fetchImpl).execute(TARGET, { kind: 'updateMergeRequest', iid: 42, draft: true })
    ).rejects.toThrow('GitHub could not change the draft state: Resource not accessible by integration')
  })

  it('refuses below write authority and every operation it does not implement', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL])
    await expect(
      broker(fetchImpl, 'read').execute(TARGET, {
        kind: 'createMergeRequest',
        sourceBranch: 'feature',
        targetBranch: 'main',
        title: 'x'
      })
    ).rejects.toThrow('needs write authority')
    await expect(
      broker(fetchImpl).execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 1, body: 'x' })
    ).rejects.toThrow('GitHub createComment is not available through this broker')
    expect(calls).toEqual([])
  })
})
