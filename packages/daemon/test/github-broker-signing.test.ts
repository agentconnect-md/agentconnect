// The GitHub broker recreates a pull request's unsigned head commits through the Git Data API when the base branch requires signatures.
import { describe, expect, it } from 'vitest'
import { GithubBroker } from '../src/github/broker.js'
import {
  branchCommits,
  MAX_RECREATED_COMMITS,
  recreationPlan,
  type BranchCommit
} from '../src/github/signed-commits.js'
import type { BrokerCapability, CodeHostEffectTarget } from '../src/codehost/broker.js'

const BASE = 'https://api.github.example.test'
const REPO = '/repos/example-org/example-repo'
const BOT = { name: 'example-app[bot]', email: '123+example-app[bot]@users.noreply.github.com' }
const TARGET: CodeHostEffectTarget = {
  agentId: 'agent-1',
  provider: 'github',
  repoId: 'example-org/example-repo',
  repoPath: 'example-org/example-repo',
  sessionKey: 'session-1'
}

const sha = (id: string) => id.repeat(40)
const tree = (id: string) => `e${id}`.repeat(20)

interface Listed {
  id: string
  parents: string[]
  verified?: boolean
  author?: string
}

function listed({ id, parents, verified = false, author = BOT.email }: Listed) {
  return {
    sha: sha(id),
    parents: parents.map((parent) => ({ sha: sha(parent) })),
    commit: {
      message: `commit ${id}\n\nwith a body`,
      tree: { sha: tree(id) },
      author: { name: 'someone', email: author },
      verification: { verified, reason: verified ? 'valid' : 'unsigned' }
    }
  }
}

interface Fake {
  rules?: unknown[] | 403
  commits?: Listed[]
  head?: string
  movedTo?: string
  signs?: boolean
  pull?: Record<string, unknown>
}

function fakeGithub(fake: Fake) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  let refReads = 0
  let created = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname.slice(REPO.length)
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, path, ...(body ? { body } : {}) })
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (path.startsWith('/rules/branches/')) {
      return fake.rules === 403 ? json({ message: 'Upgrade to GitHub Pro' }, 403) : json(fake.rules ?? [])
    }
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
      refReads += 1
      const at = refReads > 1 && fake.movedTo ? fake.movedTo : (fake.head ?? '2')
      return json({ object: { sha: sha(at) } })
    }
    if (path.startsWith('/compare/')) {
      const commits = (fake.commits ?? []).map(listed)
      return json({ total_commits: commits.length, commits })
    }
    if (method === 'POST' && path === '/git/commits') {
      created += 1
      return json({ sha: `${created}`.padStart(40, 'c'), verification: { verified: fake.signs ?? true } }, 201)
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) return json({ object: { sha: body?.sha } })
    if (path === '/pulls' || path === '/pulls/42') return json(fake.pull ?? PULL, path === '/pulls' ? 201 : 200)
    return json({ message: 'Not Found' }, 404)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const PULL = {
  number: 42,
  node_id: 'PR_node42',
  title: 'Add a thing',
  state: 'open',
  draft: false,
  html_url: 'https://github.com/example-org/example-repo/pull/42',
  head: { ref: 'feature/x', repo: { full_name: 'example-org/example-repo' } },
  base: { ref: 'main' }
}

const REQUIRED = [{ type: 'pull_request' }, { type: 'required_signatures' }]

function broker(fetchImpl: typeof fetch, opts: { access?: BrokerCapability; identity?: boolean } = {}) {
  let leases = 0
  const gh = new GithubBroker({
    lease: async () => {
      leases += 1
      return { token: 'gh-token', access: opts.access ?? 'write' }
    },
    invalidateLease: () => {
      throw new Error('no lease should be dropped')
    },
    ...(opts.identity === false ? {} : { commitIdentity: () => BOT }),
    baseUrl: BASE,
    fetchImpl
  })
  return { gh, leases: () => leases }
}

const create = {
  kind: 'createMergeRequest' as const,
  sourceBranch: 'feature/x',
  targetBranch: 'main',
  title: 'Add a thing'
}

