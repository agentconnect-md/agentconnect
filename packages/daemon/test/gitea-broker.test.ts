// Gitea structured mutation broker (gitea-integration.md §10.2): allowlisted endpoints, clamped
// capabilities, a daemon-held effect lease, refusals for what Gitea lacks, and bounded structured results.
import { describe, it, expect, vi } from 'vitest'
import { GiteaBroker, GITEA_BROKER_ENDPOINTS } from '../src/gitea/broker.js'
import type { BrokerCapability, CodeHostBrokerOperation, CodeHostEffectTarget } from '../src/codehost/broker.js'

const BASE = 'https://gitea.example.test:8443/gitea/api/v1'
const REPO = `${BASE}/repos/example-org/example-repo`
const ORG = `${BASE}/orgs/example-org`
const TARGET: CodeHostEffectTarget = {
  agentId: 'agent-1',
  provider: 'gitea',
  repoId: '556677',
  repoPath: 'example-org/example-repo',
  sessionKey: 'session-1'
}

interface Call {
  method: string
  url: string
  token: string
  contentType?: string
  body?: unknown
}

/** `statuses` is the per-attempt response status; anything omitted succeeds with the queued body. */
function fakeFetch(opts: { statuses?: number[]; bodies?: string[]; body?: string } = {}) {
  const calls: Call[] = []
  let n = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const index = n
    n += 1
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      token: headers['authorization'] ?? '',
      ...(headers['content-type'] !== undefined ? { contentType: headers['content-type'] } : {}),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) })
    })
    const status = opts.statuses?.[index]
    if (status !== undefined && status >= 400) return new Response('{"message":"Forbidden"}', { status })
    return new Response(opts.bodies?.[index] ?? opts.body ?? '{"id":9001}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function broker(
  fetchImpl: typeof fetch,
  opts: { access?: BrokerCapability; tokens?: string[]; invalidate?: (token: string) => void } = {}
) {
  const tokens = opts.tokens ?? ['gitea-effect']
  let minted = 0
  const instance = new GiteaBroker({
    lease: async () => ({ token: tokens[Math.min(minted++, tokens.length - 1)]!, access: opts.access ?? 'write' }),
    invalidateLease: (_target, token) => opts.invalidate?.(token),
    apiBaseUrl: () => BASE,
    fetchImpl
  })
  return { instance, minted: () => minted }
}

async function run(
  op: CodeHostBrokerOperation,
  opts: Parameters<typeof broker>[1] = {},
  fetchOpts: Parameters<typeof fakeFetch>[0] = {},
  target: CodeHostEffectTarget = TARGET
) {
  const { fetchImpl, calls } = fakeFetch(fetchOpts)
  const { instance } = broker(fetchImpl, opts)
  const result = await instance.execute(target, op)
  return { result, calls }
}

describe('the allowlist is the whole surface', () => {
  it('declares only bounded methods and repository-scoped templated paths', () => {
    for (const [id, endpoint] of Object.entries(GITEA_BROKER_ENDPOINTS)) {
      expect(['GET', 'POST', 'PATCH', 'DELETE'], id).toContain(endpoint.method)
      // Only the organization label list sits outside the repository, under the same owner.
      expect(endpoint.path.startsWith('/repos/:owner/:repo') || endpoint.path === '/orgs/:owner/labels', id).toBe(true)
      expect(endpoint.path, id).not.toContain('?')
    }
  })

  it('classifies every endpoint into a read, comment, or write capability', () => {
    const byCapability = (capability: BrokerCapability) =>
      Object.entries(GITEA_BROKER_ENDPOINTS)
        .filter(([, endpoint]) => endpoint.capability === capability)
        .map(([id]) => id)
        .sort()
    expect(byCapability('read')).toEqual([
      'comment.get',
      'comment.list',
      'issue.get',
      'label.list',
      'org.label.list',
      'pull.get',
      'review.list',
      'status.list'
    ])
    expect(byCapability('comment')).toEqual(['comment.create', 'comment.update'])
    expect(byCapability('write')).toEqual([
      'issue.create',
      'issue.label.remove',
      'issue.labels.add',
      'issue.update',
      'pull.create',
      'pull.merge',
      'pull.reviewers.request',
      'pull.update'
    ])
  })
})

