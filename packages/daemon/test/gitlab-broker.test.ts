// GitLab structured mutation broker (gitlab-com-integration.md §14.2): allowlisted endpoints,
// clamped capabilities, a daemon-held effect lease, and bounded structured results.
import { describe, it, expect, vi } from 'vitest'
import {
  GitlabBroker,
  GITLAB_BROKER_ENDPOINTS,
  type BrokerCapability,
  type GitlabBrokerOperation,
  type GitlabBrokerTarget
} from '../src/gitlab/broker.js'
import { GitCredentialCache, GitCredUnavailableError } from '../src/cp/git-credential.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'

const BASE = 'https://gitlab.example.test/api/v4'
const PROJECT = '4455667'
const TARGET: GitlabBrokerTarget = { agentId: 'agent-1', projectId: PROJECT, sessionKey: 'session-1' }

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
      token: headers['private-token'] ?? '',
      ...(headers['content-type'] !== undefined ? { contentType: headers['content-type'] } : {}),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) })
    })
    const status = opts.statuses?.[index]
    if (status !== undefined && status >= 400) return new Response('{"message":"403 Forbidden"}', { status })
    return new Response(opts.bodies?.[index] ?? opts.body ?? '{"id":9001}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function broker(
  fetchImpl: typeof fetch,
  opts: {
    access?: BrokerCapability
    tokens?: string[]
    invalidate?: (token: string) => void
    delays?: number[]
  } = {}
) {
  const tokens = opts.tokens ?? ['glpat-effect']
  let minted = 0
  const instance = new GitlabBroker({
    lease: async () => ({ token: tokens[Math.min(minted++, tokens.length - 1)]!, access: opts.access ?? 'write' }),
    invalidateLease: (_target, token) => opts.invalidate?.(token),
    apiBaseUrl: () => BASE,
    fetchImpl,
    delay: async (ms) => {
      opts.delays?.push(ms)
    }
  })
  return { instance, minted: () => minted }
}

async function run(
  op: GitlabBrokerOperation,
  opts: Parameters<typeof broker>[1] = {},
  fetchOpts: Parameters<typeof fakeFetch>[0] = {}
) {
  const { fetchImpl, calls } = fakeFetch(fetchOpts)
  const { instance } = broker(fetchImpl, opts)
  const result = await instance.execute(TARGET, op)
  return { result, calls }
}

describe('the allowlist is the whole surface', () => {
  it('declares only bounded methods and templated paths', () => {
    for (const [id, endpoint] of Object.entries(GITLAB_BROKER_ENDPOINTS)) {
      expect(['GET', 'POST', 'PUT'], id).toContain(endpoint.method)
      // The username lookup is the one instance-wide read; everything else is scoped to the trusted project.
      if (id === 'user.lookup') expect(endpoint.path).toBe('/users')
      else expect(endpoint.path.startsWith('/projects/:project'), id).toBe(true)
      expect(endpoint.path, id).not.toContain('?')
    }
  })

  it('classifies every endpoint into a read, comment, or write capability', () => {
    const byCapability = (capability: BrokerCapability) =>
      Object.entries(GITLAB_BROKER_ENDPOINTS)
        .filter(([, endpoint]) => endpoint.capability === capability)
        .map(([id]) => id)
        .sort()
    expect(byCapability('read')).toEqual([
      'discussion.get',
      'discussion.list',
      'issue.get',
      'job.get',
      'mergeRequest.get',
      'pipeline.get',
      'pipeline.jobs',
      'pipeline.list',
      'user.lookup'
    ])
    expect(byCapability('comment')).toEqual(['comment.create', 'comment.update', 'discussion.reply'])
    expect(byCapability('write')).toEqual([
      'issue.create',
      'issue.update',
      'job.cancel',
      'job.retry',
      'mergeRequest.create',
      'mergeRequest.merge',
      'mergeRequest.rebase',
      'mergeRequest.update',
      'pipeline.cancel',
      'pipeline.retry'
    ])
  })
})

