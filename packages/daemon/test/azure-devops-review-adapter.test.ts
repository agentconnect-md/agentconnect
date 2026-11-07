// Azure DevOps formal review adapter (azure-devops-integration.md §11.6): head fence, marked threads, the summary, the shared vote, and recovery that writes only what is missing.
import { describe, expect, it } from 'vitest'
import {
  azureDevOpsReviewPublisherId,
  codeHostReviewPublicEffect,
  type AzureDevOpsHookMetadata,
  type CodeHostReviewAuthorize,
  type CodeHostReviewAuthorized,
  type CodeHostReviewOpAccepted,
  type CodeHostReviewOpRequest,
  type CodeHostReviewResultReport,
  type CodeHostReviewState,
  type HookConfigSnapshot
} from '@agentconnect.md/protocol'
import { sessionKey } from '../src/store/local-store.js'
import { CodeHostReviewRouter, type SubmitCodeReviewReq } from '../src/codehost/review-adapter.js'
import { codeHostReviewFallbackAllowed, type HookDispatchContext } from '../src/github/hook-coords.js'
import { AzureDevOpsReviewAdapter, type AzureDevOpsReviewOutcome } from '../src/azure-devops/review-adapter.js'
import { ReviewMarkerSigner } from '../src/codehost/review-marker.js'
import type { CodeHostReviewControlPlane, ReviewIntentRow } from '../src/codehost/review-outbox.js'

