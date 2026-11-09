// Azure DevOps pull-request broker (azure-devops-integration.md §6.6): an allowlist below one repository, the proxy lease's tier, and refusals for what the repository does not hold.
import { describe, it, expect, vi } from 'vitest'
import { AzureDevOpsBroker, AZURE_DEVOPS_BROKER_ENDPOINTS } from '../src/azure-devops/broker.js'
import { AZURE_DEVOPS_EFFECT_TOOLS } from '../src/azure-devops/effect-tools.js'
import { createdObjectOf } from '../src/codehost/opened-object.js'
import type { BrokerCapability, CodeHostBrokerOperation, CodeHostEffectTarget } from '../src/codehost/broker.js'
import type { ObjectToolSchema } from '../src/tool-schema/descriptor.js'

const PROJECT = '00000000-0000-4000-8000-0000000000a1'
const REPOSITORY = '00000000-0000-4000-8000-0000000000b2'
const ROUTING = { organization: 'example-org', projectId: PROJECT, repositoryId: REPOSITORY }
const REPO = `https://dev.azure.com/example-org/${PROJECT}/_apis/git/repositories/${REPOSITORY}`
const V = '?api-version=7.1'
const WEB = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
const SHA = 'a'.repeat(40)
const TARGET: CodeHostEffectTarget = {
  agentId: 'agent-1',
  provider: 'azure-devops',
  repoId: '42',
  repoPath: 'example-org/Example Project/Example Repo',
  sessionKey: 'session-1'
}

const PULL = JSON.stringify({
  pullRequestId: 7,
  title: 'Add a thing',
  status: 'active',
  isDraft: false,
  mergeStatus: 'succeeded',
  createdBy: { uniqueName: 'agent@example.test' },
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  lastMergeSourceCommit: { commitId: SHA },
  labels: [
    { name: 'ready', active: true },
    { name: 'gone', active: false }
  ],
  repository: { webUrl: WEB },
  creationDate: '2026-11-07T00:00:00Z'
})