describe('each operation calls exactly one allowlisted endpoint', () => {
  it('creates an issue comment', async () => {
    const { calls } = await run({ kind: 'createComment', subject: 'issue', iid: 12, body: 'hello' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/projects/4455667/issues/12/notes`,
      token: 'glpat-effect',
      contentType: 'application/json',
      body: { body: 'hello' }
    })
  })

  it('creates a merge-request comment on the merge-request path', async () => {
    const { calls } = await run({ kind: 'createComment', subject: 'merge_request', iid: 77, body: 'hi' })
    expect(calls[0]?.url).toBe(`${BASE}/projects/4455667/merge_requests/77/notes`)
  })

  it('lists discussions with a bounded page size', async () => {
    const { calls } = await run(
      { kind: 'readDiscussions', subject: 'merge_request', iid: 77, limit: 500 },
      {},
      { body: '[]' }
    )
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/projects/4455667/merge_requests/77/discussions?per_page=20`
    })
    expect(calls[0]?.contentType).toBeUndefined()
  })

  it('reads one discussion by id', async () => {
    const { calls } = await run(
      { kind: 'readDiscussions', subject: 'merge_request', iid: 77, discussionId: 'a1b2c3d4e5f6' },
      {},
      { body: '{"id":"a1b2c3d4e5f6","notes":[]}' }
    )
    expect(calls[0]?.url).toBe(`${BASE}/projects/4455667/merge_requests/77/discussions/a1b2c3d4e5f6`)
  })

  it('replies into one discussion', async () => {
    const { calls } = await run({
      kind: 'replyDiscussion',
      subject: 'merge_request',
      iid: 77,
      discussionId: 'a1b2c3d4e5f6',
      body: 'answered'
    })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/projects/4455667/merge_requests/77/discussions/a1b2c3d4e5f6/notes`,
      body: { body: 'answered' }
    })
  })

  it('creates a merge request from bounded fields only', async () => {
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
      url: `${BASE}/projects/4455667/merge_requests`,
      body: { source_branch: 'feature/x', target_branch: 'main', title: 'Draft: Add x', description: 'why' }
    })
  })

  it('updates a merge request and clears the draft marker', async () => {
    const { calls } = await run({
      kind: 'updateMergeRequest',
      iid: 77,
      title: 'Draft: Add x',
      targetBranch: 'release',
      draft: false
    })
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `${BASE}/projects/4455667/merge_requests/77`,
      body: { title: 'Add x', target_branch: 'release' }
    })
  })

  it('inspects pipelines, one pipeline, its jobs, and one job', async () => {
    const list = await run(
      { kind: 'inspectPipelines', scope: 'pipelines', ref: 'main', status: 'failed' },
      {},
      { body: '[]' }
    )
    expect(list.calls[0]?.url).toBe(`${BASE}/projects/4455667/pipelines?per_page=20&ref=main&status=failed`)

    const one = await run({ kind: 'inspectPipelines', scope: 'pipeline', pipelineId: '31' })
    expect(one.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/projects/4455667/pipelines/31` })

    const jobs = await run({ kind: 'inspectPipelines', scope: 'pipeline_jobs', pipelineId: '31' }, {}, { body: '[]' })
    expect(jobs.calls[0]?.url).toBe(`${BASE}/projects/4455667/pipelines/31/jobs?per_page=20`)

    const job = await run({ kind: 'inspectPipelines', scope: 'job', jobId: '99' })
    expect(job.calls[0]?.url).toBe(`${BASE}/projects/4455667/jobs/99`)
  })

  it('retries and cancels pipelines and jobs', async () => {
    const cases: [GitlabBrokerOperation, string][] = [
      [
        { kind: 'controlPipeline', action: 'retry_pipeline', pipelineId: '31' },
        `${BASE}/projects/4455667/pipelines/31/retry`
      ],
      [
        { kind: 'controlPipeline', action: 'cancel_pipeline', pipelineId: '31' },
        `${BASE}/projects/4455667/pipelines/31/cancel`
      ],
      [{ kind: 'controlPipeline', action: 'retry_job', jobId: '99' }, `${BASE}/projects/4455667/jobs/99/retry`],
      [{ kind: 'controlPipeline', action: 'cancel_job', jobId: '99' }, `${BASE}/projects/4455667/jobs/99/cancel`]
    ]
    for (const [op, url] of cases) {
      const { calls } = await run(op)
      expect(calls[0]).toMatchObject({ method: 'POST', url })
    }
  })
})

const ALICE = '[{"id":101,"username":"alice"}]'
const BOB = '[{"id":102,"username":"bob"}]'