const ORG = 'example-org'
const PROJECT = '00000000-0000-4000-8000-0000000000a1'
const REPOSITORY = '00000000-0000-4000-8000-0000000000a2'
const IDENTITY = '00000000-0000-4000-8000-0000000000a3'
const HUMAN = '00000000-0000-4000-8000-0000000000a4'
const API = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPOSITORY}`
const REPO_ID = '41'
const PULL = 12
const PULL_PATH = `/pullRequests/${PULL}`
const HEAD = 'a'.repeat(40)
const OLD_HEAD = 'b'.repeat(40)
const MOVED_HEAD = 'c'.repeat(40)
const ITERATION = 3
const ATTEMPT = '11111111-1111-4111-8111-111111111111'
const SECOND_ATTEMPT = '55555555-5555-4555-8555-555555555555'
const THIRD_ATTEMPT = '66666666-6666-4666-8666-666666666666'
const HOOK_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_HOOK_ID = '77777777-7777-4777-8777-777777777777'
const DAEMON_ID = '44444444-4444-4444-8444-444444444444'
const AGENT_ID = 'agent-a'
const THREAD = `azure-devops:${REPO_ID}:pull:${PULL}`
const KEY = sessionKey('hook', HOOK_ID, THREAD, AGENT_ID)
const MARKER_SEED = 'azure-devops-review-marker-key-01'
const PUBLISHER = azureDevOpsReviewPublisherId(IDENTITY)

const signer = ReviewMarkerSigner.derived(Buffer.from(MARKER_SEED, 'utf8'))

const SNAPSHOT: HookConfigSnapshot = {
  configRevision: '4',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON_ID,
  reviewPolicy: 'full',
  reportingMode: 'off',
  gateMode: 'informational'
}

function azure(overrides: Partial<AzureDevOpsHookMetadata> = {}): AzureDevOpsHookMetadata {
  return {
    repoId: REPO_ID,
    repoPath: `${ORG}/Example Project/example-repo`,
    organization: ORG,
    projectId: PROJECT,
    repositoryId: REPOSITORY,
    deliveryKind: 'opened',
    target: { kind: 'pull', pullRequestId: PULL, headSha: HEAD },
    ...overrides
  }
}

function hookContext(overrides: Partial<HookDispatchContext> = {}): HookDispatchContext {
  return {
    hookId: HOOK_ID,
    agentId: AGENT_ID,
    deliveryKey: 'delivery-1',
    firedAt: '2026-11-07T00:00:00.000Z',
    event: 'merge_request:opened',
    snapshot: SNAPSHOT,
    azureDevOps: azure(),
    ...overrides
  }
}

function request(overrides: Partial<SubmitCodeReviewReq> = {}): SubmitCodeReviewReq {
  return {
    agentId: AGENT_ID,
    platform: 'hook',
    channel: HOOK_ID,
    thread: THREAD,
    event: 'COMMENT',
    verdict: 'neutral',
    body: 'Looks reasonable overall.',
    ...overrides
  }
}

interface FakeThread {
  id: number
  comments: { id: number; content: string; author: { id: string } }[]
  threadContext?: Record<string, unknown>
  pullRequestThreadContext?: Record<string, unknown>
}

interface AzureState {
  head: string
  threads: FakeThread[]
  votes: Map<string, number>
  nextId: number
  changes: { path: string; changeTrackingId: number }[]
}

function azureState(overrides: Partial<AzureState> = {}): AzureState {
  return {
    head: HEAD,
    threads: [],
    votes: new Map(),
    nextId: 101,
    changes: [{ path: '/src/a.ts', changeTrackingId: 7 }],
    ...overrides
  }
}

interface Call {
  method: string
  path: string
  query: string
  body?: Record<string, unknown>
}

interface ScriptEntry {
  method: string
  path: RegExp
  reply: 'network' | { status: number; body?: unknown }
  /** The request landed even though its answer was lost. */
  landed?: boolean
  /** Active only once this holds. */
  when?: () => boolean
  used?: boolean
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** Fake Azure DevOps: iterations, changes, threads, and one vote per reviewer identity. */
function fakeAzure(state: AzureState, script: ScriptEntry[] = []) {
  const calls: Call[] = []
  const createThread = (body: Record<string, unknown>) => {
    const comments = (body.comments as Array<Record<string, unknown>>).map((comment) => ({
      id: 1,
      content: String(comment.content),
      author: { id: IDENTITY }
    }))
    const thread: FakeThread = {
      id: state.nextId++,
      comments,
      ...(body.threadContext ? { threadContext: body.threadContext as Record<string, unknown> } : {}),
      ...(body.pullRequestThreadContext
        ? { pullRequestThreadContext: body.pullRequestThreadContext as Record<string, unknown> }
        : {})
    }
    state.threads.push(thread)
    return thread
  }
  const apply = (method: string, path: string, body: Record<string, unknown> | undefined): Response => {
    if (path === `${PULL_PATH}/iterations`) {
      return json({
        value: [
          { id: 1, sourceRefCommit: { commitId: OLD_HEAD } },
          { id: ITERATION, sourceRefCommit: { commitId: state.head } }
        ]
      })
    }
    if (path === `${PULL_PATH}/iterations/${ITERATION}/changes`) {
      return json({
        changeEntries: state.changes.map((change) => ({
          changeTrackingId: change.changeTrackingId,
          item: { path: change.path }
        }))
      })
    }
    if (path === `${PULL_PATH}/threads`) {
      if (method === 'GET') return json({ value: state.threads, count: state.threads.length })
      return json(createThread(body ?? {}))
    }
    const reviewer = new RegExp(`^${PULL_PATH}/reviewers/([0-9a-f-]{36})$`).exec(path)
    if (reviewer) {
      const id = reviewer[1]!
      if (method === 'PUT') state.votes.set(id, Number(body?.vote))
      if (!state.votes.has(id)) return json({ message: 'not a reviewer' }, 404)
      return json({ id, vote: state.votes.get(id) })
    }
    return json({ message: 'not found' }, 404)
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.slice(new URL(API).pathname.length)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, path, query: parsed.search, ...(body === undefined ? {} : { body }) })
    const hit = script.find(
      (entry) => !entry.used && entry.method === method && entry.path.test(path) && (entry.when?.() ?? true)
    )
    if (hit) {
      hit.used = true
      if (hit.landed) apply(method, path, body)
      if (hit.reply === 'network') throw new Error('socket hang up')
      return json(hit.reply.body ?? {}, hit.reply.status)
    }
    return apply(method, path, body)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

interface OpRow {
  attemptId: string
  fence: string
  kind: string
  state: 'issued' | 'request_started' | 'settled' | 'ambiguous' | 'unused'
  externalId?: string
}

const reconciles = (state: CodeHostReviewState) => codeHostReviewPublicEffect(state) !== 'unknown'
const recordIdOf = (attemptId: string, fence: string | number, kind: string, ordinal: number) =>
  `rec-${attemptId.slice(0, 8)}-${fence}-${kind}-${ordinal}`

function permanent(message: string): Error {
  return Object.assign(new Error(message), { retryable: false })
}

/** Fake control plane: one lease per pull request and publisher, the single-use ledger, release on a reconciled result. */
function fakeCp(opts: { seedStarted?: { attemptId: string; recordId: string; kind: string }[] } = {}) {
  const leases = new Map<string, { attemptId: string | null; fence: number; phase: string }>()
  const records = new Map<string, OpRow>()
  const authorizations: CodeHostReviewAuthorize[] = []
  const ops: CodeHostReviewOpRequest[] = []
  const results: CodeHostReviewResultReport[] = []
  for (const seed of opts.seedStarted ?? []) {
    records.set(seed.recordId, { attemptId: seed.attemptId, fence: '7', kind: seed.kind, state: 'request_started' })
  }
  const ownerOf = (attemptId: string) => [...leases.values()].find((lease) => lease.attemptId === attemptId)
  const cp: CodeHostReviewControlPlane = {
    supportsReview: () => true,
    authorize: async (payload): Promise<CodeHostReviewAuthorized> => {
      authorizations.push(payload)
      const key = `${payload.projectId}#${payload.mergeRequestIid}`
      let lease = leases.get(key)
      if (lease?.attemptId && lease.attemptId !== payload.attemptId) {
        return { authorized: false, attemptId: payload.attemptId, reason: 'lease_held', retryable: true }
      }
      if (!lease || lease.attemptId !== payload.attemptId) {
        lease = { attemptId: payload.attemptId, fence: (lease?.fence ?? 6) + 1, phase: 'open' }
        leases.set(key, lease)
      }
      return {
        authorized: true,
        attemptId: payload.attemptId,
        provider: 'azure-devops',
        projectId: payload.projectId,
        mergeRequestIid: payload.mergeRequestIid,
        expectedHeadSha: payload.headSha,
        lease: {
          attemptId: payload.attemptId,
          fence: String(lease.fence),
          leaseUntil: '2026-11-07T00:05:00.000Z',
          serviceAccountUserId: PUBLISHER
        }
      }
    },
    operate: async (payload): Promise<CodeHostReviewOpAccepted> => {
      ops.push(payload)
      const owner = ownerOf(payload.attemptId)
      if (!owner || String(owner.fence) !== payload.fence) throw permanent('not the owner')
      const recordId =
        payload.op === 'issue'
          ? recordIdOf(payload.attemptId, payload.fence, payload.kind, payload.ordinal)
          : payload.recordId
      let row = records.get(recordId)
      if (payload.op === 'issue') {
        if (row) throw permanent('an operation record already exists for those coordinates')
        row = { attemptId: payload.attemptId, fence: payload.fence, kind: payload.kind, state: 'issued' }
        records.set(recordId, row)
      } else if (!row) {
        throw permanent('no such record')
      } else if (payload.op === 'start') {
        row.state = 'request_started'
      } else if (payload.op === 'return-unused') {
        if (row.state !== 'issued') throw permanent('record already started')
        row.state = 'unused'
      } else {
        if (row.state === 'issued') throw permanent('record not started')
        if (payload.outcome.kind === 'ambiguous') row.state = 'ambiguous'
        else if (row.state === 'ambiguous' && !payload.outcome.externalId) throw permanent('name the object')
        else {
          row.state = 'settled'
          if (payload.outcome.externalId) row.externalId = payload.outcome.externalId
        }
      }
      return {
        op: payload.op,
        recordId,
        attemptId: row.attemptId,
        fence: row.fence,
        kind: row.kind as CodeHostReviewOpAccepted['kind'],
        ordinal: 0,
        state: row.state,
        phase: 'open'
      }
    },
    renew: async ({ attemptId, fence }) => ({
      attemptId,
      fence,
      leaseUntil: '2026-11-07T00:10:00.000Z',
      phase: 'open'
    }),
    report: async (payload) => {
      results.push(payload)
      const owner = ownerOf(payload.attemptId)
      const open = [...records.values()].some(
        (row) => row.attemptId === payload.attemptId && row.state !== 'settled' && row.state !== 'unused'
      )
      if (owner && reconciles(payload.state) && !open) owner.attemptId = null
      return { accepted: true, phase: owner?.attemptId === null ? 'settled' : 'ambiguous_locked' }
    }
  }
  return { cp, authorizations, ops, results, records }
}