interface Call {
  method: string
  url: string
  auth: string
  body?: unknown
}

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
      auth: headers['authorization'] ?? '',
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) })
    })
    const status = opts.statuses?.[index]
    if (status !== undefined && status >= 400) return new Response('{"message":"TF401027: denied"}', { status })
    return new Response(opts.bodies?.[index] ?? opts.body ?? PULL, { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function broker(fetchImpl: typeof fetch, opts: { access?: BrokerCapability; tokens?: string[] } = {}) {
  const tokens = opts.tokens ?? ['lease-1']
  const invalidate = vi.fn()
  let minted = 0
  const instance = new AzureDevOpsBroker({
    routing: (target) => (target.repoId === '42' ? ROUTING : undefined),
    lease: async () => ({
      token: tokens[Math.min(minted++, tokens.length - 1)]!,
      access: opts.access ?? 'write',
      invalidate
    }),
    fetchImpl
  })
  return { instance, invalidate, minted: () => minted }
}

async function run(
  op: CodeHostBrokerOperation,
  opts: Parameters<typeof broker>[1] = {},
  fetchOpts: Parameters<typeof fakeFetch>[0] = {}
) {
  const { fetchImpl, calls } = fakeFetch(fetchOpts)
  const { instance } = broker(fetchImpl, opts)
  const result = await instance.execute(TARGET, op)
  return { result, calls }
}

describe('the allowlist is the whole surface', () => {
  it('declares only paths below one repository', () => {
    for (const endpoint of Object.values(AZURE_DEVOPS_BROKER_ENDPOINTS)) {
      expect(endpoint.path.startsWith('/:organization/:projectId/_apis/git/repositories/:repositoryId/')).toBe(true)
    }
  })

  it('refuses a repository the agent does not hold before minting', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance, minted } = broker(fetchImpl)
    await expect(instance.execute({ ...TARGET, repoId: '99' }, { kind: 'mergeMergeRequest', iid: 7 })).rejects.toThrow(
      'not authorized'
    )
    expect(minted()).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('pull requests', () => {
  it('opens one with branch refs, draft state and labels, and answers bounded fields with its web address', async () => {
    const { result, calls } = await run({
      kind: 'createMergeRequest',
      sourceBranch: 'feature',
      targetBranch: 'refs/heads/main',
      title: 'Add a thing',
      description: 'Body',
      draft: true,
      labels: ['ready']
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${REPO}/pullrequests${V}`,
        auth: 'Bearer lease-1',
        body: {
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          title: 'Add a thing',
          description: 'Body',
          isDraft: true,
          labels: [{ name: 'ready' }]
        }
      }
    ])
    expect(result).toEqual({
      pullRequest: {
        number: 7,
        title: 'Add a thing',
        status: 'active',
        draft: false,
        mergeStatus: 'succeeded',
        author: 'agent@example.test',
        labels: ['ready'],
        head: 'feature',
        headSha: SHA,
        base: 'main',
        htmlUrl: `${WEB}/pullrequest/7`,
        createdAt: '2026-11-07T00:00:00Z'
      }
    })
    expect(createdObjectOf(result)).toEqual({
      kind: 'pull request',
      label: 'example-org/Example Project/Example Repo!7',
      url: `${WEB}/pullrequest/7`
    })
  })

  it('refuses assignees and reviewers, which this broker does not set', async () => {
    const base = { kind: 'createMergeRequest' as const, sourceBranch: 'f', targetBranch: 'main', title: 't' }
    await expect(run({ ...base, assignees: ['someone'] })).rejects.toThrow('no assignees')
    await expect(run({ ...base, reviewers: ['someone'] })).rejects.toThrow('reviewers')
    await expect(run({ kind: 'updateMergeRequest', iid: 7, addAssignees: ['someone'] })).rejects.toThrow('no assignees')
  })

  it('edits the fields given and adds or removes labels by name', async () => {
    const { calls } = await run({
      kind: 'updateMergeRequest',
      iid: 7,
      title: 'New',
      targetBranch: 'release',
      draft: false,
      addLabels: ['ready'],
      removeLabels: ['wip']
    })
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', `${REPO}/pullrequests/7/labels${V}`, { name: 'ready' }],
      ['DELETE', `${REPO}/pullrequests/7/labels/wip${V}`, undefined],
      ['PATCH', `${REPO}/pullrequests/7${V}`, { title: 'New', targetRefName: 'refs/heads/release', isDraft: false }]
    ])
  })

  it('completes at the source commit it reads, with the chosen strategy', async () => {
    const fenced = await run({ kind: 'mergeMergeRequest', iid: 7, method: 'squash', sha: SHA.toUpperCase() })
    expect(fenced.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', `${REPO}/pullrequests/7${V}`, undefined],
      [
        'PATCH',
        `${REPO}/pullrequests/7${V}`,
        {
          status: 'completed',
          lastMergeSourceCommit: { commitId: SHA },
          completionOptions: { mergeStrategy: 'squash' }
        }
      ]
    ])
    const plain = await run({ kind: 'mergeMergeRequest', iid: 7 })
    expect(plain.calls[1]!.body).toMatchObject({ completionOptions: { mergeStrategy: 'noFastForward' } })
    await expect(run({ kind: 'mergeMergeRequest', iid: 7, sha: 'abc' })).rejects.toThrow('full commit sha')
  })

  it('refuses a completion Azure DevOps would accept and never run: a moved source, or a closed pull request', async () => {
    const moved = run({ kind: 'mergeMergeRequest', iid: 7, sha: 'b'.repeat(40) })
    await expect(moved).rejects.toThrow(`source is now at ${SHA}`)
    const abandoned = JSON.stringify({ ...JSON.parse(PULL), status: 'abandoned' })
    const { fetchImpl, calls } = fakeFetch({ body: abandoned })
    await expect(broker(fetchImpl).instance.execute(TARGET, { kind: 'mergeMergeRequest', iid: 7 })).rejects.toThrow(
      'is abandoned'
    )
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('abandons and reactivates', async () => {
    const closed = await run({ kind: 'setState', subject: 'merge_request', iid: 7, state: 'closed' })
    expect(closed.calls[0]!.body).toEqual({ status: 'abandoned' })
    const reopened = await run({ kind: 'setState', subject: 'merge_request', iid: 7, state: 'open' })
    expect(reopened.calls[0]!.body).toEqual({ status: 'active' })
  })

  it('refuses a write below the write tier before any call', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance } = broker(fetchImpl, { access: 'read' })
    await expect(
      instance.execute(TARGET, { kind: 'setState', subject: 'merge_request', iid: 7, state: 'closed' })
    ).rejects.toThrow('needs write authority')
    expect(calls).toEqual([])
  })
})

describe('comment threads', () => {
  const THREAD = JSON.stringify({ id: 31, comments: [{ id: 1, content: 'Hello', author: { displayName: 'Agent' } }] })

  it('opens a thread, and updates only a thread this session opened', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: THREAD })
    const { instance } = broker(fetchImpl, { access: 'comment' })
    const created = await instance.execute(TARGET, {
      kind: 'createComment',
      subject: 'merge_request',
      iid: 7,
      body: 'Hello'
    })
    expect(created).toEqual({ comment: { id: 31, threadId: 31, author: 'Agent', body: 'Hello' } })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${REPO}/pullrequests/7/threads${V}`,
      body: { comments: [{ parentCommentId: 0, content: 'Hello', commentType: 1 }], status: 1 }
    })
    await instance.execute(TARGET, {
      kind: 'updateComment',
      subject: 'merge_request',
      iid: 7,
      noteId: '31',
      body: 'Edited'
    })
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: `${REPO}/pullrequests/7/threads/31/comments/1${V}`,
      body: { content: 'Edited' }
    })
    await expect(
      instance.execute(TARGET, { kind: 'updateComment', subject: 'merge_request', iid: 7, noteId: '32', body: 'x' })
    ).rejects.toThrow('only a comment this session created')
  })

  it('replies under a thread’s first comment', async () => {
    const { calls } = await run(
      { kind: 'replyDiscussion', subject: 'merge_request', iid: 7, discussionId: '31', body: 'Reply' },
      {},
      { body: '{"id":2,"content":"Reply"}' }
    )
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${REPO}/pullrequests/7/threads/31/comments${V}`,
      body: { parentCommentId: 1, content: 'Reply', commentType: 1 }
    })
  })

  it('reads the pull request with its newest threads, or one thread', async () => {
    const threads = JSON.stringify({ value: [1, 2, 3].map((id) => ({ id, comments: [{ id: 1, content: `c${id}` }] })) })
    const { result } = await run(
      { kind: 'readDiscussions', subject: 'merge_request', iid: 7, limit: 2 },
      { access: 'read' },
      { bodies: [PULL, threads] }
    )
    expect((result as { threads: { id: number }[] }).threads.map((t) => t.id)).toEqual([2, 3])
    const one = await run(
      { kind: 'readDiscussions', subject: 'merge_request', iid: 7, discussionId: '31' },
      { access: 'read' },
      { body: THREAD }
    )
    expect(one.calls.map((c) => c.url)).toEqual([`${REPO}/pullrequests/7/threads/31${V}`])
  })

  it('refuses issues, work items and pipelines', async () => {
    await expect(run({ kind: 'createComment', subject: 'issue', iid: 7, body: 'x' })).rejects.toThrow('work items')
    await expect(run({ kind: 'createIssue', title: 'x' })).rejects.toThrow('work items')
    await expect(run({ kind: 'inspectPipelines', scope: 'pipelines' })).rejects.toThrow('Pipelines')
  })
})

describe('a rejected lease', () => {
  it('is dropped and re-minted once', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401] })
    const { instance, invalidate } = broker(fetchImpl, { tokens: ['stale', 'fresh'] })
    await instance.execute(TARGET, { kind: 'setState', subject: 'merge_request', iid: 7, state: 'closed' })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(calls.map((c) => c.auth)).toEqual(['Bearer stale', 'Bearer fresh'])
  })
})

describe('a hook turn (§11.5)', () => {
  const HOOKED: CodeHostEffectTarget = { ...TARGET, hookId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  const COMMENT: CodeHostBrokerOperation = { kind: 'createComment', subject: 'merge_request', iid: 7, body: 'Hello' }

  function hooked(own: BrokerCapability | 'none', fetchImpl: typeof fetch) {
    const ownLease = vi.fn(async () => {
      if (own === 'none') throw new Error('repository 42 is not authorized for this agent')
      return { token: 'own', access: own }
    })
    const hookLease = vi.fn(async () => ({ token: 'hook', access: 'comment' as const }))
    const instance = new AzureDevOpsBroker({
      routing: () => ROUTING,
      lease: ownLease,
      hookLease,
      fetchImpl
    })
    return { instance, ownLease, hookLease }
  }

  it('raises a repository held at read to comment through the hook’s lease', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: JSON.stringify({ id: 31, comments: [{ id: 1 }] }) })
    const { instance, hookLease } = hooked('read', fetchImpl)
    await instance.execute(HOOKED, COMMENT)
    expect(hookLease).toHaveBeenCalledWith(HOOKED)
    expect(calls[0]!.auth).toBe('Bearer hook')
  })

  it('keeps the agent’s own lease where it already covers the call', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: JSON.stringify({ id: 31, comments: [{ id: 1 }] }) })
    const { instance, hookLease } = hooked('write', fetchImpl)
    await instance.execute(HOOKED, COMMENT)
    expect(hookLease).not.toHaveBeenCalled()
    expect(calls[0]!.auth).toBe('Bearer own')
  })

  it('never lends the hook’s lease to a write, nor outside a hook turn', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance, hookLease } = hooked('read', fetchImpl)
    await expect(
      instance.execute(HOOKED, { kind: 'setState', subject: 'merge_request', iid: 7, state: 'closed' })
    ).rejects.toThrow('needs write authority')
    await expect(instance.execute(TARGET, COMMENT)).rejects.toThrow('needs comment authority')
    expect(hookLease).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('reads through the hook’s lease when the agent holds no lease on the repository', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const { instance, hookLease } = hooked('none', fetchImpl)
    await instance.execute(HOOKED, { kind: 'readDiscussions', subject: 'merge_request', iid: 7 })
    expect(hookLease).toHaveBeenCalledOnce()
    expect(calls.map((call) => call.auth)).toEqual(['Bearer hook', 'Bearer hook'])
  })
})

describe('the tools', () => {
  it('offers a pull-request tool, a comment tool and a read, with no issue, assignee or reviewer fields', () => {
    const names = AZURE_DEVOPS_EFFECT_TOOLS.map((tool) => tool.descriptor.name)
    expect(names).toEqual(['azureDevOpsPullRequest', 'azureDevOpsComment', 'readAzureDevOpsPullRequest'])
    const [pull, comment] = AZURE_DEVOPS_EFFECT_TOOLS
    const propertiesOf = (tool: (typeof AZURE_DEVOPS_EFFECT_TOOLS)[number]) =>
      (tool.descriptor.inputSchema as ObjectToolSchema).properties as Record<string, { enum?: string[] }>
    const props = propertiesOf(pull!)
    for (const key of ['assignees', 'addAssignees', 'removeAssignees', 'reviewers'])
      expect(props).not.toHaveProperty(key)
    expect(props).toHaveProperty('addLabels')
    expect(propertiesOf(comment!).subject!.enum).toEqual(['pull_request'])
    expect(pull!.guidance).not.toContain('Issue')
  })

  it('refuses an omitted field by name rather than dropping it, with `repository` still accepted', () => {
    const [pull] = AZURE_DEVOPS_EFFECT_TOOLS
    const create = { action: 'create', sourceBranch: 'f', targetBranch: 'main', title: 't' }
    for (const key of ['reviewers', 'assignees', 'addAssignees']) {
      const result = pull!.args.safeParse({ ...create, [key]: ['someone'] })
      expect(result.success).toBe(false)
      expect(JSON.stringify(result.error?.issues)).toContain(key)
    }
    expect(pull!.args.safeParse({ ...create, repository: 'example-org/Example Project/Example Repo' }).success).toBe(
      true
    )
  })
})
