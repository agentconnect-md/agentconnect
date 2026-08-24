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
  opts: { access?: BrokerCapability; tokens?: string[]; invalidate?: (token: string) => void } = {}
) {
  const tokens = opts.tokens ?? ['glpat-effect']
  let minted = 0
  const instance = new GitlabBroker({
    lease: async () => ({ token: tokens[Math.min(minted++, tokens.length - 1)]!, access: opts.access ?? 'write' }),
    invalidateLease: (_target, token) => opts.invalidate?.(token),
    apiBaseUrl: () => BASE,
    fetchImpl
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
      expect(endpoint.path.startsWith('/projects/:project'), id).toBe(true)
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
      'job.get',
      'pipeline.get',
      'pipeline.jobs',
      'pipeline.list'
    ])
    expect(byCapability('comment')).toEqual(['comment.create', 'comment.update', 'discussion.reply'])
    expect(byCapability('write')).toEqual([
      'job.cancel',
      'job.retry',
      'mergeRequest.create',
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
      'createCodeHostComment',
      { subject: 'merge_request', iid: 77, body: 'hi' },
      deps(codeHostEffect)
    )
    expect(codeHostEffect).toHaveBeenCalledWith({
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
      'createCodeHostComment',
      { subject: 'issue', iid: 12, body: 'hi', projectId: '1', project: 'example-group/example-project' },
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
        'createCodeHostComment',
        { subject: 'snippet', iid: 1, body: 'hi' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument subject must be one of: issue, merge_request')
    await expect(
      executeTool(
        ctx,
        'createCodeHostComment',
        { subject: 'issue', iid: 0, body: 'hi' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument iid must be a positive integer')
  })

  it('rejects a note id that is not a positive decimal string', async () => {
    await expect(
      executeTool(
        ctx,
        'updateCodeHostComment',
        { subject: 'issue', iid: 12, noteId: '../9001', body: 'x' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument noteId must be a positive decimal string')
  })

  it('requires a field to change on a merge-request update, and a title to move draft state', async () => {
    await expect(
      executeTool(
        ctx,
        'updateCodeHostMergeRequest',
        { iid: 77 },
        deps(async () => ({}))
      )
    ).rejects.toThrow('supply at least one of title, description, or targetBranch')
    await expect(
      executeTool(
        ctx,
        'updateCodeHostMergeRequest',
        { iid: 77, description: 'x', draft: true },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument draft also requires title')
  })

  it('rejects an unknown pipeline action', async () => {
    await expect(
      executeTool(
        ctx,
        'controlCodeHostPipeline',
        { action: 'delete_pipeline' },
        deps(async () => ({}))
      )
    ).rejects.toThrow('argument action must be one of: retry_pipeline, cancel_pipeline, retry_job, cancel_job')
  })

  it('fails closed on a daemon with no broker wired', async () => {
    await expect(executeTool(ctx, 'inspectCodeHostPipelines', { scope: 'pipelines' }, deps())).rejects.toThrow(
      'code-host effects are unavailable on this daemon'
    )
  })
})