class FakeReviewStore {
  readonly rows = new Map<string, ReviewIntentRow>()
  async recordReviewIntent(row: ReviewIntentRow): Promise<void> {
    this.rows.set(row.intentId, { ...row })
  }
  async clearReviewIntent(intentId: string): Promise<void> {
    this.rows.delete(intentId)
  }
  async listReviewIntents(daemonId: string): Promise<ReviewIntentRow[]> {
    return [...this.rows.values()].filter((row) => row.daemonId === daemonId)
  }
}

function harness(
  opts: {
    state?: AzureState
    script?: ScriptEntry[]
    control?: ReturnType<typeof fakeCp>
    hook?: HookDispatchContext
    key?: string
    agentId?: string
    attemptIds?: string[]
  } = {}
) {
  const state = opts.state ?? azureState()
  const host = fakeAzure(state, opts.script ?? [])
  const control = opts.control ?? fakeCp()
  const attemptIds = opts.attemptIds ?? [ATTEMPT]
  let minted = 0
  let clock = 1_000
  const adapter = new AzureDevOpsReviewAdapter({
    cp: () => control.cp,
    orgForAgent: () => 'org-1',
    daemonId: () => DAEMON_ID,
    store: new FakeReviewStore(),
    markerKey: async () => Buffer.from(MARKER_SEED, 'utf8'),
    token: async () => 'azure-devops-lease-token',
    identity: async () => IDENTITY,
    invalidateToken: () => {},
    log: { warn: () => {} },
    apiBaseUrl: (turn) => turn.apiRoot,
    fetchImpl: host.fetchImpl,
    newAttemptId: () => attemptIds[Math.min(minted++, attemptIds.length - 1)]!,
    newStartToken: () => `start-${control.ops.filter((op) => op.op === 'issue').length}`,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ambiguousWindowMs: 4_000,
    pollIntervalMs: 1_000
  })
  const hook = opts.hook ?? hookContext()
  const key = opts.key ?? KEY
  const turn = adapter.openTurn(key, hook, 'acp-session-1', { daemonId: DAEMON_ID, persist: async () => {} })
  return { adapter, state, hook, key, turn, control, calls: host.calls }
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET').map((c) => `${c.method} ${c.path}`)
const threadPosts = (calls: Call[]) => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/threads'))
const firstContent = (call: Call) => String((call.body!.comments as Array<{ content: string }>)[0]!.content)

describe('Azure DevOps review adapter — turns and routing', () => {
  it('opens a review turn only for a headed pull request on a review-generation delivery', () => {
    expect(harness().turn).toBeDefined()
    expect(harness({ hook: hookContext({ event: 'merge_request:review_requested' }) }).turn).toBeDefined()
    expect(harness({ hook: hookContext({ event: 'note:created' }) }).turn).toBeUndefined()
    expect(harness({ hook: hookContext({ snapshot: { ...SNAPSHOT, reviewPolicy: 'off' } }) }).turn).toBeUndefined()
    const headless = azure({ target: { kind: 'pull', pullRequestId: PULL } })
    expect(harness({ hook: hookContext({ azureDevOps: headless }) }).turn).toBeUndefined()
  })

  it('is the router’s adapter for its own turn', async () => {
    const h = harness()
    const router = new CodeHostReviewRouter()
    router.register(h.adapter)
    const outcome = (await router.submit(request())) as AzureDevOpsReviewOutcome
    expect(outcome).toMatchObject({ provider: 'azure-devops', state: 'submitted' })
  })

  it('names the identity’s numeric key and the surrogate repository to the control plane', async () => {
    const h = harness()
    await h.adapter.submit(h.key, request())
    expect(h.control.authorizations[0]).toMatchObject({
      provider: 'azure-devops',
      projectId: REPO_ID,
      mergeRequestIid: PULL,
      headSha: HEAD
    })
  })
})

describe('Azure DevOps review adapter — publication (§11.6 steps 1-4)', () => {
  it('re-reads the head, opens one marked thread per inline comment and a summary, then votes', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      h.key,
      request({
        event: 'APPROVE',
        verdict: 'pass',
        comments: [
          { path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Tighten this check.' },
          { path: '/src/b.ts', line: 4, side: 'LEFT', startLine: 2, startSide: 'LEFT', body: 'This was removed.' }
        ]
      })
    )) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(writes(h.calls)).toEqual([
      `POST ${PULL_PATH}/threads`,
      `POST ${PULL_PATH}/threads`,
      `POST ${PULL_PATH}/threads`,
      `PUT ${PULL_PATH}/reviewers/${IDENTITY}`
    ])
    const [first, second, summary] = threadPosts(h.calls)
    expect(first!.body).toMatchObject({
      status: 1,
      threadContext: {
        filePath: '/src/a.ts',
        rightFileStart: { line: 7, offset: 1 },
        rightFileEnd: { line: 7, offset: 1 }
      },
      pullRequestThreadContext: {
        changeTrackingId: 7,
        // Equal iterations: the left side is the common commit, never the first push.
        iterationContext: { firstComparingIteration: ITERATION, secondComparingIteration: ITERATION }
      }
    })
    expect(second!.body).toMatchObject({
      threadContext: {
        filePath: '/src/b.ts',
        leftFileStart: { line: 2, offset: 1 },
        leftFileEnd: { line: 4, offset: 1 }
      }
    })
    expect(summary!.body!.threadContext).toBeUndefined()
    // Every comment carries the signed attempt-and-ordinal marker, the summary ordinal 0.
    expect(signer.read(firstContent(summary!), HEAD)).toEqual({ attemptId: ATTEMPT, ordinal: 0 })
    expect(signer.read(firstContent(first!), HEAD)).toEqual({ attemptId: ATTEMPT, ordinal: 1 })
    expect(signer.read(firstContent(second!), HEAD)).toEqual({ attemptId: ATTEMPT, ordinal: 2 })
    expect(h.state.votes.get(IDENTITY)).toBe(10)
    expect(outcome.externalIds?.map((ref) => ref.kind)).toEqual(['discussion', 'discussion', 'discussion'])
    expect(outcome.externalIds?.[0]?.externalId).toBe(String(h.state.threads[2]!.id))
    // The calls carry the pinned version; the ledger targets stay bare paths.
    expect(h.calls.every((call) => call.query.includes('api-version=7.1'))).toBe(true)
    expect(h.control.ops.filter((op) => op.op === 'issue').map((op) => (op as { kind: string }).kind)).toEqual([
      'draft_create',
      'draft_create',
      'bulk_publish',
      'approval'
    ])
    expect(h.control.results.at(-1)).toMatchObject({ provider: 'azure-devops', state: 'submitted' })
    expect(JSON.stringify(h.control.results)).not.toContain('Tighten')
  })

  it('maps REQUEST_CHANGES to waiting for the author', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      h.key,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(h.state.votes.get(IDENTITY)).toBe(-5)
  })

  it('refuses a moved head before any write', async () => {
    const h = harness({ state: azureState({ head: MOVED_HEAD }) })
    const outcome = (await h.adapter.submit(
      h.key,
      request({ event: 'APPROVE', verdict: 'pass' })
    )) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(writes(h.calls)).toEqual([])
    expect(h.state.votes.size).toBe(0)
  })

  it('falls back from a refused range to its end line, and from a refused line into the summary', async () => {
    const h = harness({
      script: [
        { method: 'POST', path: /\/threads$/, reply: { status: 400, body: { message: 'bad range' } } },
        { method: 'POST', path: /\/threads$/, reply: { status: 400, body: { message: 'bad line' } } }
      ]
    })
    const outcome = (await h.adapter.submit(
      h.key,
      request({
        comments: [{ path: 'src/a.ts', line: 9, side: 'RIGHT', startLine: 5, startSide: 'RIGHT', body: 'Odd loop.' }]
      })
    )) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('submitted')
    const posts = threadPosts(h.calls)
    expect(
      posts.map(
        (call) => (call.body!.threadContext as Record<string, { line: number }> | undefined)?.rightFileStart?.line
      )
    ).toEqual([5, 9, undefined])
    expect(firstContent(posts[1]!)).toContain('Lines 5-9:')
    expect(firstContent(posts[2]!)).toContain('`src/a.ts` source line 9: Odd loop.')
  })

  it('reports not_submitted when the first thread is refused outright, and partial once something landed', async () => {
    const refused = harness({ script: [{ method: 'POST', path: /\/threads$/, reply: { status: 404 } }] })
    expect(((await refused.adapter.submit(refused.key, request())) as AzureDevOpsReviewOutcome).state).toBe(
      'not_submitted'
    )
    const partial = harness({
      script: [
        { method: 'POST', path: /\/threads$/, reply: { status: 201, body: { id: 501 } }, landed: false },
        { method: 'POST', path: /\/threads$/, reply: { status: 404 } }
      ]
    })
    const outcome = (await partial.adapter.submit(
      partial.key,
      request({ comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'One.' }] })
    )) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('review_state_not_recorded')
    expect(codeHostReviewPublicEffect(outcome.state)).toBe('present')
  })
})

