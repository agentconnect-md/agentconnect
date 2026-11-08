// The GitHub broker: pull requests, issues, and comments under the agent's own grant, draft state through GraphQL.
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

// A fakeFetch entry that answers 404.
const MISSING = Symbol('missing')

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
    if (body === MISSING) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    // An undefined entry answers with an empty 2xx body.
    const text = body === undefined ? null : JSON.stringify(body)
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
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
      capabilities: ['contents', 'issues', 'pull_requests']
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

  it('reads the full published description so initiator attribution beyond the model read budget survives edits', async () => {
    const body = 'x'.repeat(5000) + '\n<!-- agentconnect:attribution -->kept'
    const { fetchImpl, calls } = fakeFetch([{ ...PULL, body }])
    expect(await broker(fetchImpl).execute(TARGET, { kind: 'readMergeRequestDescription', iid: 42 })).toBe(body)
    expect(calls[0]!.method).toBe('GET')
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
      broker(fetchImpl).execute(TARGET, { kind: 'readDiscussions', subject: 'issue', iid: 1 })
    ).rejects.toThrow('GitHub readDiscussions is not available through this broker')
    await expect(
      broker(fetchImpl).execute(TARGET, { kind: 'controlPipeline', action: 'retry_pipeline', pipelineId: '1' })
    ).rejects.toThrow('GitHub controlPipeline is not available through this broker')
    expect(calls).toEqual([])
  })

  const COMMENT = {
    id: 9001,
    body: 'Looks good',
    user: { login: 'example-bot' },
    html_url: 'https://github.example.test/example-org/example-repo/pull/42#issuecomment-9001',
    created_at: '2026-11-06T10:00:00Z'
  }

  it('comments on a pull request through the issue comments endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch([COMMENT])
    const result = await broker(fetchImpl, 'comment').execute(TARGET, {
      kind: 'createComment',
      subject: 'merge_request',
      iid: 42,
      body: 'Looks good'
    })
    expect(calls).toEqual([
      { method: 'POST', url: `${BASE}/repos/example-org/example-repo/issues/42/comments`, body: { body: 'Looks good' } }
    ])
    expect(result).toEqual({
      comment: {
        id: '9001',
        body: 'Looks good',
        author: 'example-bot',
        htmlUrl: COMMENT.html_url,
        createdAt: '2026-11-06T10:00:00Z'
      }
    })
  })

  it('edits only a comment this session created in this repository', async () => {
    const { fetchImpl, calls } = fakeFetch([COMMENT, { ...COMMENT, body: 'Edited' }])
    const gh = broker(fetchImpl, 'comment')
    await gh.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 7, body: 'Looks good' })
    const update = { kind: 'updateComment' as const, subject: 'issue' as const, iid: 7, noteId: '9001', body: 'Edited' }
    await expect(gh.execute({ ...TARGET, sessionKey: 'session-2' }, update)).rejects.toThrow(
      'only a comment this session created through the broker can be updated'
    )
    await expect(
      gh.execute({ ...TARGET, repoId: 'example-org/other-repo', repoPath: 'example-org/other-repo' }, update)
    ).rejects.toThrow('only a comment this session created through the broker can be updated')
    await expect(gh.execute(TARGET, { ...update, noteId: '9002' })).rejects.toThrow('only a comment')
    await expect(gh.execute(TARGET, { ...update, noteId: '../9001' })).rejects.toThrow('positive decimal id')
    expect(calls).toHaveLength(1)
    const result = (await gh.execute(TARGET, update)) as { comment: { body: string } }
    expect(calls[1]).toEqual({
      method: 'PATCH',
      url: `${BASE}/repos/example-org/example-repo/issues/comments/9001`,
      body: { body: 'Edited' }
    })
    expect(result.comment.body).toBe('Edited')
  })

  it('applies labels, assignees and reviewers after a pull request opens, checking every endpoint first', async () => {
    const { fetchImpl, calls } = fakeFetch([
      PULL,
      { number: 42, labels: [{ name: 'bug' }], assignees: [{ login: 'example-dev' }] },
      { ...PULL, requested_reviewers: [{ login: 'example-reviewer' }] }
    ])
    const result = await broker(fetchImpl).execute(TARGET, {
      kind: 'createMergeRequest',
      sourceBranch: 'feature',
      targetBranch: 'main',
      title: 'Add a thing',
      labels: ['bug'],
      assignees: ['example-dev'],
      reviewers: ['example-reviewer']
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${BASE}/repos/example-org/example-repo/pulls`,
        body: { title: 'Add a thing', head: 'feature', base: 'main' }
      },
      {
        method: 'PATCH',
        url: `${BASE}/repos/example-org/example-repo/issues/42`,
        body: { labels: ['bug'], assignees: ['example-dev'] }
      },
      {
        method: 'POST',
        url: `${BASE}/repos/example-org/example-repo/pulls/42/requested_reviewers`,
        body: { reviewers: ['example-reviewer'] }
      }
    ])
    expect(result).toMatchObject({
      pullRequest: { number: 42, labels: ['bug'], assignees: ['example-dev'], reviewers: ['example-reviewer'] }
    })
  })

  it('refuses a malformed reviewer before opening anything', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL])
    await expect(
      broker(fetchImpl).execute(TARGET, {
        kind: 'createMergeRequest',
        sourceBranch: 'feature',
        targetBranch: 'main',
        title: 'x',
        reviewers: ['../admin']
      })
    ).rejects.toThrow('reviewers must hold usernames')
    expect(calls).toEqual([])
  })

  it('adds and removes labels and assignees on a pull request without a pulls PATCH or a replacing issue PATCH', async () => {
    const { fetchImpl, calls } = fakeFetch([
      PULL,
      [{ name: 'wip' }, { name: 'ready' }],
      [{ name: 'ready' }],
      MISSING,
      { number: 42, assignees: [{ login: 'example-old' }, { login: 'example-dev' }] },
      { number: 42, assignees: [{ login: 'example-dev' }] }
    ])
    const result = await broker(fetchImpl).execute(TARGET, {
      kind: 'updateMergeRequest',
      iid: 42,
      addLabels: ['ready'],
      removeLabels: ['wip', 'needs review'],
      addAssignees: ['example-dev'],
      removeAssignees: ['example-old']
    })
    const issue = `${BASE}/repos/example-org/example-repo/issues/42`
    expect(calls).toEqual([
      { method: 'GET', url: `${BASE}/repos/example-org/example-repo/pulls/42` },
      { method: 'POST', url: `${issue}/labels`, body: { labels: ['ready'] } },
      { method: 'DELETE', url: `${issue}/labels/wip` },
      { method: 'DELETE', url: `${issue}/labels/needs%20review` },
      { method: 'POST', url: `${issue}/assignees`, body: { assignees: ['example-dev'] } },
      { method: 'DELETE', url: `${issue}/assignees`, body: { assignees: ['example-old'] } }
    ])
    expect(result).toMatchObject({ pullRequest: { number: 42, labels: ['ready'], assignees: ['example-dev'] } })
  })

  it('refuses an update that both adds and removes one name, or removes a dot-only label, before any request', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL])
    const gh = broker(fetchImpl)
    await expect(
      gh.execute(TARGET, { kind: 'updateMergeRequest', iid: 42, addLabels: ['bug'], removeLabels: ['bug'] })
    ).rejects.toThrow('cannot both add and remove "bug"')
    await expect(gh.execute(TARGET, { kind: 'updateIssue', iid: 7, removeLabels: ['..'] })).rejects.toThrow(
      'cannot remove a label named ".."'
    )
    expect(calls).toEqual([])
  })

  it('edits fields and requests reviewers on an existing pull request', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL, { ...PULL, requested_reviewers: [{ login: 'example-reviewer' }] }])
    await broker(fetchImpl).execute(TARGET, {
      kind: 'updateMergeRequest',
      iid: 42,
      title: 'Renamed',
      reviewers: ['example-reviewer']
    })
    expect(calls).toEqual([
      { method: 'PATCH', url: `${BASE}/repos/example-org/example-repo/pulls/42`, body: { title: 'Renamed' } },
      {
        method: 'POST',
        url: `${BASE}/repos/example-org/example-repo/pulls/42/requested_reviewers`,
        body: { reviewers: ['example-reviewer'] }
      }
    ])
  })

  it('merges a pull request with the chosen method and expected head', async () => {
    const sha = 'a'.repeat(40)
    const { fetchImpl, calls } = fakeFetch([
      { merged: true, sha: 'b'.repeat(40), message: 'Pull Request successfully merged' }
    ])
    const result = await broker(fetchImpl).execute(TARGET, {
      kind: 'mergeMergeRequest',
      iid: 42,
      method: 'squash',
      sha
    })
    expect(calls).toEqual([
      {
        method: 'PUT',
        url: `${BASE}/repos/example-org/example-repo/pulls/42/merge`,
        body: { merge_method: 'squash', sha }
      }
    ])
    expect(result).toEqual({ merged: true, sha: 'b'.repeat(40), message: 'Pull Request successfully merged' })
  })

  it('reads an empty merge answer as merged and sends an empty body when nothing is chosen', async () => {
    const { fetchImpl, calls } = fakeFetch([undefined])
    const result = await broker(fetchImpl).execute(TARGET, { kind: 'mergeMergeRequest', iid: 42 })
    expect(calls).toEqual([{ method: 'PUT', url: `${BASE}/repos/example-org/example-repo/pulls/42/merge`, body: {} }])
    expect(result).toEqual({ merged: true })
  })

  it('refuses a merge on a read lease before any request', async () => {
    const { fetchImpl, calls } = fakeFetch([{ merged: true }])
    await expect(broker(fetchImpl, 'read').execute(TARGET, { kind: 'mergeMergeRequest', iid: 42 })).rejects.toThrow(
      'needs write authority'
    )
    expect(calls).toEqual([])
  })

  it('closes a pull request through the pulls endpoint and reopens an issue through the issues endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { ...PULL, state: 'closed' },
      {
        number: 7,
        title: 'Bug',
        state: 'open',
        html_url: 'https://github.example.test/example-org/example-repo/issues/7'
      }
    ])
    const gh = broker(fetchImpl)
    const pull = await gh.execute(TARGET, { kind: 'setState', subject: 'merge_request', iid: 42, state: 'closed' })
    const issue = await gh.execute(TARGET, { kind: 'setState', subject: 'issue', iid: 7, state: 'open' })
    expect(calls).toEqual([
      { method: 'PATCH', url: `${BASE}/repos/example-org/example-repo/pulls/42`, body: { state: 'closed' } },
      { method: 'PATCH', url: `${BASE}/repos/example-org/example-repo/issues/7`, body: { state: 'open' } }
    ])
    expect(pull).toMatchObject({ pullRequest: { number: 42, state: 'closed' } })
    expect(issue).toEqual({
      issue: {
        number: 7,
        title: 'Bug',
        state: 'open',
        htmlUrl: 'https://github.example.test/example-org/example-repo/issues/7'
      }
    })
  })

  it('opens an issue with labels and assignees and returns a bounded view', async () => {
    const labels = Array.from({ length: 30 }, (_, i) => ({ name: `label-${i}`, color: 'ffffff' }))
    const { fetchImpl, calls } = fakeFetch([
      { number: 8, title: 'Bug', state: 'open', html_url: 'https://github.example.test/i/8', labels, body: 'long' }
    ])
    const result = (await broker(fetchImpl).execute(TARGET, {
      kind: 'createIssue',
      title: 'Bug',
      description: 'Steps',
      labels: ['bug'],
      assignees: ['example-dev']
    })) as { issue: { labels: string[] } }
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${BASE}/repos/example-org/example-repo/issues`,
        body: { title: 'Bug', body: 'Steps', labels: ['bug'], assignees: ['example-dev'] }
      }
    ])
    expect(Object.keys(result.issue).sort()).toEqual(['htmlUrl', 'labels', 'number', 'state', 'title'])
    expect(result.issue.labels).toHaveLength(20)
  })

  it('updates only the issue fields that were given, then adds a label', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { number: 8, title: 'Renamed', state: 'open', labels: [] },
      [{ name: 'bug' }]
    ])
    const gh = broker(fetchImpl)
    const result = await gh.execute(TARGET, { kind: 'updateIssue', iid: 8, title: 'Renamed', addLabels: ['bug'] })
    const issue = `${BASE}/repos/example-org/example-repo/issues/8`
    expect(calls).toEqual([
      { method: 'PATCH', url: issue, body: { title: 'Renamed' } },
      { method: 'POST', url: `${issue}/labels`, body: { labels: ['bug'] } }
    ])
    expect(result).toEqual({ issue: { number: 8, title: 'Renamed', state: 'open', labels: ['bug'] } })
    await expect(gh.execute(TARGET, { kind: 'updateIssue', iid: 8 })).rejects.toThrow('names nothing to change')
    await expect(
      gh.execute(TARGET, { kind: 'updateIssue', iid: 8, addLabels: [], removeAssignees: [] })
    ).rejects.toThrow('names nothing to change')
    expect(calls).toHaveLength(2)
  })

  it('reads the issue for a label-only change instead of patching it', async () => {
    const { fetchImpl, calls } = fakeFetch([{ number: 8, title: 'Bug', state: 'open', labels: [{ name: 'bug' }] }, []])
    const result = await broker(fetchImpl).execute(TARGET, { kind: 'updateIssue', iid: 8, removeLabels: ['bug'] })
    const issue = `${BASE}/repos/example-org/example-repo/issues/8`
    expect(calls).toEqual([
      { method: 'GET', url: issue },
      { method: 'DELETE', url: `${issue}/labels/bug` }
    ])
    expect(result).toEqual({ issue: { number: 8, title: 'Bug', state: 'open', labels: [] } })
  })

  it('refuses an issue label change on a comment lease before any request', async () => {
    const { fetchImpl, calls } = fakeFetch([{ number: 8 }])
    await expect(
      broker(fetchImpl, 'comment').execute(TARGET, { kind: 'updateIssue', iid: 8, addAssignees: ['example-dev'] })
    ).rejects.toThrow('needs write authority')
    expect(calls).toEqual([])
  })

  it('lets a comment lease comment but not open an issue', async () => {
    const { fetchImpl, calls } = fakeFetch([COMMENT])
    const gh = broker(fetchImpl, 'comment')
    await gh.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 7, body: 'Looks good' })
    await expect(gh.execute(TARGET, { kind: 'createIssue', title: 'Bug' })).rejects.toThrow('needs write authority')
    expect(calls.map((c) => c.method)).toEqual(['POST'])
  })

  it('lets a comment-tier grant comment although GitHub echoes its contents level as read', async () => {
    const { fetchImpl, calls } = fakeFetch([COMMENT])
    const gh = broker(fetchImpl, 'read')
    await gh.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 7, body: 'Looks good' })
    expect(calls.map((c) => c.method)).toEqual(['POST'])
    await expect(gh.execute(TARGET, { kind: 'createIssue', title: 'Bug' })).rejects.toThrow('needs write authority')
    expect(calls).toHaveLength(1)
  })

  it('answers a read-tier token GitHub refuses a comment with as a missing comment authority', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 })
    }) as typeof fetch
    await expect(
      broker(fetchImpl, 'read').execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 7, body: 'hi' })
    ).rejects.toThrow('needs comment authority on the GitHub repository, but the current authorization grants read')
    expect(calls).toHaveLength(1)
  })

  it('refuses a pull request edit naming reviewers on a comment lease before any request', async () => {
    const { fetchImpl, calls } = fakeFetch([PULL])
    await expect(
      broker(fetchImpl, 'comment').execute(TARGET, { kind: 'updateMergeRequest', iid: 42, reviewers: ['example-dev'] })
    ).rejects.toThrow('needs write authority')
    expect(calls).toEqual([])
  })
})