describe('each operation calls exactly its allowlisted endpoints', () => {
  it('creates a comment through the issues path for an issue and a pull request alike', async () => {
    const issue = await run({ kind: 'createComment', subject: 'issue', iid: 12, body: 'hello' })
    expect(issue.calls).toHaveLength(1)
    expect(issue.calls[0]).toMatchObject({
      method: 'POST',
      url: `${REPO}/issues/12/comments`,
      token: 'token gitea-effect',
      contentType: 'application/json',
      body: { body: 'hello' }
    })
    expect(issue.result).toEqual({ comment: { id: '9001' } })
    const pull = await run({ kind: 'createComment', subject: 'merge_request', iid: 77, body: 'hi' })
    expect(pull.calls[0]?.url).toBe(`${REPO}/issues/77/comments`)
  })

  it('reads an issue with its comments, and a pull request with its comments and reviews', async () => {
    const issue = await run(
      { kind: 'readDiscussions', subject: 'issue', iid: 12, limit: 500 },
      {},
      {
        bodies: [
          '{"id":1,"number":12,"title":"db down","state":"open","user":{"login":"alice"},"labels":[{"name":"bug"}]}',
          '[{"id":5,"body":"first","user":{"login":"bob"}}]'
        ]
      }
    )
    expect(issue.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${REPO}/issues/12`],
      ['GET', `${REPO}/issues/12/comments?limit=20`]
    ])
    expect(issue.calls[0]?.contentType).toBeUndefined()
    expect(issue.result).toEqual({
      issue: { id: '1', number: 12, title: 'db down', state: 'open', author: 'alice', labels: ['bug'] },
      comments: [{ id: '5', body: 'first', author: 'bob' }]
    })
    const pull = await run(
      { kind: 'readDiscussions', subject: 'merge_request', iid: 77 },
      {},
      {
        bodies: [
          '{"id":2,"number":77,"title":"tighten retry","state":"open","draft":true,"merged":false,"mergeable":true,"head":{"ref":"feature/x","sha":"abc"},"base":{"ref":"main"}}',
          '[]',
          '[{"id":987,"state":"APPROVED","body":"ship it","user":{"login":"alice"},"commit_id":"abc","comments_count":2}]'
        ]
      }
    )
    expect(pull.calls.map((c) => c.url)).toEqual([
      `${REPO}/pulls/77`,
      `${REPO}/issues/77/comments?limit=20`,
      `${REPO}/pulls/77/reviews?limit=20`
    ])
    expect(pull.result).toEqual({
      pullRequest: {
        id: '2',
        number: 77,
        title: 'tighten retry',
        state: 'open',
        labels: [],
        draft: true,
        merged: false,
        mergeable: true,
        head: 'feature/x',
        headSha: 'abc',
        base: 'main'
      },
      comments: [],
      reviews: [{ id: '987', state: 'APPROVED', body: 'ship it', author: 'alice', commitId: 'abc', commentsCount: 2 }]
    })
  })

  it('reads one comment when a discussion id is given — Gitea has no discussion objects', async () => {
    const { calls } = await run({ kind: 'readDiscussions', subject: 'merge_request', iid: 77, discussionId: '4242' })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${REPO}/issues/comments/4242` })
  })

  it('creates a pull request from bounded fields only, with the WIP prefix Gitea recognizes', async () => {
    const { calls } = await run({
      kind: 'createMergeRequest',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title: 'Add x',
      description: 'why',
      draft: true
    })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${REPO}/pulls`,
      body: { head: 'feature/x', base: 'main', title: 'WIP: Add x', body: 'why' }
    })
  })

  it('updates a pull request and clears a draft marker of either spelling', async () => {
    for (const title of ['WIP: Add x', '[WIP] Add x', 'Draft: Add x']) {
      const { calls } = await run({ kind: 'updateMergeRequest', iid: 77, title, targetBranch: 'release', draft: false })
      expect(calls[0]).toMatchObject({
        method: 'PATCH',
        url: `${REPO}/pulls/77`,
        body: { title: 'Add x', base: 'release' }
      })
    }
    const untouched = await run({ kind: 'updateMergeRequest', iid: 77, title: '[WIP] Add x' })
    expect((untouched.calls[0]?.body as { title: string }).title).toBe('[WIP] Add x')
  })

  it('reads commit statuses for a branch or a sha under the pipelines scope, filtered client-side', async () => {
    const { calls, result } = await run(
      { kind: 'inspectPipelines', scope: 'pipelines', ref: 'main', status: 'success', limit: 5 },
      {},
      {
        body: '[{"id":1,"status":"success","context":"agentconnect/reviewer","target_url":"https://console.example.test/s/1"},{"id":2,"status":"pending","context":"ci"}]'
      }
    )
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${REPO}/commits/main/statuses?limit=5` })
    expect(result).toEqual({
      statuses: [
        { id: '1', state: 'success', context: 'agentconnect/reviewer', targetUrl: 'https://console.example.test/s/1' }
      ]
    })
    const sha = await run({ kind: 'inspectPipelines', scope: 'pipelines', ref: 'a'.repeat(40) }, {}, { body: '[]' })
    expect(sha.calls[0]?.url).toBe(`${REPO}/commits/${'a'.repeat(40)}/statuses?limit=20`)
  })
})