describe('Azure DevOps review adapter — the shared vote (§11.6)', () => {
  it('lets a second agent’s verdict replace the first, and leaves it alone for a COMMENT review', async () => {
    const state = azureState()
    const control = fakeCp()
    const agents = [
      { agentId: 'agent-a', hookId: HOOK_ID, attempt: ATTEMPT },
      { agentId: 'agent-b', hookId: OTHER_HOOK_ID, attempt: SECOND_ATTEMPT },
      { agentId: 'agent-c', hookId: '88888888-8888-4888-8888-888888888888', attempt: THIRD_ATTEMPT }
    ].map(({ agentId, hookId, attempt }) => {
      const key = sessionKey('hook', hookId, THREAD, agentId)
      return {
        agentId,
        hookId,
        h: harness({ state, control, key, attemptIds: [attempt], hook: hookContext({ hookId, agentId }) })
      }
    })
    const submit = (index: number, overrides: Partial<SubmitCodeReviewReq>) => {
      const { agentId, hookId, h } = agents[index]!
      return h.adapter.submit(
        h.key,
        request({ agentId, channel: hookId, ...overrides })
      ) as Promise<AzureDevOpsReviewOutcome>
    }
    expect((await submit(0, { event: 'APPROVE', verdict: 'pass', body: 'Ship it.' })).state).toBe('submitted')
    expect(state.votes.get(IDENTITY)).toBe(10)
    expect((await submit(1, { event: 'REQUEST_CHANGES', verdict: 'fail', body: 'Blocking.' })).state).toBe('submitted')
    expect(state.votes.get(IDENTITY)).toBe(-5)
    expect((await submit(2, { event: 'COMMENT', verdict: 'neutral', body: 'A note.' })).state).toBe('submitted')
    expect(state.votes.get(IDENTITY)).toBe(-5)
    expect(writes(agents[2]!.h.calls)).toEqual([`POST ${PULL_PATH}/threads`])
    // Each verdict stays durable in its own summary thread.
    expect(state.threads).toHaveLength(3)
  })
})