describe('recreating a pull request head so GitHub signs it', () => {
  it('recreates the unsigned commits in parent order, moves the branch, then opens the pull request', async () => {
    const { fetchImpl, calls } = fakeGithub({
      rules: REQUIRED,
      commits: [
        { id: '1', parents: ['0'] },
        { id: '2', parents: ['1'] }
      ]
    })
    const result = (await broker(fetchImpl).gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /rules/branches/main',
      'GET /git/ref/heads/feature%2Fx',
      `GET /compare/main...${sha('2')}`,
      'POST /git/commits',
      'POST /git/commits',
      'GET /git/ref/heads/feature%2Fx',
      'PATCH /git/refs/heads/feature%2Fx',
      'POST /pulls'
    ])
    const [first, second] = calls.filter((c) => c.path === '/git/commits').map((c) => c.body)
    // No author or committer, or GitHub would not sign.
    expect(first).toEqual({ message: 'commit 1\n\nwith a body', tree: tree('1'), parents: [sha('0')] })
    expect(second).toEqual({ message: 'commit 2\n\nwith a body', tree: tree('2'), parents: ['1'.padStart(40, 'c')] })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sha: '2'.padStart(40, 'c'), force: true })
    expect(calls.at(-1)?.body).toMatchObject({ head: 'feature/x', base: 'main' })
    expect(result.signedCommits).toMatchObject({
      signed: true,
      recreatedCommits: 2,
      previousHead: sha('2'),
      head: '2'.padStart(40, 'c')
    })
    expect(String((result.signedCommits as Record<string, unknown>).next)).toContain('git rebase origin/feature/x')
  })

  it('keeps a signed commit below the first unsigned one, and recreates a merge with both parents', async () => {
    const { fetchImpl, calls } = fakeGithub({
      rules: REQUIRED,
      head: '3',
      commits: [
        { id: '1', parents: ['0'], verified: true, author: 'person@example.test' },
        { id: '2', parents: ['1'] },
        { id: '3', parents: ['2', '9'], verified: true }
      ]
    })
    await broker(fetchImpl).gh.execute(TARGET, create)
    const bodies = calls.filter((c) => c.path === '/git/commits').map((c) => c.body?.parents)
    expect(bodies).toEqual([[sha('1')], ['1'.padStart(40, 'c'), sha('9')]])
  })

  it('leaves the branch alone when a commit to recreate is not the agent’s, and still opens the pull request', async () => {
    const { fetchImpl, calls } = fakeGithub({
      rules: REQUIRED,
      commits: [
        { id: '1', parents: ['0'], author: 'person@example.test' },
        { id: '2', parents: ['1'] }
      ]
    })
    const result = (await broker(fetchImpl).gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.some((c) => c.path === '/git/commits' || c.method === 'PATCH')).toBe(false)
    expect(calls.at(-1)?.path).toBe('/pulls')
    expect(result.signedCommits).toMatchObject({ signed: false })
    expect(String((result.signedCommits as Record<string, unknown>).reason)).toContain(
      `commit ${sha('1').slice(0, 12)} is not authored by this agent's GitHub App`
    )
  })

  it('leaves the branch alone when it moved while its commits were recreated', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, movedTo: '5', commits: [{ id: '2', parents: ['0'] }] })
    const result = (await broker(fetchImpl).gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(result.signedCommits).toEqual({
      signed: false,
      reason: 'feature/x moved while its commits were being recreated, so it was left as it was'
    })
  })

  it('leaves the branch alone when GitHub does not sign a recreated commit', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, signs: false, commits: [{ id: '2', parents: ['0'] }] })
    const result = (await broker(fetchImpl).gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(result.signedCommits).toMatchObject({ signed: false })
  })

  it('does nothing when every commit is already signed', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, commits: [{ id: '2', parents: ['0'], verified: true }] })
    const result = (await broker(fetchImpl).gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.some((c) => c.path === '/git/commits')).toBe(false)
    expect(result).not.toHaveProperty('signedCommits')
  })

  it('does nothing when the base branch does not require signatures', async () => {
    const { fetchImpl, calls } = fakeGithub({
      rules: [{ type: 'pull_request' }],
      commits: [{ id: '2', parents: ['0'] }]
    })
    const result = (await broker(fetchImpl).gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /rules/branches/main', 'POST /pulls'])
    expect(result).not.toHaveProperty('signedCommits')
  })

  it('reads a plan without rulesets as no rule, without minting the lease again', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: 403, commits: [{ id: '2', parents: ['0'] }] })
    const { gh, leases } = broker(fetchImpl)
    const result = (await gh.execute(TARGET, create)) as Record<string, unknown>
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /rules/branches/main', 'POST /pulls'])
    expect(leases()).toBe(1)
    expect(result).not.toHaveProperty('signedCommits')
  })

  it('does nothing without the agent’s commit identity', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, commits: [{ id: '2', parents: ['0'] }] })
    await broker(fetchImpl, { identity: false }).gh.execute(TARGET, create)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /pulls'])
  })

  it('recreates after an update to an open pull request whose head is in the same repository', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, commits: [{ id: '2', parents: ['0'] }] })
    const result = (await broker(fetchImpl).gh.execute(TARGET, {
      kind: 'updateMergeRequest',
      iid: 42,
      title: 'Renamed'
    })) as Record<string, unknown>
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /pulls/42',
      'GET /rules/branches/main',
      'GET /git/ref/heads/feature%2Fx',
      `GET /compare/main...${sha('2')}`,
      'POST /git/commits',
      'GET /git/ref/heads/feature%2Fx',
      'PATCH /git/refs/heads/feature%2Fx'
    ])
    expect(result.signedCommits).toMatchObject({ signed: true, recreatedCommits: 1 })
  })

  it('leaves a pull request from a fork, or a closed one, alone', async () => {
    for (const pull of [
      { ...PULL, head: { ref: 'feature/x', repo: { full_name: 'someone/example-repo' } } },
      { ...PULL, state: 'closed' }
    ]) {
      const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, pull, commits: [{ id: '2', parents: ['0'] }] })
      const result = (await broker(fetchImpl).gh.execute(TARGET, { kind: 'updateMergeRequest', iid: 42 })) as Record<
        string,
        unknown
      >
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /pulls/42'])
      expect(result).not.toHaveProperty('signedCommits')
    }
  })

  it('says why on a read-tier update, without writing', async () => {
    const { fetchImpl, calls } = fakeGithub({ rules: REQUIRED, commits: [{ id: '2', parents: ['0'] }] })
    const result = (await broker(fetchImpl, { access: 'read' }).gh.execute(TARGET, {
      kind: 'updateMergeRequest',
      iid: 42
    })) as Record<string, unknown>
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /pulls/42', 'GET /rules/branches/main'])
    expect(result.signedCommits).toMatchObject({ signed: false })
    expect(String((result.signedCommits as Record<string, unknown>).reason)).toContain('needs write authority')
  })
})

describe('which commits to recreate', () => {
  const commit = (id: string, parents: string[], verified = false): BranchCommit => ({
    sha: sha(id),
    tree: tree(id),
    parents: parents.map(sha),
    message: id,
    authorEmail: BOT.email,
    verified
  })

  it('orders parents first whatever order the compare lists them in', () => {
    const plan = recreationPlan([commit('3', ['2']), commit('2', ['1']), commit('1', ['0'])], BOT.email)
    expect(Array.isArray(plan) && plan.map((c) => c.message)).toEqual(['1', '2', '3'])
  })

  it('refuses a branch longer than the bound, and a compare that lists only part of the branch', () => {
    const id = (i: number) => i.toString(16).padStart(2, '0')
    const many = Array.from({ length: MAX_RECREATED_COMMITS + 1 }, (_, i) => commit(id(i), [i === 0 ? 'f' : id(i - 1)]))
    expect(recreationPlan(many, BOT.email)).toEqual({
      refused: `${MAX_RECREATED_COMMITS + 1} commits would be recreated, more than ${MAX_RECREATED_COMMITS}`
    })
    expect(branchCommits({ total_commits: 300, commits: [] })).toEqual({
      refused: 'the branch has 300 commits, more than GitHub lists at once'
    })
  })
})