describe('people and labels resolve before the one write', () => {
  it('creates a merge request with labels, assignees, and reviewers by user id', async () => {
    const { calls } = await run(
      {
        kind: 'createMergeRequest',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        title: 'Add x',
        labels: ['bug', 'needs review'],
        assignees: ['alice'],
        reviewers: ['bob']
      },
      {},
      { bodies: [ALICE, BOB] }
    )
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/users?username=alice`,
      `GET ${BASE}/users?username=bob`,
      `POST ${BASE}/projects/4455667/merge_requests`
    ])
    expect(calls[0]?.body).toBeUndefined()
    expect(calls[2]?.body).toEqual({
      source_branch: 'feature/x',
      target_branch: 'main',
      title: 'Add x',
      labels: 'bug,needs review',
      assignee_ids: [101],
      reviewer_ids: [102]
    })
  })

  it('looks a name up once when it is both assignee and reviewer', async () => {
    const { calls } = await run(
      {
        kind: 'createMergeRequest',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        title: 'Add x',
        assignees: ['alice'],
        reviewers: ['alice']
      },
      {},
      { bodies: [ALICE] }
    )
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).toMatchObject({ assignee_ids: [101], reviewer_ids: [101] })
  })

  it('takes only the exact username from the lookup answer', async () => {
    const { calls } = await run(
      { kind: 'createIssue', title: 'Bug', assignees: ['alice'] },
      {},
      { bodies: ['[{"id":7,"username":"alice2"},{"id":101,"username":"Alice"}]'] }
    )
    expect(calls[1]?.body).toEqual({ title: 'Bug', assignee_ids: [101] })
  })

  it('refuses an unknown username before the write', async () => {
    const { fetchImpl, calls } = fakeFetch({ bodies: [ALICE, '[]'] })
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, { kind: 'createIssue', title: 'Bug', assignees: ['alice', 'nobody'] })
    ).rejects.toThrow('GitLab has no user named nobody')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('refuses a malformed username or label before any request', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, { kind: 'createIssue', title: 'Bug', assignees: ['../users/1'] })
    ).rejects.toThrow('assignees must hold usernames')
    await expect(instance.execute(TARGET, { kind: 'createIssue', title: 'Bug', labels: ['a,b'] })).rejects.toThrow(
      'labels must be non-empty label names without commas'
    )
    expect(calls).toEqual([])
  })

  it('adds and removes labels and assignees, and adds reviewers, on a merge-request update', async () => {
    const current = JSON.stringify({
      iid: 77,
      assignees: [
        { id: 103, username: 'carol' },
        { id: 104, username: 'dave' }
      ],
      reviewers: [
        { id: 102, username: 'bob' },
        { id: 103, username: 'carol' }
      ]
    })
    const { calls } = await run(
      {
        kind: 'updateMergeRequest',
        iid: 77,
        addLabels: ['bug', 'ready'],
        removeLabels: ['wip'],
        addAssignees: ['alice'],
        removeAssignees: ['Dave'],
        reviewers: ['bob', 'alice']
      },
      {},
      { bodies: [ALICE, BOB, current] }
    )
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/users?username=alice`,
      `GET ${BASE}/users?username=bob`,
      `GET ${BASE}/projects/4455667/merge_requests/77`,
      `PUT ${BASE}/projects/4455667/merge_requests/77`
    ])
    expect(calls[3]?.body).toEqual({
      add_labels: 'bug,ready',
      remove_labels: 'wip',
      assignee_ids: [103, 101],
      reviewer_ids: [102, 103, 101]
    })
  })

  it('removes an assignee by the current username without a lookup', async () => {
    const { calls } = await run(
      { kind: 'updateMergeRequest', iid: 77, removeAssignees: ['carol'] },
      {},
      { bodies: ['{"iid":77,"assignees":[{"id":103,"username":"carol"}]}'] }
    )
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT'])
    expect(calls[1]?.body).toEqual({ assignee_ids: [] })
  })

  it('does not read the merge request when neither assignees nor reviewers change', async () => {
    const { calls } = await run({ kind: 'updateMergeRequest', iid: 77, addLabels: ['bug'], reviewers: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { add_labels: 'bug' } })
  })

  it('refuses a name both added and removed before any request', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, { kind: 'updateIssue', iid: 12, addLabels: ['bug'], removeLabels: ['bug'] })
    ).rejects.toThrow('cannot both add and remove "bug"')
    expect(calls).toEqual([])
  })
})

const NO_PIPELINE = '{"iid":77,"state":"opened"}'
const RUNNING = '{"iid":77,"state":"opened","head_pipeline":{"id":31,"status":"running"}}'