describe('Azure DevOps review adapter — unknown answers and recovery (§11.6)', () => {
  it('finds a thread whose answer was lost by its marker and never writes it twice', async () => {
    const h = harness({ script: [{ method: 'POST', path: /\/threads$/, reply: 'network', landed: true }] })
    const outcome = (await h.adapter.submit(h.key, request())) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(threadPosts(h.calls)).toHaveLength(1)
    expect(h.state.threads).toHaveLength(1)
    expect([...h.control.records.values()].map((row) => row.state)).toEqual(['settled'])
  })

  it('writes a thread again once its lost answer stays unseen past the window', async () => {
    const h = harness({ script: [{ method: 'POST', path: /\/threads$/, reply: { status: 503 } }] })
    const outcome = (await h.adapter.submit(h.key, request())) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(threadPosts(h.calls)).toHaveLength(2)
    expect(h.state.threads).toHaveLength(1)
    expect([...h.control.records.values()].map((row) => row.state)).toEqual(['settled', 'settled'])
  })

  it('reads a vote back after a lost answer, and casts it once more when absent', async () => {
    const landed = harness({ script: [{ method: 'PUT', path: /\/reviewers\//, reply: 'network', landed: true }] })
    const first = (await landed.adapter.submit(
      landed.key,
      request({ event: 'APPROVE', verdict: 'pass' })
    )) as AzureDevOpsReviewOutcome
    expect(first.state).toBe('submitted')
    expect(writes(landed.calls).filter((call) => call.startsWith('PUT'))).toHaveLength(1)
    const lost = harness({ script: [{ method: 'PUT', path: /\/reviewers\//, reply: 'network' }] })
    const second = (await lost.adapter.submit(
      lost.key,
      request({ event: 'APPROVE', verdict: 'pass' })
    )) as AzureDevOpsReviewOutcome
    expect(second.state).toBe('submitted')
    expect(writes(lost.calls).filter((call) => call.startsWith('PUT'))).toHaveLength(2)
    expect(lost.state.votes.get(IDENTITY)).toBe(10)
  })

  it('locks when a lost thread cannot be read back at all', async () => {
    const posted = () => script.some((entry) => entry.method === 'POST' && entry.used)
    const script: ScriptEntry[] = [
      { method: 'POST', path: /\/threads$/, reply: 'network' },
      ...Array.from({ length: 10 }, (): ScriptEntry => ({
        method: 'GET',
        path: /\/threads$/,
        reply: { status: 500 },
        when: posted
      }))
    ]
    const h = harness({ script })
    const outcome = (await h.adapter.submit(h.key, request())) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
  })

  it('recovers a crashed attempt: adopts its landed thread, writes only the missing ones, and deletes nothing', async () => {
    const state = azureState()
    state.threads.push({
      id: 90,
      comments: [{ id: 1, content: `Tighten.\n\n${signer.mint(ATTEMPT, 1, HEAD)}`, author: { id: IDENTITY } }]
    })
    state.threads.push({ id: 91, comments: [{ id: 1, content: 'A person wrote this.', author: { id: HUMAN } }] })
    const recordId = recordIdOf(ATTEMPT, 7, 'draft_create', 0)
    const hook = hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'APPROVE',
        verdict: 'pass',
        headSha: HEAD,
        fence: '7',
        ordinals: { draft_create: 1 },
        operations: [
          {
            recordId,
            startToken: 'start-1',
            kind: 'draft_create',
            ordinal: 0,
            draftOrdinal: 1,
            target: `${PULL_PATH}/threads`,
            phase: 'started'
          }
        ]
      }
    })
    const control = fakeCp({ seedStarted: [{ attemptId: ATTEMPT, recordId, kind: 'draft_create' }] })
    const h = harness({ state, hook, control })
    const outcome = (await h.adapter.submit(
      h.key,
      request({
        event: 'APPROVE',
        verdict: 'pass',
        comments: [
          { path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Tighten.' },
          { path: 'src/a.ts', line: 9, side: 'RIGHT', body: 'And this.' }
        ]
      })
    )) as AzureDevOpsReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(control.records.get(recordId)).toMatchObject({ state: 'settled', externalId: '90' })
    expect(writes(h.calls)).toEqual([
      `POST ${PULL_PATH}/threads`,
      `POST ${PULL_PATH}/threads`,
      `PUT ${PULL_PATH}/reviewers/${IDENTITY}`
    ])
    expect(h.calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(state.threads.map((thread) => thread.id)).toEqual([90, 91, 101, 102])
    expect(outcome.externalIds?.map((ref) => ref.externalId)).toEqual(['102', '90', '101'])
  })
})