/** A page of repository labels: `filler` unnamed-for-the-test labels first, then the named ones with their ids. */
function labelPage(named: Record<string, number>, filler = 0, fillerFrom = 1000): string {
  const fill = Array.from({ length: filler }, (_unused, index) => ({
    id: fillerFrom + index,
    name: `other-${fillerFrom + index}`
  }))
  return JSON.stringify([...fill, ...Object.entries(named).map(([name, id]) => ({ id, name }))])
}

const PULL =
  '{"id":2,"number":31,"title":"Add x","state":"open","merged":false,"head":{"ref":"feature/x","sha":"abc"},"base":{"ref":"main"}}'
const ISSUE = '{"id":1,"number":12,"title":"db down","state":"open","labels":[{"name":"bug"}]}'
const SHA = 'c'.repeat(40)

describe('labels, people, merge, state, and issues', () => {
  it('creates a pull request with labels by id, assignees, and a review request once it exists', async () => {
    const { calls, result } = await run(
      {
        kind: 'createMergeRequest',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        title: 'Add x',
        labels: ['bug', 'needs-triage'],
        assignees: ['alice'],
        reviewers: ['carol', 'dave']
      },
      {},
      { bodies: [labelPage({ bug: 7 }, 49), labelPage({ 'needs-triage': 77 }), PULL, '[]'] }
    )
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${REPO}/labels?limit=50&page=1`],
      ['GET', `${REPO}/labels?limit=50&page=2`],
      ['POST', `${REPO}/pulls`],
      ['POST', `${REPO}/pulls/31/requested_reviewers`]
    ])
    expect(calls[2]?.body).toEqual({
      head: 'feature/x',
      base: 'main',
      title: 'Add x',
      assignees: ['alice'],
      labels: [7, 77]
    })
    expect(calls[3]?.body).toEqual({ reviewers: ['carol', 'dave'] })
    expect(result).toMatchObject({ pullRequest: { number: 31, head: 'feature/x' } })
  })

  it('stops paging labels once every name is found, and after five full pages', async () => {
    const found = await run(
      { kind: 'createIssue', title: 'db down', labels: ['bug'] },
      {},
      { bodies: [labelPage({ bug: 7 }, 49), ISSUE] }
    )
    expect(found.calls.map((c) => c.url)).toEqual([`${REPO}/labels?limit=50&page=1`, `${REPO}/issues`])
    const pages = Array.from({ length: 5 }, (_unused, page) => labelPage({}, 50, 1000 + page * 50))
    const { fetchImpl, calls } = fakeFetch({ bodies: pages })
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'createIssue', title: 't', labels: ['bug'] })
    ).rejects.toThrow(/no label named "bug" among its first 250 labels/)
    expect(calls.map((c) => c.url)).toEqual([
      ...[1, 2, 3, 4, 5].map((page) => `${REPO}/labels?limit=50&page=${page}`),
      `${ORG}/labels?limit=50&page=1`
    ])
  })

  it('refuses an unknown label name before any write', async () => {
    const { fetchImpl, calls } = fakeFetch({ bodies: [labelPage({ bug: 7 })] })
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'updateMergeRequest', iid: 77, addLabels: ['bug', 'nope'] })
    ).rejects.toThrow(/the Gitea repository and its organization have no label named "nope"$/)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${REPO}/labels?limit=50&page=1`],
      ['GET', `${ORG}/labels?limit=50&page=1`]
    ])
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'createIssue', title: 't', labels: ['a,b'] })
    ).rejects.toThrow(/without commas/)
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'createIssue', title: 't', assignees: ['../x'] })
    ).rejects.toThrow(/assignees must hold usernames/)
    expect(calls).toHaveLength(2)
  })

  it('finds a label the organization defines, and reads a user owner’s 404 as no organization labels', async () => {
    const { calls } = await run(
      { kind: 'createIssue', title: 't', labels: ['bug', 'team'] },
      {},
      { bodies: [labelPage({ bug: 7 }), labelPage({ team: 12 }), ISSUE] }
    )
    expect(calls.map((c) => c.url)).toEqual([
      `${REPO}/labels?limit=50&page=1`,
      `${ORG}/labels?limit=50&page=1`,
      `${REPO}/issues`
    ])
    expect(calls[2]?.body).toMatchObject({ labels: [7, 12] })
    const { fetchImpl, calls: userCalls } = fakeFetch({ statuses: [200, 404], bodies: [labelPage({ bug: 7 })] })
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'createIssue', title: 't', labels: ['team'] })
    ).rejects.toThrow(/have no label named "team"$/)
    expect(userCalls).toHaveLength(2)
  })

  it('updates a pull request by adding and removing labels and assignees, then requests reviewers', async () => {
    const assigned = PULL.replace('"state":"open"', '"state":"open","assignees":[{"login":"alice"},{"login":"dave"}]')
    const { calls, result } = await run(
      {
        kind: 'updateMergeRequest',
        iid: 77,
        addLabels: ['bug'],
        removeLabels: ['stale', 'gone'],
        addAssignees: ['bob'],
        removeAssignees: ['alice'],
        reviewers: ['carol']
      },
      {},
      { bodies: [labelPage({ bug: 7, stale: 8 }), '[]', assigned, '[]', '', PULL, '[]'] }
    )
    // "gone" is in neither list, so it is already absent and skipped.
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', `${REPO}/labels?limit=50&page=1`, undefined],
      ['GET', `${ORG}/labels?limit=50&page=1`, undefined],
      ['GET', `${REPO}/pulls/77`, undefined],
      ['POST', `${REPO}/issues/77/labels`, { labels: [7] }],
      ['DELETE', `${REPO}/issues/77/labels/8`, undefined],
      ['PATCH', `${REPO}/pulls/77`, { assignees: ['dave', 'bob'] }],
      ['POST', `${REPO}/pulls/77/requested_reviewers`, { reviewers: ['carol'] }]
    ])
    expect(result).toMatchObject({ pullRequest: { number: 31 } })
  })

  it('refuses a removal the page cap may have hidden, before any write', async () => {
    const pages = Array.from({ length: 10 }, (_unused, page) => labelPage({}, 50, 1000 + page * 50))
    const { fetchImpl, calls } = fakeFetch({ bodies: pages })
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'updateIssue', iid: 12, removeLabels: ['bug'] })
    ).rejects.toThrow(/no label named "bug" among its first 250 labels/)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls).toHaveLength(10)
  })

  it('requests reviewers alone without an empty edit, and reads the pull request back', async () => {
    const { calls, result } = await run(
      { kind: 'updateMergeRequest', iid: 31, reviewers: ['carol'] },
      {},
      { bodies: ['[]', PULL] }
    )
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${REPO}/pulls/31/requested_reviewers`],
      ['GET', `${REPO}/pulls/31`]
    ])
    expect(result).toMatchObject({ pullRequest: { number: 31 } })
  })

  it('merges with the chosen method and head fence, then reads the empty-answered merge back', async () => {
    const merged = PULL.replace('"merged":false', '"merged":true').replace('"open"', '"closed"')
    const { calls, result } = await run(
      { kind: 'mergeMergeRequest', iid: 31, method: 'squash', sha: SHA },
      {},
      { bodies: ['', merged] }
    )
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', `${REPO}/pulls/31/merge`, { Do: 'squash', head_commit_id: SHA }],
      ['GET', `${REPO}/pulls/31`, undefined]
    ])
    expect(result).toMatchObject({ pullRequest: { number: 31, state: 'closed', merged: true } })
    const plain = await run({ kind: 'mergeMergeRequest', iid: 31 }, {}, { bodies: ['', merged] })
    expect(plain.calls[0]?.body).toEqual({ Do: 'merge' })
    const { fetchImpl, calls: none } = fakeFetch()
    await expect(
      broker(fetchImpl).instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 31, sha: 'abc1234' })
    ).rejects.toThrow(/full commit sha/)
    expect(none).toEqual([])
  })

  it('opens or closes an issue and a pull request through their own edit paths', async () => {
    const issue = await run({ kind: 'setState', subject: 'issue', iid: 12, state: 'closed' }, {}, { body: ISSUE })
    expect(issue.calls).toEqual([
      expect.objectContaining({ method: 'PATCH', url: `${REPO}/issues/12`, body: { state: 'closed' } })
    ])
    expect(issue.result).toMatchObject({ issue: { number: 12 } })
    const pull = await run({ kind: 'setState', subject: 'merge_request', iid: 31, state: 'open' }, {}, { body: PULL })
    expect(pull.calls).toEqual([
      expect.objectContaining({ method: 'PATCH', url: `${REPO}/pulls/31`, body: { state: 'open' } })
    ])
    expect(pull.result).toMatchObject({ pullRequest: { number: 31 } })
  })

  it('creates an issue with labels by id and assignees', async () => {
    const { calls, result } = await run(
      { kind: 'createIssue', title: 'db down', description: 'since 09:00', labels: ['bug'], assignees: ['alice'] },
      {},
      { bodies: [labelPage({ bug: 7 }), ISSUE] }
    )
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${REPO}/labels?limit=50&page=1`],
      ['POST', `${REPO}/issues`]
    ])
    expect(calls[1]?.body).toEqual({ title: 'db down', body: 'since 09:00', assignees: ['alice'], labels: [7] })
    expect(result).toEqual({
      issue: { id: '1', number: 12, title: 'db down', state: 'open', labels: ['bug'] }
    })
  })

  it('updates an issue, adding labels on their own path before the edit', async () => {
    const both = await run(
      { kind: 'updateIssue', iid: 12, title: 'db down again', addLabels: ['bug'] },
      {},
      { bodies: [labelPage({ bug: 7 }), '[{"id":7,"name":"bug"}]', ISSUE] }
    )
    expect(both.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', `${REPO}/labels?limit=50&page=1`, undefined],
      ['POST', `${REPO}/issues/12/labels`, { labels: [7] }],
      ['PATCH', `${REPO}/issues/12`, { title: 'db down again' }]
    ])
    expect(both.result).toMatchObject({ issue: { number: 12, labels: ['bug'] } })
  })

  it('removes a label already gone as a no-op, and reads the issue back without an edit', async () => {
    const { calls, result } = await run(
      { kind: 'updateIssue', iid: 12, removeLabels: ['bug'] },
      {},
      { statuses: [200, 404], bodies: [labelPage({ bug: 7 }), '', ISSUE] }
    )
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${REPO}/labels?limit=50&page=1`],
      ['DELETE', `${REPO}/issues/12/labels/7`],
      ['GET', `${REPO}/issues/12`]
    ])
    expect(result).toMatchObject({ issue: { number: 12 } })
  })

  it('merges assignee changes into the current set, since Gitea edits replace it', async () => {
    const assigned = ISSUE.replace('"state":"open"', '"state":"open","assignees":[{"login":"alice"}]')
    const { calls } = await run(
      { kind: 'updateIssue', iid: 12, addAssignees: ['bob', 'alice'] },
      {},
      { bodies: [assigned, ISSUE] }
    )
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', `${REPO}/issues/12`, undefined],
      ['PATCH', `${REPO}/issues/12`, { assignees: ['alice', 'bob'] }]
    ])
    const { fetchImpl, calls: none } = fakeFetch()
    await expect(broker(fetchImpl).instance.execute(TARGET, { kind: 'updateIssue', iid: 12 })).rejects.toThrow(
      /nothing to update/
    )
    await expect(
      broker(fetchImpl).instance.execute(TARGET, {
        kind: 'updateIssue',
        iid: 12,
        addAssignees: ['bob'],
        removeAssignees: ['bob']
      })
    ).rejects.toThrow(/cannot both add and remove "bob"/)
    expect(none).toEqual([])
  })

  it('refuses above the clamp before any request, lookups included', async () => {
    const cases: [BrokerCapability, CodeHostBrokerOperation, RegExp][] = [
      ['comment', { kind: 'createIssue', title: 't', labels: ['bug'] }, /needs write authority/],
      ['comment', { kind: 'mergeMergeRequest', iid: 31 }, /needs write authority/],
      ['comment', { kind: 'updateMergeRequest', iid: 31, reviewers: ['carol'] }, /needs write authority/],
      ['read', { kind: 'setState', subject: 'issue', iid: 12, state: 'closed' }, /needs write authority/],
      ['read', { kind: 'updateIssue', iid: 12, addLabels: ['bug'] }, /needs write authority/],
      ['comment', { kind: 'updateMergeRequest', iid: 31, removeAssignees: ['alice'] }, /needs write authority/]
    ]
    for (const [access, op, message] of cases) {
      const { fetchImpl, calls } = fakeFetch()
      await expect(broker(fetchImpl, { access }).instance.execute(TARGET, op)).rejects.toThrow(message)
      expect(calls).toEqual([])
    }
  })
})

describe('what Gitea lacks is refused before any request', () => {
  it('refuses threaded replies, pipeline objects, and pipeline control', async () => {
    const cases: [CodeHostBrokerOperation, RegExp][] = [
      [{ kind: 'replyDiscussion', subject: 'merge_request', iid: 77, discussionId: '1', body: 'x' }, /not threaded/],
      [{ kind: 'inspectPipelines', scope: 'pipeline', pipelineId: '31' }, /commit statuses only/],
      [{ kind: 'inspectPipelines', scope: 'pipelines' }, /commit statuses only/],
      [{ kind: 'controlPipeline', action: 'retry_pipeline', pipelineId: '31' }, /cannot be retried or cancelled/]
    ]
    for (const [op, message] of cases) {
      const { fetchImpl, calls } = fakeFetch()
      await expect(broker(fetchImpl).instance.execute(TARGET, op)).rejects.toThrow(message)
      expect(calls).toEqual([])
    }
  })
})

describe('capability classes are enforced against the clamped grant', () => {
  const comment: CodeHostBrokerOperation = { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' }
  const write: CodeHostBrokerOperation = {
    kind: 'createMergeRequest',
    sourceBranch: 'f',
    targetBranch: 'main',
    title: 't'
  }
  const read: CodeHostBrokerOperation = { kind: 'readDiscussions', subject: 'issue', iid: 12 }

  it('lets a read clamp read but refuses comment and write, before reaching Gitea', async () => {
    await expect(run(read, { access: 'read' }, { body: '[]' })).resolves.toBeDefined()
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl, { access: 'read' })
    await expect(instance.execute(TARGET, comment)).rejects.toThrow(
      /needs comment authority on the Gitea repository, but the current authorization grants read/
    )
    await expect(instance.execute(TARGET, write)).rejects.toThrow(/needs write authority/)
    expect(calls).toEqual([])
  })

  it('lets a comment clamp comment but refuses write, and a write clamp do everything', async () => {
    await expect(run(comment, { access: 'comment' })).resolves.toBeDefined()
    await expect(run(write, { access: 'comment' })).rejects.toThrow(/needs write authority/)
    await expect(run(write, { access: 'write' })).resolves.toBeDefined()
  })
})

describe('lease invalidation and retry', () => {
  it('re-mints once after a definite auth rejection and replays with the new token', async () => {
    const invalidate = vi.fn()
    const { fetchImpl, calls } = fakeFetch({ statuses: [401] })
    const { instance } = broker(fetchImpl, { tokens: ['gitea-stale', 'gitea-fresh'], invalidate })
    await instance.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' })
    expect(invalidate).toHaveBeenCalledWith('gitea-stale')
    expect(calls.map((c) => c.token)).toEqual(['token gitea-stale', 'token gitea-fresh'])
  })

  it('gives up after the second rejection, and never retries a non-auth failure', async () => {
    const twice = fakeFetch({ statuses: [403, 403] })
    await expect(
      broker(twice.fetchImpl, { invalidate: () => undefined }).instance.execute(TARGET, {
        kind: 'createComment',
        subject: 'issue',
        iid: 12,
        body: 'hi'
      })
    ).rejects.toThrow(/Gitea POST failed with 403: Forbidden/)
    expect(twice.calls).toHaveLength(2)
    const server = fakeFetch({ statuses: [500] })
    await expect(
      broker(server.fetchImpl, { invalidate: () => undefined }).instance.execute(TARGET, {
        kind: 'readDiscussions',
        subject: 'issue',
        iid: 12
      })
    ).rejects.toThrow(/Gitea GET failed with 500/)
    expect(server.calls).toHaveLength(1)
  })
})

describe('bounded structured results and the single-writer discipline', () => {
  it('preserves ids beyond the safe-integer range and caps a listed page', async () => {
    const big = await run(
      { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' },
      {},
      { body: '{"id":9007199254740993123}' }
    )
    expect(big.result).toEqual({ comment: { id: '9007199254740993123' } })
    const many = JSON.stringify(Array.from({ length: 40 }, (_unused, index) => ({ id: index + 1, body: 'c' })))
    const page = await run({ kind: 'readDiscussions', subject: 'issue', iid: 12 }, {}, { bodies: ['{"id":1}', many] })
    expect((page.result as { comments: unknown[] }).comments).toHaveLength(20)
  })

  it('updates only a comment this session created through the broker, never across sessions', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"id":4242}' })
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, { kind: 'updateComment', subject: 'issue', iid: 12, noteId: '4242', body: 'x' })
    ).rejects.toThrow(/only a comment this session created/)
    await instance.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' })
    await instance.execute(TARGET, { kind: 'updateComment', subject: 'issue', iid: 12, noteId: '4242', body: 'edited' })
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: `${REPO}/issues/comments/4242`, body: { body: 'edited' } })
    await expect(
      instance.execute(
        { ...TARGET, sessionKey: 'session-2' },
        { kind: 'updateComment', subject: 'issue', iid: 12, noteId: '4242', body: 'x' }
      )
    ).rejects.toThrow(/only a comment this session created/)
  })
})

describe('trusted path parameters', () => {
  it('refuses a repository path that is not owner/repo, a non-decimal comment id, and a malformed branch', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(
        { ...TARGET, repoPath: 'example-org/sub/repo' },
        { kind: 'readDiscussions', subject: 'issue', iid: 1 }
      )
    ).rejects.toThrow(/exactly owner\/repo/)
    await expect(
      instance.execute({ ...TARGET, repoPath: undefined }, { kind: 'readDiscussions', subject: 'issue', iid: 1 })
    ).rejects.toThrow(/exactly owner\/repo/)
    await expect(
      instance.execute(TARGET, { kind: 'readDiscussions', subject: 'issue', iid: 1, discussionId: '../x' })
    ).rejects.toThrow(/positive decimal id/)
    await expect(
      instance.execute(TARGET, { kind: 'createMergeRequest', sourceBranch: 'a b', targetBranch: 'main', title: 't' })
    ).rejects.toThrow(/sourceBranch must be a branch name/)
    await expect(
      instance.execute(TARGET, { kind: 'inspectPipelines', scope: 'pipelines', ref: 'release notes' })
    ).rejects.toThrow(/ref must be a branch name/)
    expect(calls).toEqual([])
    // A dotted ref is one encoded segment, never a traversal of the allowlisted template.
    await instance.execute(TARGET, { kind: 'inspectPipelines', scope: 'pipelines', ref: '../etc' })
    expect(calls[0]?.url).toBe(`${REPO}/commits/..%2Fetc/statuses?limit=20`)
  })
})