describe('merging, state, and issues', () => {
  it('merges now, with an optional squash flag and head sha, when there is no pipeline', async () => {
    const sha = 'a'.repeat(40)
    const squash = await run(
      { kind: 'mergeMergeRequest', iid: 77, method: 'squash', sha },
      {},
      { bodies: [NO_PIPELINE, '{"iid":77,"state":"merged"}'] }
    )
    expect(squash.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/projects/4455667/merge_requests/77`,
      `PUT ${BASE}/projects/4455667/merge_requests/77/merge`
    ])
    expect(squash.calls[1]?.body).toEqual({ squash: true, sha })
    expect(squash.result).toEqual({ mergeRequest: { iid: 77, state: 'merged' }, outcome: 'merged' })

    const plain = await run({ kind: 'mergeMergeRequest', iid: 77, method: 'merge' }, {}, { bodies: [NO_PIPELINE, ''] })
    expect(plain.calls[1]?.body).toEqual({})
    expect(plain.result).toEqual({ mergeRequest: {} })
  })

  it('sets the merge to happen when a running pipeline passes', async () => {
    const { calls, result } = await run(
      { kind: 'mergeMergeRequest', iid: 77 },
      {},
      { bodies: [RUNNING, '{"iid":77,"state":"opened","merge_when_pipeline_succeeds":true}'] }
    )
    expect(calls[1]?.body).toEqual({ auto_merge: true })
    expect(result).toEqual({
      mergeRequest: { iid: 77, state: 'opened' },
      outcome: 'merges_when_pipeline_succeeds'
    })
  })

  it.each(['failed', 'canceled'])('refuses to merge behind a %s pipeline', async (status) => {
    const { fetchImpl, calls } = fakeFetch({ bodies: [`{"iid":77,"pipeline":{"status":"${status}"}}`] })
    const { instance } = broker(fetchImpl)
    await expect(instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77 })).rejects.toThrow(
      `the merge request's pipeline is ${status}`
    )
    expect(calls).toHaveLength(1)
  })

  it('rebases, waits for the rebase, retries the early 406, then auto-merges behind the new pipeline', async () => {
    const delays: number[] = []
    const { fetchImpl, calls } = fakeFetch({
      statuses: [200, 202, 200, 200, 406, 200],
      bodies: [
        NO_PIPELINE,
        '{"rebase_in_progress":true}',
        '{"iid":77,"rebase_in_progress":true}',
        '{"iid":77,"rebase_in_progress":false,"head_pipeline":{"status":"pending"}}',
        '',
        '{"iid":77,"state":"opened","auto_merge":true}'
      ]
    })
    const { instance } = broker(fetchImpl, { delays })
    const result = await instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77, method: 'rebase' })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/projects/4455667/merge_requests/77`,
      `PUT ${BASE}/projects/4455667/merge_requests/77/rebase`,
      `GET ${BASE}/projects/4455667/merge_requests/77?include_rebase_in_progress=true`,
      `GET ${BASE}/projects/4455667/merge_requests/77?include_rebase_in_progress=true`,
      `PUT ${BASE}/projects/4455667/merge_requests/77/merge`,
      `PUT ${BASE}/projects/4455667/merge_requests/77/merge`
    ])
    expect(calls[5]?.body).toEqual({ auto_merge: true })
    expect(delays).toEqual([1000, 6000])
    expect(result).toMatchObject({ outcome: 'merges_when_pipeline_succeeds' })
  })

  it('gives up on the 406 after three merge attempts', async () => {
    const delays: number[] = []
    const { fetchImpl, calls } = fakeFetch({
      statuses: [200, 202, 200, 406, 406, 406],
      bodies: [NO_PIPELINE, '{}', '{"rebase_in_progress":false}']
    })
    const { instance } = broker(fetchImpl, { delays })
    await expect(instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77, method: 'rebase' })).rejects.toThrow(
      /GitLab PUT failed with 406/
    )
    expect(calls).toHaveLength(6)
    expect(delays).toEqual([6000, 6000])
  })

  it('does not retry a 406 when there was no rebase', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [200, 406], bodies: [NO_PIPELINE] })
    const { instance } = broker(fetchImpl)
    await expect(instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77 })).rejects.toThrow(/failed with 406/)
    expect(calls).toHaveLength(2)
  })

  it('refuses the merge when the rebase reports a merge error', async () => {
    const { fetchImpl, calls } = fakeFetch({
      bodies: [NO_PIPELINE, '{}', '{"rebase_in_progress":false,"merge_error":"Rebase failed: conflicts"}']
    })
    const { instance } = broker(fetchImpl)
    await expect(instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77, method: 'rebase' })).rejects.toThrow(
      'GitLab could not rebase the merge request: Rebase failed: conflicts'
    )
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET'])
  })

  it('polls a rebase a bounded number of times', async () => {
    const delays: number[] = []
    const { fetchImpl, calls } = fakeFetch({ bodies: [NO_PIPELINE, '{}'], body: '{"rebase_in_progress":true}' })
    const { instance } = broker(fetchImpl, { delays })
    await expect(instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77, method: 'rebase' })).rejects.toThrow(
      'GitLab is still rebasing the merge request'
    )
    expect(calls).toHaveLength(2 + 30)
    expect(delays).toHaveLength(29)
  })

  it('refuses a malformed sha, and a sha with rebase, before any request', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77, sha: 'main' })).rejects.toThrow(
      'sha must be a full commit id'
    )
    await expect(
      instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 77, method: 'rebase', sha: 'b'.repeat(40) })
    ).rejects.toThrow('sha cannot be combined with rebase')
    expect(calls).toEqual([])
  })

  it('closes and reopens issues and merge requests by state event', async () => {
    const issue = await run({ kind: 'setState', subject: 'issue', iid: 12, state: 'closed' })
    expect(issue.calls[0]).toMatchObject({
      method: 'PUT',
      url: `${BASE}/projects/4455667/issues/12`,
      body: { state_event: 'close' }
    })
    const mr = await run({ kind: 'setState', subject: 'merge_request', iid: 77, state: 'open' })
    expect(mr.calls[0]).toMatchObject({
      method: 'PUT',
      url: `${BASE}/projects/4455667/merge_requests/77`,
      body: { state_event: 'reopen' }
    })
  })

  it('creates an issue and reports it bounded', async () => {
    const labels = Array.from({ length: 30 }, (_, index) => `label-${index}`)
    const { calls, result } = await run(
      { kind: 'createIssue', title: 'Bug', description: 'steps', labels: ['bug'] },
      {},
      {
        body: JSON.stringify({
          id: 5,
          iid: 12,
          title: 'Bug',
          state: 'opened',
          labels,
          web_url: 'https://gitlab.example.test/example-group/example-project/-/issues/12',
          created_at: '2026-01-02T03:04:05Z',
          author: { username: 'dropped' }
        })
      }
    )
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/projects/4455667/issues`,
      body: { title: 'Bug', description: 'steps', labels: 'bug' }
    })
    expect(result).toEqual({
      issue: {
        id: '5',
        iid: 12,
        title: 'Bug',
        state: 'opened',
        labels: labels.slice(0, 20),
        webUrl: 'https://gitlab.example.test/example-group/example-project/-/issues/12',
        createdAt: '2026-01-02T03:04:05Z'
      }
    })
  })

  it('updates only the issue fields given, reading the issue for its assignees', async () => {
    const { calls } = await run(
      { kind: 'updateIssue', iid: 12, title: 'Bug, again', addAssignees: ['bob'], removeLabels: ['triage'] },
      {},
      { bodies: [BOB, '{"iid":12,"assignees":[{"id":101,"username":"alice"}]}'] }
    )
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/users?username=bob`,
      `GET ${BASE}/projects/4455667/issues/12`,
      `PUT ${BASE}/projects/4455667/issues/12`
    ])
    expect(calls[2]?.body).toEqual({ title: 'Bug, again', remove_labels: 'triage', assignee_ids: [101, 102] })
  })
})

describe('draft markers normalize in both directions', () => {
  // GitLab carries draft state in the title, and recognizes each of these prefixes.
  const MARKED = [
    'Draft: Add x',
    '[Draft] Add x',
    '(Draft) Add x',
    'draft: Add x',
    '[draft] Add x',
    'WIP: Add x',
    '[WIP] Add x',
    '(WIP) Add x'
  ]

  it.each(MARKED)('clears %s on a merge-request update', async (title) => {
    const { calls } = await run({ kind: 'updateMergeRequest', iid: 77, title, draft: false })
    expect((calls[0]?.body as { title: string }).title).toBe('Add x')
  })

  it.each(MARKED)('re-marks %s exactly once when a merge request is created as a draft', async (title) => {
    const { calls } = await run({
      kind: 'createMergeRequest',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title,
      draft: true
    })
    expect((calls[0]?.body as { title: string }).title).toBe('Draft: Add x')
  })

  it.each(MARKED)('re-marks %s exactly once on a merge-request update', async (title) => {
    const { calls } = await run({ kind: 'updateMergeRequest', iid: 77, title, draft: true })
    expect((calls[0]?.body as { title: string }).title).toBe('Draft: Add x')
  })

  it('marks an unmarked title and clears a title that carries several markers', async () => {
    const marked = await run({
      kind: 'createMergeRequest',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title: 'Add x',
      draft: true
    })
    expect((marked.calls[0]?.body as { title: string }).title).toBe('Draft: Add x')

    const cleared = await run({ kind: 'updateMergeRequest', iid: 77, title: 'Draft: [WIP] Add x', draft: false })
    expect((cleared.calls[0]?.body as { title: string }).title).toBe('Add x')
  })

  it('leaves the title untouched when the flag is absent', async () => {
    const { calls } = await run({ kind: 'updateMergeRequest', iid: 77, title: '[Draft] Add x' })
    expect((calls[0]?.body as { title: string }).title).toBe('[Draft] Add x')
  })
})

describe('capability classes are enforced against the clamped grant', () => {
  const comment: GitlabBrokerOperation = { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' }
  const write: GitlabBrokerOperation = { kind: 'controlPipeline', action: 'retry_pipeline', pipelineId: '31' }
  const read: GitlabBrokerOperation = { kind: 'inspectPipelines', scope: 'pipeline', pipelineId: '31' }

  it('lets a read clamp read but refuses comment and write', async () => {
    await expect(run(read, { access: 'read' })).resolves.toBeDefined()
    await expect(run(comment, { access: 'read' })).rejects.toThrow(
      /needs comment authority on the GitLab project, but the current authorization grants read/
    )
    await expect(run(write, { access: 'read' })).rejects.toThrow(/needs write authority/)
  })

  it('lets a comment clamp comment but refuses write', async () => {
    await expect(run(comment, { access: 'comment' })).resolves.toBeDefined()
    await expect(run(write, { access: 'comment' })).rejects.toThrow(
      /needs write authority on the GitLab project, but the current authorization grants comment/
    )
  })

  it('lets a write clamp do everything', async () => {
    await expect(run(read, { access: 'write' })).resolves.toBeDefined()
    await expect(run(comment, { access: 'write' })).resolves.toBeDefined()
    await expect(run(write, { access: 'write' })).resolves.toBeDefined()
  })

  it('checks the final write before spending a lookup', async () => {
    const issue: GitlabBrokerOperation = { kind: 'createIssue', title: 'Bug', assignees: ['alice'] }
    const merge: GitlabBrokerOperation = { kind: 'mergeMergeRequest', iid: 77, method: 'rebase' }
    const state: GitlabBrokerOperation = { kind: 'setState', subject: 'issue', iid: 12, state: 'closed' }
    for (const [op, access] of [
      [issue, 'comment'],
      [merge, 'comment'],
      [state, 'read']
    ] as const) {
      const { fetchImpl, calls } = fakeFetch({ body: ALICE })
      const { instance } = broker(fetchImpl, { access })
      await expect(instance.execute(TARGET, op)).rejects.toThrow(
        `needs write authority on the GitLab project, but the current authorization grants ${access}`
      )
      expect(calls).toEqual([])
    }
  })

  it('refuses before reaching GitLab at all', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl, { access: 'read' })
    await expect(instance.execute(TARGET, comment)).rejects.toThrow(/needs comment authority/)
    expect(calls).toEqual([])
  })
})

describe('lease invalidation and retry', () => {
  it('re-mints once after a definite auth rejection and replays with the new token', async () => {
    const invalidate = vi.fn()
    const { fetchImpl, calls } = fakeFetch({ statuses: [401] })
    const { instance } = broker(fetchImpl, { tokens: ['glpat-stale', 'glpat-fresh'], invalidate })
    await instance.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' })
    expect(invalidate).toHaveBeenCalledWith('glpat-stale')
    expect(calls.map((call) => call.token)).toEqual(['glpat-stale', 'glpat-fresh'])
  })

  it('gives up after the second rejection instead of looping', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [403, 403] })
    const { instance } = broker(fetchImpl, { tokens: ['glpat-stale', 'glpat-fresh'] })
    await expect(
      instance.execute(TARGET, { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' })
    ).rejects.toThrow(/GitLab POST failed with 403: 403 Forbidden/)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a non-auth failure', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [404] })
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, { kind: 'inspectPipelines', scope: 'pipeline', pipelineId: '31' })
    ).rejects.toThrow(/GitLab GET failed with 404/)
    expect(calls).toHaveLength(1)
  })
})

describe('bounded structured results', () => {
  it('preserves ids beyond the safe-integer range as strings', async () => {
    const { result } = await run(
      { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' },
      {},
      { body: '{"id":9007199254740993123,"project_id":4455667123456789012,"created_at":"2026-01-02T03:04:05Z"}' }
    )
    expect(result).toMatchObject({ note: { id: '9007199254740993123', createdAt: '2026-01-02T03:04:05Z' } })
  })

  it('reports the merge request as ids, state, and link only', async () => {
    const { result } = await run(
      { kind: 'updateMergeRequest', iid: 77, title: 'Add x' },
      {},
      {
        body: JSON.stringify({
          id: 5,
          iid: 77,
          project_id: 4455667,
          title: 'Add x',
          state: 'opened',
          draft: false,
          source_branch: 'feature/x',
          target_branch: 'main',
          web_url: 'https://gitlab.example.test/example-group/example-project/-/merge_requests/77',
          secret_note: 'dropped'
        })
      }
    )
    expect(result).toEqual({
      mergeRequest: {
        id: '5',
        iid: 77,
        projectId: '4455667',
        title: 'Add x',
        state: 'opened',
        draft: false,
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        webUrl: 'https://gitlab.example.test/example-group/example-project/-/merge_requests/77'
      }
    })
  })

  it('caps a listed page at the bounded item count', async () => {
    const pipelines = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, status: 'success' }))
    const { result } = await run(
      { kind: 'inspectPipelines', scope: 'pipelines' },
      {},
      { body: JSON.stringify(pipelines) }
    )
    expect((result as { pipelines: unknown[] }).pipelines).toHaveLength(20)
  })
})

describe('single-writer discipline for comment updates', () => {
  const create: GitlabBrokerOperation = { kind: 'createComment', subject: 'issue', iid: 12, body: 'first' }
  const update: GitlabBrokerOperation = {
    kind: 'updateComment',
    subject: 'issue',
    iid: 12,
    noteId: '9001',
    body: 'second'
  }

  it('refuses a comment this session did not author', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(instance.execute(TARGET, update)).rejects.toThrow(
      'only a comment this session created through the broker can be updated'
    )
    expect(calls).toEqual([])
  })

  it('accepts a comment the broker created in this session', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await instance.execute(TARGET, create)
    await instance.execute(TARGET, update)
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      url: `${BASE}/projects/4455667/issues/12/notes/9001`,
      body: { body: 'second' }
    })
  })

  it('does not carry authorship across sessions', async () => {
    const { fetchImpl } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await instance.execute(TARGET, create)
    await expect(instance.execute({ ...TARGET, sessionKey: 'session-2' }, update)).rejects.toThrow(
      'only a comment this session created through the broker can be updated'
    )
  })

  it('does not carry authorship to another project the same session names', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await instance.execute(TARGET, create)
    await expect(instance.execute({ ...TARGET, projectId: '7788990' }, update)).rejects.toThrow(
      'only a comment this session created through the broker can be updated'
    )
    expect(calls).toHaveLength(1)
  })
})

describe('trusted path parameters', () => {
  it('refuses a non-numeric project id rather than composing a path from it', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(
        { ...TARGET, projectId: 'example-group/example-project' },
        { kind: 'createComment', subject: 'issue', iid: 12, body: 'hi' }
      )
    ).rejects.toThrow('project id must be a positive decimal id')
    expect(calls).toEqual([])
  })

  it('refuses a discussion id that is not a GitLab digest', async () => {
    const { fetchImpl } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, {
        kind: 'replyDiscussion',
        subject: 'merge_request',
        iid: 77,
        discussionId: '../../projects/1',
        body: 'x'
      })
    ).rejects.toThrow('discussionId must be a GitLab discussion id')
  })

  it('refuses a branch name that is not a branch name', async () => {
    const { fetchImpl } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(
      instance.execute(TARGET, {
        kind: 'createMergeRequest',
        sourceBranch: 'feature/x',
        targetBranch: 'main?private_token=leak',
        title: 'Add x'
      })
    ).rejects.toThrow('targetBranch must be a branch name')
  })

  it('requires the id its scope needs', async () => {
    const { fetchImpl } = fakeFetch()
    const { instance } = broker(fetchImpl)
    await expect(instance.execute(TARGET, { kind: 'inspectPipelines', scope: 'pipeline' })).rejects.toThrow(
      'pipelineId is required for pipeline'
    )
    await expect(instance.execute(TARGET, { kind: 'controlPipeline', action: 'retry_job' })).rejects.toThrow(
      'jobId is required for retry_job'
    )
  })
})

describe('effect leases are gated on the control plane feature', () => {
  function cache(features: { providerV2?: boolean; gitlabEffect?: boolean }) {
    const request = vi.fn(async () => {
      throw new Error('the control plane must never be asked before the gate passes')
    })
    return {
      request,
      instance: new GitCredentialCache({
        request: request as never,
        log: { warn: () => {} },
        providerV2Supported: () => features.providerV2 === true,
        gitlabEffectSupported: () => features.gitlabEffect === true
      })
    }
  }

  it('refuses with a clear message when the control plane lacks gitlab-effect-v1', async () => {
    const { instance, request } = cache({ providerV2: true })
    await expect(instance.getGitlabEffectToken('agent-1', PROJECT)).rejects.toThrow(
      'the control plane does not support GitLab effect leases yet'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('still requires the provider-qualified v2 wire', async () => {
    const { instance } = cache({ gitlabEffect: true })
    await expect(instance.getGitlabEffectToken('agent-1', PROJECT)).rejects.toBeInstanceOf(GitCredUnavailableError)
  })

  it('names purpose gitlab_effect with the trusted project once both features are advertised', async () => {
    const request = vi.fn(async () => ({
      username: 'project_4455667_bot',
      token: 'glpat-effect',
      ttlSec: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      repoFullName: 'example-group/example-project',
      access: 'comment' as const,
      provider: 'gitlab' as const,
      externalRepoId: PROJECT
    }))
    const instance = new GitCredentialCache({
      request,
      log: { warn: () => {} },
      providerV2Supported: () => true,
      gitlabEffectSupported: () => true
    })
    const entry = await instance.getGitlabEffectToken('agent-1', PROJECT, 'hook-1')
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        provider: 'gitlab',
        externalRepoId: PROJECT,
        purpose: 'gitlab_effect',
        hookId: 'hook-1'
      })
    )
    expect(entry.access).toBe('comment')
  })

  it('keeps the broker lease in its own keyspace, so invalidating it leaves the poster token alone', async () => {
    const grant = (token: string) => ({
      username: 'project_4455667_bot',
      token,
      ttlSec: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      repoFullName: 'example-group/example-project',
      access: 'comment' as const,
      provider: 'gitlab' as const,
      externalRepoId: PROJECT
    })
    let minted = 0
    const instance = new GitCredentialCache({
      request: async () => grant(`glpat-${++minted}`),
      log: { warn: () => {} },
      providerV2Supported: () => true,
      gitlabEffectSupported: () => true
    })
    const post = await instance.getGitlabPostToken('agent-1', PROJECT, 'hook-1')
    const effect = await instance.getGitlabEffectToken('agent-1', PROJECT)
    expect(post.token).not.toBe(effect.token)
    instance.invalidateGitlabEffect('agent-1', PROJECT, effect.token)
    expect((await instance.getGitlabPostToken('agent-1', PROJECT, 'hook-1')).token).toBe(post.token)
    expect((await instance.getGitlabEffectToken('agent-1', PROJECT)).token).not.toBe(effect.token)
  })
})

describe('the MCP surface validates arguments before the broker sees them', () => {
  const ctx: SessionContext = {
    agentId: 'agent-1',
    platform: 'gitlab',
    isDm: false,
    channel: 'hook-1',
    thread: 'thread-1',
    deliveryThread: 'thread-1',
    tools: []
  }

  function deps(codeHostEffect?: OpsDeps['codeHostEffect']): OpsDeps {
    return {
      ...(codeHostEffect ? { codeHostEffect } : {}),
      gatewayFor: () => undefined
    } as unknown as OpsDeps
  }

  it('hands the daemon a discriminated operation, never a project', async () => {
    const codeHostEffect = vi.fn(async () => ({ note: { id: '1' } }))
    await executeTool(
      ctx,
      'gitlabComment',
      { action: 'create', subject: 'merge_request', iid: 77, body: 'hi' },
      deps(codeHostEffect)
    )
    expect(codeHostEffect).toHaveBeenCalledWith({
      provider: 'gitlab',
      agentId: 'agent-1',
      platform: 'gitlab',
      channel: 'hook-1',
      thread: 'thread-1',
      operation: { kind: 'createComment', subject: 'merge_request', iid: 77, body: 'hi' }
    })
  })

  it('ignores a project supplied as an argument', async () => {
    const codeHostEffect = vi.fn<NonNullable<OpsDeps['codeHostEffect']>>(async () => ({}))
    await executeTool(
      ctx,
      'gitlabComment',
      {
        action: 'create',
        subject: 'issue',
        iid: 12,
        body: 'hi',
        projectId: '1',
        project: 'example-group/example-project'
      },
      deps(codeHostEffect)
    )
    expect(codeHostEffect.mock.calls[0]?.[0].operation).toEqual({
      kind: 'createComment',
      subject: 'issue',
      iid: 12,
      body: 'hi'
    })
  })

  it('rejects an out-of-vocabulary subject and a non-positive iid', async () => {
    await expect(
      executeTool(
        ctx,
        'gitlabComment',
        { action: 'create', subject: 'snippet', iid: 1, body: 'hi' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument subject must be one of: issue, merge_request')
    await expect(
      executeTool(
        ctx,
        'gitlabComment',
        { action: 'create', subject: 'issue', iid: 0, body: 'hi' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument iid must be a positive integer')
  })

  it('rejects a comment id that is not a positive decimal string', async () => {
    await expect(
      executeTool(
        ctx,
        'gitlabComment',
        { action: 'update', subject: 'issue', iid: 12, commentId: '../9001', body: 'x' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument commentId must be a positive decimal string')
  })

  it('requires a field to change on a merge-request update, and a title to move draft state', async () => {
    await expect(
      executeTool(
        ctx,
        'gitlabMergeRequest',
        { action: 'update', iid: 77 },
        deps(async () => ({}))
      )
    ).rejects.toThrow('action update needs at least one of title, description, targetBranch')
    await expect(
      executeTool(
        ctx,
        'gitlabMergeRequest',
        { action: 'update', iid: 77, description: 'x', draft: true },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument draft also requires title')
  })

  it('rejects an unknown pipeline action', async () => {
    await expect(
      executeTool(
        ctx,
        'gitlabPipeline',
        { action: 'delete_pipeline' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument action must be one of: retry_pipeline, cancel_pipeline, retry_job, cancel_job')
  })

  it('fails closed on a daemon with no broker wired', async () => {
    await expect(executeTool(ctx, 'inspectGitlabPipelines', { scope: 'pipelines' }, deps())).rejects.toThrow(
      'code-host effects are unavailable on this daemon'
    )
  })
})
