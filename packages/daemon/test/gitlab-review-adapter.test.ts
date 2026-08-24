// The GitLab formal merge-request review adapter (gitlab-com-integration.md §15, §15.1,
// §15.2) and the §23 review matrix rows that belong to the daemon: the thirteen steps,
// the publication lease and its single-use operation ledger, marker reconciliation, and
// every ambiguous effect failing closed instead of publishing a fallback.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEHOST_REVIEW_V1_FEATURE,
  type CodeHostReviewAuthorize,
  type CodeHostReviewAuthorized,
  type CodeHostReviewLeasePhase,
  type CodeHostReviewOpAccepted,
  type CodeHostReviewOpRequest,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewResultReport,
  type HookConfigSnapshot
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { CodeHostReviewRouter, type SubmitCodeReviewReq } from '../src/codehost/review-adapter.js'
import {
  codeHostReviewFallbackAllowed,
  hookOutputFallbackAllowed,
  type CodeReviewAttempt,
  type HookDispatchContext
} from '../src/github/hook-coords.js'
import {
  GitlabReviewAdapter,
  type GitlabReviewControlPlane,
  type GitlabReviewOutcome,
  type ReviewIntentRow
} from '../src/gitlab/review-adapter.js'
import { ReviewMarkerSigner } from '../src/gitlab/review-marker.js'
import { hookCoordinates, reviewSubjectLane, type HookQueueCandidate } from '../src/codehost/hook-admission.js'
import { planRevisionAdmission, planRevisionAdmissionEffects } from '../src/codehost/queue-admission.js'
import type { QueueEntry } from '../src/daemon/turn-types.js'

const BASE = 'https://gitlab.example.test/api/v4'
const PROJECT = '4455667'
const IID = 77
const HEAD = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const OTHER_HEAD = 'c'.repeat(40)
// Deliberately past 2^53 so every id path stays a decimal string end to end.
const SA_USER = '9007199254740993'
const MR_ID = '9007199254740995'
const HUMAN_USER = '9007199254740999'
const ATTEMPT = '11111111-1111-4111-8111-111111111111'
const OLD_ATTEMPT = '22222222-2222-4222-8222-222222222222'
const HOOK_ID = '33333333-3333-4333-8333-333333333333'
const DAEMON_ID = '44444444-4444-4444-8444-444444444444'
const AGENT_ID = 'bot-a'
const THREAD = `gitlab:${PROJECT}:merge_request:${IID}`
const KEY = sessionKey('hook', HOOK_ID, THREAD, AGENT_ID)
const MARKER_SEED = 'gitlab-review-marker-test-key-01'

const signer = new ReviewMarkerSigner(Buffer.from(MARKER_SEED, 'utf8'))

const SNAPSHOT: HookConfigSnapshot = {
  configRevision: '4',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON_ID,
  reviewPolicy: 'full',
  reportingMode: 'off',
  gateMode: 'informational'
}

function hookContext(overrides: Partial<HookDispatchContext> = {}): HookDispatchContext {
  return {
    hookId: HOOK_ID,
    agentId: AGENT_ID,
    deliveryKey: 'delivery-1',
    firedAt: '2026-01-01T00:00:00.000Z',
    event: 'merge_request:opened',
    snapshot: SNAPSHOT,
    gitlab: {
      projectId: PROJECT,
      projectPath: 'example-group/example-project',
      target: { kind: 'merge_request', iid: IID, headSha: HEAD, baseSha: BASE_SHA }
    },
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

interface GitlabState {
  userId: string
  sha: string
  detailedMergeStatus: string
  mergeStatusSequence: string[]
  patchIdSha: string | null
  reviewers: Array<{ user: { id: string }; state?: string }>
  drafts: Array<{ id: string; note: string; position?: unknown }>
  notes: Array<{ id: string; body: string }>
  approvedBy: Array<{ user: { id: string } }>
  nextId: bigint
}

function gitlabState(overrides: Partial<GitlabState> = {}): GitlabState {
  return {
    userId: SA_USER,
    sha: HEAD,
    detailedMergeStatus: 'mergeable',
    mergeStatusSequence: [],
    patchIdSha: 'p'.repeat(40),
    reviewers: [],
    drafts: [],
    notes: [],
    approvedBy: [],
    nextId: 9007199254741001n,
    ...overrides
  }
}

interface Call {
  method: string
  path: string
  query: string
  token: string
  body?: Record<string, unknown>
}

type Reply = 'network' | { status: number; body?: unknown }

interface ScriptEntry {
  method: string
  path: RegExp
  reply: Reply
  /** Provider-side effect this scripted reply also had. */
  then?: () => void
  used?: boolean
}

/** Ids are written as strings here and emitted UNQUOTED, so every response exercises the
 *  daemon's big-int-safe re-quoting exactly as GitLab's own numeric ids would. */
function json(value: unknown, status = 200): Response {
  const text = JSON.stringify(value).replace(/"((?:[a-z][a-z0-9_]*_)?id)":"(\d{15,})"/g, '"$1":$2')
  return new Response(text, { status, headers: { 'content-type': 'application/json' } })
}

/** A route-driven fake GitLab; `script` intercepts the first matching call per entry. */
function fakeGitlab(state: GitlabState, script: ScriptEntry[] = []) {
  const calls: Call[] = []
  const mr = () => ({
    id: MR_ID,
    iid: IID,
    state: 'opened',
    sha: state.sha,
    detailed_merge_status: state.mergeStatusSequence.length
      ? state.mergeStatusSequence.shift()
      : state.detailedMergeStatus,
    diff_refs: { base_sha: BASE_SHA, start_sha: BASE_SHA, head_sha: state.sha }
  })
  const nextId = () => {
    const id = state.nextId
    state.nextId += 1n
    return id
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.replace('/api/v4', '')
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({
      method,
      path,
      query: parsed.search,
      token: headers['private-token'] ?? '',
      ...(body === undefined ? {} : { body })
    })
    const hit = script.find((entry) => !entry.used && entry.method === method && entry.path.test(path))
    if (hit) {
      hit.used = true
      hit.then?.()
      if (hit.reply === 'network') throw new Error('socket hang up')
      return new Response(hit.reply.body === undefined ? null : JSON.stringify(hit.reply.body), {
        status: hit.reply.status,
        ...(hit.reply.body === undefined ? {} : { headers: { 'content-type': 'application/json' } })
      })
    }
    if (path === '/user') return json({ id: state.userId })
    const mrPath = `/projects/${PROJECT}/merge_requests/${IID}`
    if (path === mrPath) return json(mr())
    if (path === `${mrPath}/reviewers`) return json(state.reviewers)
    if (path === `${mrPath}/versions`) return json([{ id: 1, patch_id_sha: state.patchIdSha }])
    if (path === `${mrPath}/notes`) return json(state.notes)
    if (path === `${mrPath}/approvals`) {
      return json({ id: MR_ID, sha: state.sha, approved_by: state.approvedBy })
    }
    if (path === `${mrPath}/draft_notes`) {
      if (method === 'GET') return json(state.drafts)
      const draft = { id: String(nextId()), note: String(body?.note ?? ''), position: body?.position }
      state.drafts.push(draft)
      return json(draft, 201)
    }
    if (path === `${mrPath}/draft_notes/bulk_publish`) {
      for (const draft of state.drafts) state.notes.push({ id: String(nextId()), body: draft.note })
      state.drafts = []
      const reviewerState = body?.reviewer_state
      if (typeof reviewerState === 'string') {
        const row = state.reviewers.find((entry) => entry.user.id === state.userId)
        if (row) row.state = reviewerState
      }
      return new Response(null, { status: 204 })
    }
    if (path.startsWith(`${mrPath}/draft_notes/`) && method === 'DELETE') {
      const id = path.slice(`${mrPath}/draft_notes/`.length)
      state.drafts = state.drafts.filter((draft) => draft.id !== id)
      return new Response(null, { status: 204 })
    }
    if (path === `${mrPath}/approve` && method === 'POST') {
      state.approvedBy.push({ user: { id: SA_USER } })
      return json({ id: MR_ID, sha: state.sha, approved_by: state.approvedBy })
    }
    return json({ message: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

interface CpOptions {
  refuse?: CodeHostReviewRefusalReason
  supports?: boolean
  renewPhase?: CodeHostReviewLeasePhase
  serviceAccountUserId?: string
  /** Operation records a previous incarnation left permitted but unsettled. */
  seedStarted?: string[]
  /** Return an error to fail that delivery; the frame is then owed and replayed. */
  operateFails?: (op: CodeHostReviewOpRequest) => Error | undefined
  /** Return an error to refuse a `return-unused` frame. */
  returnUnusedFails?: () => Error | undefined
  reportFails?: (result: CodeHostReviewResultReport) => Error | undefined
}

function fakeCp(opts: CpOptions = {}) {
  const records = new Map<string, 'issued' | 'request_started' | 'settled' | 'ambiguous'>(
    (opts.seedStarted ?? []).map((id) => [id, 'request_started' as const])
  )
  const authorizations: CodeHostReviewAuthorize[] = []
  const ops: CodeHostReviewOpRequest[] = []
  const results: CodeHostReviewResultReport[] = []
  const cp: GitlabReviewControlPlane = {
    supportsReview: () => opts.supports !== false,
    authorize: async (payload): Promise<CodeHostReviewAuthorized> => {
      authorizations.push(payload)
      if (opts.refuse) {
        return { authorized: false, attemptId: payload.attemptId, reason: opts.refuse, retryable: false }
      }
      // The real broker refuses REQUEST_CHANGES without a current reviewer record.
      if (payload.requestedEvent === 'REQUEST_CHANGES' && payload.serviceAccountIsReviewer !== true) {
        return {
          authorized: false,
          attemptId: payload.attemptId,
          reason: 'reviewer_assignment_required',
          retryable: false
        }
      }
      return {
        authorized: true,
        attemptId: payload.attemptId,
        provider: 'gitlab',
        projectId: payload.projectId,
        mergeRequestIid: payload.mergeRequestIid,
        expectedHeadSha: payload.headSha,
        lease: {
          attemptId: payload.attemptId,
          fence: '7',
          leaseUntil: '2026-01-01T00:05:00.000Z',
          serviceAccountUserId: opts.serviceAccountUserId ?? SA_USER
        }
      }
    },
    operate: async (payload): Promise<CodeHostReviewOpAccepted> => {
      ops.push(payload)
      const failure =
        payload.op === 'settle'
          ? opts.operateFails?.(payload)
          : payload.op === 'return-unused'
            ? opts.returnUnusedFails?.()
            : undefined
      if (failure) throw failure
      if (payload.op === 'issue') {
        const recordId = `rec-${payload.kind}-${payload.ordinal}`
        if (records.get(recordId) === 'settled') throw new Error('permit conflict')
        records.set(recordId, 'issued')
        return {
          op: 'issue',
          recordId,
          attemptId: payload.attemptId,
          fence: payload.fence,
          kind: payload.kind,
          ordinal: payload.ordinal,
          state: 'issued',
          phase: 'open'
        }
      }
      const [, kind, ordinal] = payload.recordId.split('-')
      if (payload.op === 'start') records.set(payload.recordId, 'request_started')
      else if (payload.op === 'return-unused') records.set(payload.recordId, 'settled')
      else if (payload.op === 'settle') {
        // The control-plane contract: an ambiguous record stays non-terminal until a
        // deterministic settle NAMES the provider object it left behind.
        if (payload.outcome.kind === 'ambiguous') records.set(payload.recordId, 'ambiguous')
        else if (records.get(payload.recordId) !== 'ambiguous' || payload.outcome.externalId) {
          records.set(payload.recordId, 'settled')
        }
      }
      return {
        op: payload.op,
        recordId: payload.recordId,
        attemptId: payload.attemptId,
        fence: payload.fence,
        kind: kind as CodeHostReviewOpAccepted['kind'],
        ordinal: Number(ordinal),
        state: payload.op === 'start' ? 'request_started' : 'settled',
        phase: 'open'
      }
    },
    renew: async ({ attemptId, fence }) => ({
      attemptId,
      fence,
      leaseUntil: '2026-01-01T00:10:00.000Z',
      phase: opts.renewPhase ?? 'open'
    }),
    report: async (payload) => {
      results.push(payload)
      const failure = opts.reportFails?.(payload)
      if (failure) throw failure
      return { accepted: true, phase: 'settled' }
    }
  }
  return { cp, authorizations, ops, results, records }
}

/** The daemon-local durability the adapter depends on, in memory. */
class FakeReviewStore {
  readonly rows = new Map<string, ReviewIntentRow>()
  private secret?: string
  /** Writes still to be refused; Infinity models a store that never comes back. */
  failWrites = 0
  /** The real store answers one bounded page at a time. */
  pageSize = 100

  async recordReviewIntent(row: ReviewIntentRow): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1
      throw new Error('store unavailable')
    }
    this.rows.set(row.intentId, { ...row })
  }

  async clearReviewIntent(intentId: string): Promise<void> {
    this.rows.delete(intentId)
  }

  async listReviewIntents(daemonId: string): Promise<ReviewIntentRow[]> {
    return [...this.rows.values()].filter((row) => row.daemonId === daemonId).slice(0, this.pageSize)
  }

  /** One value for the process's lifetime, exactly like the store row it stands in for. */
  async getOrCreateDaemonSecret(mint: () => string): Promise<string> {
    this.secret ??= mint()
    return this.secret
  }
}

/** A hand-driven timer so the resweep backoff is deterministic. */
function fakeScheduler() {
  const pending: Array<{ fn: () => void; id: number }> = []
  let next = 1
  const scheduler = {
    now: () => 0,
    setTimeout: (fn: () => void) => {
      const id = next++
      pending.push({ fn, id })
      return id
    },
    clearTimeout: (handle: unknown) => {
      const index = pending.findIndex((entry) => entry.id === handle)
      if (index >= 0) pending.splice(index, 1)
    }
  }
  return {
    scheduler,
    armed: () => pending.length,
    async fire(): Promise<void> {
      const entry = pending.shift()
      entry?.fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

interface Harness {
  adapter: GitlabReviewAdapter
  state: GitlabState
  hook: HookDispatchContext
  calls: Call[]
  ops: CodeHostReviewOpRequest[]
  results: CodeHostReviewResultReport[]
  authorizations: CodeHostReviewAuthorize[]
  reviewStore: FakeReviewStore
  timer: ReturnType<typeof fakeScheduler>
  records: Map<string, 'issued' | 'request_started' | 'settled' | 'ambiguous'>
  persisted: () => number
  tokens: () => string[]
  invalidated: () => string[]
}

function harness(
  opts: {
    state?: GitlabState
    script?: ScriptEntry[]
    cp?: CpOptions
    tokens?: string[]
    hook?: HookDispatchContext
    reviewStore?: FakeReviewStore
    seedStarted?: string[]
    attemptIds?: string[]
    open?: boolean
    failPersist?: boolean
    /** Fail only the hook-row writes this predicate selects. */
    persistFails?: () => boolean
  } = {}
): Harness {
  const state = opts.state ?? gitlabState()
  const gitlab = fakeGitlab(state, opts.script ?? [])
  const control = fakeCp({ ...(opts.cp ?? {}), ...(opts.seedStarted ? { seedStarted: opts.seedStarted } : {}) })
  const supply = opts.tokens ?? ['glpat-effect-1']
  const minted: string[] = []
  const invalidated: string[] = []
  const reviewStore = opts.reviewStore ?? new FakeReviewStore()
  const timer = fakeScheduler()
  const hook = opts.hook ?? hookContext()
  const attemptIds = opts.attemptIds ?? [ATTEMPT]
  let mintedAttempts = 0
  let persisted = 0
  let clock = 1_000
  const adapter = new GitlabReviewAdapter({
    cp: () => control.cp,
    orgForAgent: () => 'org-1',
    daemonId: () => DAEMON_ID,
    store: reviewStore,
    markerKey: async () => Buffer.from(await reviewStore.getOrCreateDaemonSecret(() => MARKER_SEED), 'utf8'),
    token: async () => {
      const token = supply[Math.min(minted.length, supply.length - 1)]!
      minted.push(token)
      return token
    },
    invalidateToken: (_turn, token) => void invalidated.push(token),
    log: { warn: () => {} },
    apiBaseUrl: () => BASE,
    fetchImpl: gitlab.fetchImpl,
    newAttemptId: () => attemptIds[Math.min(mintedAttempts++, attemptIds.length - 1)]!,
    newStartToken: () => `start-${control.ops.filter((op) => op.op === 'issue').length}`,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ambiguousWindowMs: 4_000,
    mergeStatusWindowMs: 4_000,
    pollIntervalMs: 1_000,
    scheduler: timer.scheduler,
    resweepBaseMs: 1_000
  })
  if (opts.open !== false) {
    adapter.openTurn(KEY, hook, 'acp-session-1', {
      daemonId: DAEMON_ID,
      persist: async () => {
        persisted += 1
        if (opts.failPersist || opts.persistFails?.()) throw new Error('inbox row is missing')
      }
    })
  }
  return {
    adapter,
    state,
    hook,
    calls: gitlab.calls,
    ops: control.ops,
    results: control.results,
    authorizations: control.authorizations,
    reviewStore,
    timer,
    records: control.records,
    persisted: () => persisted,
    tokens: () => minted,
    invalidated: () => invalidated
  }
}

const mutations = (calls: Call[]) =>
  calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)
const drafted = (calls: Call[]) => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/draft_notes'))
const published = (calls: Call[]) => calls.filter((call) => call.path.endsWith('/bulk_publish'))

function seedDraft(state: GitlabState, attemptId: string, ordinal: number, headSha = HEAD, id?: string): string {
  const draftId = id ?? String(state.nextId++)
  state.drafts.push({ id: draftId, note: `stale body\n\n${signer.mint(attemptId, ordinal, headSha)}` })
  return draftId
}

describe('GitLab review adapter — pre-effect rejections (§15)', () => {
  it('rejects an incompatible event/verdict pair before any provider or control-plane call', async () => {
    const h = harness()
    await expect(h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'fail' }))).rejects.toThrow(
      /APPROVE requires verdict=pass/
    )
    await expect(h.adapter.submit(KEY, request({ event: 'REQUEST_CHANGES', verdict: 'neutral' }))).rejects.toThrow(
      /REQUEST_CHANGES requires verdict=fail/
    )
    expect(h.calls).toEqual([])
    expect(h.authorizations).toEqual([])
  })

  it('rejects an empty body and an event above the hook policy before any provider call', async () => {
    const h = harness({ hook: hookContext({ snapshot: { ...SNAPSHOT, reviewPolicy: 'comment' } }) })
    await expect(h.adapter.submit(KEY, request({ body: '   ' }))).rejects.toThrow(/non-empty body/)
    await expect(h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))).rejects.toThrow(
      /exceeds this hook's comment review policy/
    )
    expect(h.calls).toEqual([])
  })

  it('refuses when the control plane does not advertise codehost-review-v1', async () => {
    const h = harness({ cp: { supports: false } })
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/codehost-review-v1/)
    expect(h.calls).toEqual([])
  })

  it('allows only one review attempt per turn', async () => {
    const h = harness()
    await h.adapter.submit(KEY, request())
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/already has a formal review attempt/)
    expect(published(h.calls)).toHaveLength(1)
  })

  it('is unavailable outside an authorized active merge-request turn', async () => {
    const h = harness()
    await expect(h.adapter.submit('other-key', request())).rejects.toThrow(/active merge-request hook turn/)
    h.adapter.closeTurn(KEY)
    expect(h.adapter.owns(KEY, AGENT_ID)).toBe(false)
  })

  it('opens no review turn for a delivery the review-generation gate does not open', () => {
    const h = harness()
    const open = (key: string, hook: HookDispatchContext, daemonId = DAEMON_ID) =>
      h.adapter.openTurn(key, hook, 's', { daemonId, persist: async () => {} })
    expect(open('k2', hookContext({ snapshot: { ...SNAPSHOT, reviewPolicy: 'off' } }))).toBeUndefined()
    expect(
      open('k3', hookContext({ gitlab: { projectId: PROJECT, projectPath: 'g/p', target: { kind: 'issue', iid: 5 } } }))
    ).toBeUndefined()
    expect(open('k4', hookContext(), 'another-daemon')).toBeUndefined()
    // An ordinary merge-request conversation must not own the structured tool.
    expect(open('k5', hookContext({ event: 'merge_request:labeled' }))).toBeUndefined()
    expect(open('k6', hookContext({ event: 'note:created' }))).toBeUndefined()
    // A head-less merge-request delivery has nothing to fence a review on.
    expect(
      open(
        'k7',
        hookContext({
          gitlab: { projectId: PROJECT, projectPath: 'g/p', target: { kind: 'merge_request', iid: IID } }
        })
      )
    ).toBeUndefined()
    // A relay-flagged review request opens one even on an otherwise ordinary event.
    expect(
      open(
        'k8',
        hookContext({
          event: 'merge_request:labeled',
          gitlab: {
            projectId: PROJECT,
            projectPath: 'g/p',
            target: { kind: 'merge_request', iid: IID, headSha: HEAD, explicitReviewRequest: true }
          }
        })
      )
    ).toBeDefined()
  })
})

describe('GitLab review adapter — the happy COMMENT path (§15 steps 4-12)', () => {
  it('creates marker-signed drafts, verifies the exact set, publishes once, and reports submitted', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      KEY,
      request({ comments: [{ path: 'src/a.ts', body: 'Bug here.', line: 9, side: 'RIGHT' }] })
    )) as GitlabReviewOutcome

    expect(outcome.state).toBe('submitted')
    expect(outcome.message).toContain('published on the merge request')
    expect(drafted(h.calls)).toHaveLength(2)
    expect(published(h.calls)).toHaveLength(1)
    // The summary is draft ordinal 0 and the inline comment carries the exact diff refs.
    const [summary, inline] = drafted(h.calls)
    expect(String(summary!.body!.note)).toContain('Looks reasonable overall.')
    expect(String(summary!.body!.note)).toContain(signer.mint(ATTEMPT, 0, HEAD))
    expect(String(inline!.body!.note)).toContain(signer.mint(ATTEMPT, 1, HEAD))
    expect(inline!.body!.position).toMatchObject({
      position_type: 'text',
      base_sha: BASE_SHA,
      head_sha: HEAD,
      new_path: 'src/a.ts',
      new_line: 9
    })
    // COMMENT omits reviewer_state per the §15 table.
    expect(published(h.calls)[0]!.body).toEqual({})
    // Body-free result: ids and one normalized state, never review text.
    const report = h.results.at(-1)!
    expect(report).toMatchObject({ provider: 'gitlab', projectId: PROJECT, mergeRequestIid: IID, state: 'submitted' })
    expect(JSON.stringify(report)).not.toContain('Looks reasonable overall.')
    expect(report.externalIds?.[0]).toMatchObject({ kind: 'note' })
    // Big-int ids survive as decimal strings.
    expect(report.externalIds?.[0]?.externalId).toMatch(/^\d{16}$/)
  })

  it('runs issue → start → settle for every provider mutation, with one start token per record', async () => {
    const h = harness()
    await h.adapter.submit(KEY, request())
    const sequence = h.ops.map((op) => (op.op === 'issue' ? `issue:${op.kind}:${op.ordinal}` : `${op.op}`))
    expect(sequence).toEqual(['issue:draft_create:0', 'start', 'settle', 'issue:bulk_publish:0', 'start', 'settle'])
    const starts = h.ops.filter((op) => op.op === 'start')
    expect(new Set(starts.map((op) => (op as { startToken: string }).startToken)).size).toBe(starts.length)
    // Every start names a record that was issued first, and the ledger stays fenced.
    expect(h.ops.every((op) => op.fence === '7')).toBe(true)
  })

  it('carries the reviewer fact into the authorization and keeps an unchanged state as submitted', async () => {
    const state = gitlabState({ reviewers: [{ user: { id: SA_USER }, state: 'unreviewed' }] })
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(h.authorizations[0]).toMatchObject({
      provider: 'gitlab',
      projectId: PROJECT,
      mergeRequestIid: IID,
      headSha: HEAD,
      serviceAccountIsReviewer: true
    })
    expect(outcome.state).toBe('submitted')
  })

  it('records review_state_changed_unexpectedly when the reviewer record moves under a COMMENT', async () => {
    const before = [{ user: { id: SA_USER }, state: 'unreviewed' }]
    const h = harness({
      state: gitlabState({ reviewers: before }),
      // The pre-lease and step-10 reads agree; only the postcondition read differs.
      script: [
        { method: 'GET', path: /\/reviewers$/, reply: { status: 200, body: before } },
        { method: 'GET', path: /\/reviewers$/, reply: { status: 200, body: before } },
        { method: 'GET', path: /\/reviewers$/, reply: { status: 200, body: [] } }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('review_state_changed_unexpectedly')
    expect(h.results.at(-1)!.state).toBe('review_state_changed_unexpectedly')
    expect(published(h.calls)).toHaveLength(1)
  })
})

describe('GitLab review adapter — reviewer prerequisites (§15 steps 7 and 10)', () => {
  it('refuses REQUEST_CHANGES without a reviewer record before any draft exists', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as GitlabReviewOutcome
    expect(outcome.state).toBe('reviewer_assignment_required')
    expect(outcome.message).toContain('COMMENT and verdict fail')
    expect(h.authorizations[0]!.serviceAccountIsReviewer).toBe(false)
    expect(mutations(h.calls)).toEqual([])
  })

  it('deletes this attempt’s drafts when the reviewer record disappears immediately before publication', async () => {
    const state = gitlabState({ reviewers: [{ user: { id: SA_USER }, state: 'unreviewed' }] })
    const h = harness({
      state,
      // The step-10 read is the third `/reviewers` GET; drop the record only there.
      script: [
        { method: 'GET', path: /\/reviewers$/, reply: { status: 200, body: state.reviewers } },
        { method: 'GET', path: /\/reviewers$/, reply: { status: 200, body: [] } }
      ]
    })
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as GitlabReviewOutcome
    expect(outcome.state).toBe('reviewer_assignment_required')
    expect(published(h.calls)).toEqual([])
    expect(mutations(h.calls).filter((call) => call.startsWith('DELETE'))).toHaveLength(1)
    expect(state.drafts).toEqual([])
  })

  it('publishes REQUEST_CHANGES with the reviewer_state parameter and confirms the recorded state', async () => {
    const state = gitlabState({ reviewers: [{ user: { id: SA_USER }, state: 'unreviewed' }] })
    const h = harness({ state })
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as GitlabReviewOutcome
    expect(published(h.calls)[0]!.body).toEqual({ reviewer_state: 'requested_changes' })
    expect(outcome.state).toBe('submitted')
  })

  it('classifies a missing requested-changes record from the refreshed merge status', async () => {
    const blocked = gitlabState({
      reviewers: [{ user: { id: SA_USER }, state: 'unreviewed' }],
      mergeStatusSequence: ['mergeable', 'mergeable', 'checking', 'requested_changes']
    })
    // The publish leaves the reviewer record behind, so only mergeability can answer.
    const h = harness({
      state: blocked,
      script: [{ method: 'POST', path: /bulk_publish$/, reply: { status: 204 } }]
    })
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as GitlabReviewOutcome
    expect(outcome.state).toBe('requested_changes_block_observed')
    // The recheck is requested rather than read from a stale value.
    expect(h.calls.some((call) => call.query.includes('with_merge_status_recheck=true'))).toBe(true)
    expect(published(h.calls)).toHaveLength(1)
  })

  it('records requested_changes_state_ambiguous when mergeability never settles on the block', async () => {
    const unstable = gitlabState({
      reviewers: [{ user: { id: SA_USER }, state: 'unreviewed' }],
      detailedMergeStatus: 'checking'
    })
    const h = harness({
      state: unstable,
      script: [{ method: 'POST', path: /bulk_publish$/, reply: { status: 204 } }]
    })
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as GitlabReviewOutcome
    expect(outcome.state).toBe('requested_changes_state_ambiguous')
    expect(published(h.calls)).toHaveLength(1)
  })
})

describe('GitLab review adapter — head and draft-set fencing (§15 steps 5, 9, 11)', () => {
  it('rejects a changed head before creating any draft', async () => {
    const h = harness({ state: gitlabState({ sha: OTHER_HEAD }) })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(mutations(h.calls)).toEqual([])
    expect(h.results.at(-1)!.state).toBe('not_submitted')
  })

  it('rejects a head that changes at the pre-publication re-verification and deletes its drafts', async () => {
    const state = gitlabState()
    const h = harness({
      state,
      script: [
        {
          method: 'GET',
          path: /merge_requests\/77$/,
          reply: {
            status: 200,
            body: {
              sha: HEAD,
              diff_refs: { base_sha: BASE_SHA, start_sha: BASE_SHA, head_sha: HEAD },
              detailed_merge_status: 'mergeable'
            }
          }
        },
        {
          method: 'GET',
          path: /merge_requests\/77$/,
          reply: {
            status: 200,
            body: {
              sha: OTHER_HEAD,
              diff_refs: { base_sha: BASE_SHA, start_sha: BASE_SHA, head_sha: OTHER_HEAD },
              detailed_merge_status: 'mergeable'
            }
          }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(published(h.calls)).toEqual([])
    expect(state.drafts).toEqual([])
  })

  it('preempts a stale-head turn without leaving the publication coordinator held', async () => {
    // The revision plan preempts the running HEAD generation once OTHER_HEAD arrives...
    const queued = (hook: HookDispatchContext): QueueEntry =>
      ({ agentId: AGENT_ID, msg: { platform: 'hook', channel: HOOK_ID }, hookContext: hook }) as unknown as QueueEntry
    const running = queued(hookContext())
    const pushed = queued(
      hookContext({
        deliveryKey: 'delivery-2',
        firedAt: '2026-01-01T00:01:00.000Z',
        event: 'merge_request:synchronize',
        gitlab: {
          projectId: PROJECT,
          projectPath: 'example-group/example-project',
          target: { kind: 'merge_request', iid: IID, headSha: OTHER_HEAD, baseSha: BASE_SHA }
        }
      })
    )
    const candidates: HookQueueCandidate[] = [{ key: KEY, entry: running, state: 'active' }]
    const plan = planRevisionAdmission(KEY, pushed, candidates)
    const effects = planRevisionAdmissionEffects(plan!, pushed)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([running])
    expect(effects.winnerLane).toBe(
      reviewSubjectLane(pushed.hookContext, hookCoordinates(AGENT_ID, { platform: 'hook', channel: HOOK_ID }))
    )

    // ...and the preempted turn's own attempt still reaches a terminal result, so the lease is released.
    const h = harness({ state: gitlabState({ sha: OTHER_HEAD }) })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(h.results.at(-1)).toMatchObject({ state: 'not_submitted' })
    h.adapter.closeTurn(KEY)
    expect(h.adapter.owns(KEY, AGENT_ID)).toBe(false)
  })

  it('fails closed when the pending draft set is not exactly this attempt’s', async () => {
    const foreign = { id: '9007199254749999', note: `foreign\n\n${signer.mint(OLD_ATTEMPT, 0, HEAD)}` }
    const h = harness({
      // Reconcile sees nothing; a concurrent draft appears by the step-9 exact-set check.
      script: [
        { method: 'GET', path: /draft_notes$/, reply: { status: 200, body: [] } },
        { method: 'GET', path: /draft_notes$/, reply: { status: 200, body: [foreign] } }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
    expect(published(h.calls)).toEqual([])
    expect(h.results.at(-1)!.state).toBe('review_reconciliation_required')
  })
})

describe('GitLab review adapter — orphan reconciliation (§15.1)', () => {
  it('recovers this attempt’s own pending drafts by ordinal instead of creating them again', async () => {
    const state = gitlabState()
    const recovered = seedDraft(state, ATTEMPT, 0)
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(drafted(h.calls)).toEqual([])
    expect(h.results.at(-1)!.state).toBe('submitted')
    expect(recovered).toMatch(/^\d+$/)
  })

  it('deletes an expired attempt’s drafts individually before starting a new one', async () => {
    const state = gitlabState()
    const stale = seedDraft(state, OLD_ATTEMPT, 0)
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    const deletes = h.calls.filter((call) => call.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.path).toContain(stale)
    expect(h.ops.some((op) => op.op === 'issue' && op.kind === 'draft_delete')).toBe(true)
    // The delete precedes the first create.
    const deleteAt = h.calls.findIndex((call) => call.method === 'DELETE')
    const createAt = h.calls.findIndex((call) => call.method === 'POST' && call.path.endsWith('/draft_notes'))
    expect(deleteAt).toBeLessThan(createAt)
  })

  it('reads back after an ambiguous delete and fails closed when the draft is still pending', async () => {
    const state = gitlabState()
    seedDraft(state, OLD_ATTEMPT, 0, HEAD, '9007199254742222')
    const h = harness({
      state,
      script: [{ method: 'DELETE', path: /draft_notes\//, reply: 'network' }]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
    expect(drafted(h.calls)).toEqual([])
    expect(h.results.at(-1)!.state).toBe('review_reconciliation_required')
  })

  it('treats a 404 on a stale draft as the absence it asked for', async () => {
    const state = gitlabState()
    seedDraft(state, OLD_ATTEMPT, 0, HEAD, '9007199254747777')
    const h = harness({
      state,
      script: [
        {
          method: 'DELETE',
          path: /draft_notes\//,
          reply: { status: 404, body: { message: '404 Not found' } },
          then: () => void (state.drafts = [])
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
  })

  it('fails closed on an unmarked pending draft', async () => {
    const state = gitlabState()
    state.drafts.push({ id: '9007199254743333', note: 'someone else was here' })
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
    expect(mutations(h.calls)).toEqual([])
  })

  it('fails closed on a marker this daemon cannot verify', async () => {
    const state = gitlabState()
    const foreign = new ReviewMarkerSigner(Buffer.from('a-different-daemons-marker-key-01'))
    state.drafts.push({ id: '9007199254744444', note: `x\n\n${foreign.mint(OLD_ATTEMPT, 0, HEAD)}` })
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
  })

  it('cannot be confused by a marker the model planted in its own review body', async () => {
    const h = harness()
    const planted = signer.mint(ATTEMPT, 0, HEAD)
    const outcome = (await h.adapter.submit(
      KEY,
      request({ body: `Please look here.\n${planted}` })
    )) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    const note = String(drafted(h.calls)[0]!.body!.note)
    // The authored copy is defanged so exactly one verifiable marker remains.
    expect(note.split('<!-- agentconnect-review:')).toHaveLength(2)
  })
})

describe('GitLab review adapter — ambiguous publication (§15.2)', () => {
  it('identifies an ambiguous publish by its summary marker and never publishes twice', async () => {
    const state = gitlabState()
    const h = harness({
      state,
      script: [
        {
          method: 'POST',
          path: /bulk_publish$/,
          reply: 'network'
        }
      ]
    })
    // The request actually landed: the summary note is visible under this attempt's marker.
    state.notes.push({ id: '9007199254745555', body: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(published(h.calls)).toHaveLength(1)
    expect(outcome.externalIds).toEqual([{ kind: 'note', externalId: '9007199254745555' }])
    // The ambiguous record is settled by positive identification, not left ambiguous.
    const settle = h.ops.filter((op) => op.op === 'settle').at(-1) as { outcome: { kind: string; externalId?: string } }
    expect(settle.outcome).toMatchObject({ kind: 'deterministic', externalId: '9007199254745555' })
  })

  it('locks the merge request when no marker appears within the observation window', async () => {
    const h = harness({
      script: [{ method: 'POST', path: /bulk_publish$/, reply: 'network' }]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(outcome.message).toContain('no fallback comment was posted')
    expect(published(h.calls)).toHaveLength(1)
    expect(h.results.at(-1)).toMatchObject({ state: 'ambiguous_locked' })
    expect(h.results.at(-1)!.externalIds).toBeUndefined()
    const settle = h.ops.filter((op) => op.op === 'settle').at(-1) as { outcome: { kind: string } }
    expect(settle.outcome.kind).toBe('ambiguous')
  })

  it('reports not_submitted for a deterministic publish rejection', async () => {
    const h = harness({
      script: [{ method: 'POST', path: /bulk_publish$/, reply: { status: 422, body: { message: 'no drafts' } } }]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(h.results.at(-1)!.externalIds).toBeUndefined()
  })

  it('surfaces a control-plane ambiguous_locked refusal without touching the provider', async () => {
    const h = harness({ cp: { refuse: 'ambiguous_locked' } })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(mutations(h.calls)).toEqual([])
  })

  it('stops before publication when the lease has already locked at renewal', async () => {
    const h = harness({ cp: { renewPhase: 'ambiguous_locked' } })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(published(h.calls)).toEqual([])
  })
})

describe('GitLab review adapter — approval (§15 step 13)', () => {
  it('waits for a settled merge status and diff, approves on the exact head, and verifies approved_by', async () => {
    const state = gitlabState({
      mergeStatusSequence: ['mergeable', 'mergeable', 'mergeable', 'checking', 'approvals_syncing', 'mergeable']
    })
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    const approve = h.calls.find((call) => call.path.endsWith('/approve'))!
    expect(approve.body).toEqual({ sha: HEAD })
    expect(published(h.calls)[0]!.body).toEqual({})
    expect(h.ops.some((op) => op.op === 'issue' && op.kind === 'approval')).toBe(true)
    expect(outcome.externalIds).toContainEqual({ kind: 'approval', externalId: MR_ID })
  })

  it('records approval_not_recorded, with no fallback, when the approval is rejected after publication', async () => {
    const h = harness({
      script: [
        { method: 'POST', path: /\/approve$/, reply: { status: 422, body: { message: 'not an eligible approver' } } }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GitlabReviewOutcome
    expect(outcome.state).toBe('approval_not_recorded')
    expect(published(h.calls)).toHaveLength(1)
    // A published effect exists, so the result keeps its external ids and never republishes.
    expect(h.results.at(-1)!.state).toBe('approval_not_recorded')
  })

  it('records approval_not_recorded when the diff never produces a patch id', async () => {
    const h = harness({ state: gitlabState({ patchIdSha: null }) })
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GitlabReviewOutcome
    expect(outcome.state).toBe('approval_not_recorded')
    expect(h.calls.some((call) => call.path.endsWith('/approve'))).toBe(false)
  })

  it('identifies an ambiguous approval from the readback instead of retrying it', async () => {
    const state = gitlabState()
    const h = harness({
      state,
      script: [{ method: 'POST', path: /\/approve$/, reply: 'network' }]
    })
    state.approvedBy.push({ user: { id: SA_USER } })
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(h.calls.filter((call) => call.path.endsWith('/approve'))).toHaveLength(1)
  })

  it('does not accept an approval recorded for somebody else', async () => {
    const state = gitlabState()
    const h = harness({
      state,
      script: [
        {
          method: 'POST',
          path: /\/approve$/,
          reply: { status: 201, body: { id: MR_ID, sha: HEAD, approved_by: [{ user: { id: HUMAN_USER } }] } }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GitlabReviewOutcome
    expect(outcome.state).toBe('approval_not_recorded')
  })
})

describe('GitLab review adapter — durable ownership and ack replay (round 2)', () => {
  it('claims the reply gate durably for a submitted review, and keeps it across a restart', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    // The durable hook row — not adapter memory — is what the ordinary-note gate reads.
    expect(h.hook.codeReview).toMatchObject({ attemptId: ATTEMPT, state: 'submitted', headSha: HEAD })
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
    // The turn-final surface asks ONE question, and a GitLab attempt answers it too.
    expect(hookOutputFallbackAllowed(h.hook)).toBe(false)
    // A restart replays that row into a fresh adapter: still no ordinary note, and no second attempt.
    const restarted = harness({ hook: h.hook, reviewStore: h.reviewStore })
    expect(codeHostReviewFallbackAllowed(restarted.hook)).toBe(false)
    await expect(restarted.adapter.submit(KEY, request())).rejects.toThrow(/already has a formal review attempt/)
    expect(mutations(restarted.calls)).toEqual([])
  })

  it('claims the reply gate for an ambiguous publication too', async () => {
    const h = harness({ script: [{ method: 'POST', path: /bulk_publish$/, reply: 'network' }] })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(h.hook.codeReview?.state).toBe('ambiguous_locked')
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
  })

  it('leaves the ordinary reply available only for a proven no-effect attempt', async () => {
    const h = harness({ state: gitlabState({ sha: OTHER_HEAD }) })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(true)
    expect(hookOutputFallbackAllowed(h.hook)).toBe(true)
    // A reserved attempt with no classification yet is unknown, so it blocks the note.
    expect(codeHostReviewFallbackAllowed({ ...h.hook, codeReview: { ...h.hook.codeReview!, state: undefined } })).toBe(
      false
    )
  })

  it('records the attempt before the first provider call and refuses when that write fails', async () => {
    const h = harness({ failPersist: true })
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/durability barrier failed/)
    expect(h.calls).toEqual([])
    expect(h.authorizations).toEqual([])
    // The rolled-back record must not leave a phantom attempt blocking the ordinary note.
    expect(h.hook.codeReview).toBeUndefined()
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(true)
  })

  it('replays the SAME attempt after a crash and recovers its marked drafts', async () => {
    const state = gitlabState()
    const first = harness({
      state,
      // The pass dies at the exact-set check: the draft exists, publication was never permitted.
      script: [
        { method: 'GET', path: /draft_notes$/, reply: { status: 200, body: [] } },
        { method: 'GET', path: /draft_notes$/, reply: { status: 200, body: [] } }
      ]
    })
    // Crash after the draft was created and before publication settled: the durable row keeps
    // the attempt, unclassified, and the marked draft is still pending on the merge request.
    await first.adapter.submit(KEY, request()).catch(() => undefined)
    delete first.hook.codeReview!.state
    expect(state.drafts).toHaveLength(1)
    expect(signer.read(state.drafts[0]!.note, HEAD)).toEqual({ attemptId: ATTEMPT, ordinal: 0 })

    // A NEW adapter over the SAME store and hook row: same attempt id, same verifiable marker.
    const replay = harness({ state, hook: first.hook, reviewStore: first.reviewStore, attemptIds: ['ignored-id'] })
    const outcome = (await replay.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(replay.authorizations[0]!.attemptId).toBe(ATTEMPT)
    // The recovered draft was reused, not created again.
    expect(drafted(replay.calls)).toEqual([])
  })

  it('refuses a recovered attempt that changes its event or verdict', async () => {
    const h = harness()
    h.hook.codeReview = { attemptId: ATTEMPT, event: 'COMMENT', verdict: 'neutral', headSha: HEAD }
    const replay = harness({ hook: h.hook, reviewStore: h.reviewStore })
    await expect(replay.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))).rejects.toThrow(
      /must keep its original event, verdict, and head/
    )
    expect(replay.calls).toEqual([])
  })

  it('replays an unacknowledged settle until the control plane takes it', async () => {
    let refusals = 2
    const h = harness({
      cp: {
        operateFails: () => {
          if (refusals <= 0) return undefined
          refusals -= 1
          return Object.assign(new Error('control plane unreachable'), { retryable: true })
        }
      }
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    // Both settles were refused, so both are owed durably and the resweep is armed.
    expect([...h.reviewStore.rows.keys()].filter((id) => id.includes(':op:'))).toHaveLength(2)
    expect(h.timer.armed()).toBe(1)
    await h.timer.fire()
    // The replayed frames are the identical settles, and the ledger is clear once acked.
    const replayed = h.ops.filter((op) => op.op === 'settle')
    expect(replayed.length).toBeGreaterThanOrEqual(4)
    expect([...h.reviewStore.rows.keys()].filter((id) => id.includes(':op:'))).toEqual([])
  })

  it('replays an unacknowledged result report and clears it once acked', async () => {
    let refuse = true
    const h = harness({
      cp: {
        reportFails: () => {
          const err = refuse ? Object.assign(new Error('control plane unreachable'), { retryable: true }) : undefined
          refuse = false
          return err
        }
      }
    })
    await h.adapter.submit(KEY, request())
    expect([...h.reviewStore.rows.keys()]).toEqual([`${ATTEMPT}:result`])
    expect(h.timer.armed()).toBe(1)
    await h.timer.fire()
    expect(h.reviewStore.rows.size).toBe(0)
    const reports = h.results.filter((row) => row.attemptId === ATTEMPT)
    expect(reports.at(-1)).toMatchObject({ state: 'submitted', provider: 'gitlab' })
  })

  it('drops an owed frame the control plane permanently refuses instead of replaying forever', async () => {
    const h = harness({
      cp: { reportFails: () => Object.assign(new Error('does not own the lease'), { retryable: false }) }
    })
    await h.adapter.submit(KEY, request())
    expect(h.reviewStore.rows.size).toBe(0)
    expect(h.timer.armed()).toBe(0)
  })

  it('recovers owed frames written by a previous process', async () => {
    const store = new FakeReviewStore()
    await store.recordReviewIntent({
      intentId: `${ATTEMPT}:result`,
      daemonId: DAEMON_ID,
      attemptId: ATTEMPT,
      orgId: 'org-1',
      kind: 'result',
      frame: JSON.stringify({
        hookId: HOOK_ID,
        deliveryKey: 'delivery-1',
        attemptId: ATTEMPT,
        snapshot: SNAPSHOT,
        provider: 'gitlab',
        projectId: PROJECT,
        mergeRequestIid: IID,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        state: 'submitted'
      }),
      attempts: 3
    })
    const h = harness({ reviewStore: store, open: false })
    await h.adapter.reconcilePending()
    expect(store.rows.size).toBe(0)
    expect(h.results.at(-1)).toMatchObject({ attemptId: ATTEMPT, state: 'submitted' })
    expect(h.timer.armed()).toBe(0)
  })
})

describe('GitLab review adapter — started-operation recovery (round 3)', () => {
  /** The durable record a crash between the permitted request and its settlement leaves behind. */
  function crashedAttempt(): HookDispatchContext {
    return hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        ordinals: { draft_create: 1 },
        operations: [
          {
            recordId: 'rec-draft_create-0',
            startToken: 'start-0',
            kind: 'draft_create',
            ordinal: 0,
            target: `/projects/${PROJECT}/merge_requests/${IID}/draft_notes`,
            phase: 'started',
            draftOrdinal: 0
          }
        ]
      }
    })
  }

  it('settles the exact started record from provider evidence before creating anything new', async () => {
    const state = gitlabState()
    const draftId = '9007199254746001'
    state.drafts.push({ id: draftId, note: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
    const h = harness({ state, hook: crashedAttempt(), seedStarted: ['rec-draft_create-0'] })

    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    // The recovered record is settled deterministically, naming the draft that proves the effect.
    const settle = h.ops.find((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0') as {
      outcome: { kind: string; externalId?: string }
    }
    expect(settle.outcome).toEqual({ kind: 'deterministic', status: 201, externalId: draftId })
    // ...and it is settled BEFORE the attempt issues another operation.
    const settledAt = h.ops.findIndex((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0')
    const nextIssue = h.ops.findIndex((op) => op.op === 'issue' && op.kind === 'draft_create')
    expect(settledAt).toBeGreaterThanOrEqual(0)
    expect(nextIssue === -1 || settledAt < nextIssue).toBe(true)
    // Nothing is left permitted-but-unsettled on the control plane.
    expect([...h.records.values()].filter((phase) => phase === 'request_started')).toEqual([])
    // The recovered draft is reused rather than created again, and the coordinate is not reused.
    expect(drafted(h.calls)).toEqual([])
    expect(h.hook.codeReview?.operations).toEqual([])
  })

  it('never reuses a spent operation coordinate after a recovery', async () => {
    const state = gitlabState()
    const h = harness({ state, hook: crashedAttempt(), seedStarted: ['rec-draft_create-0'] })
    await h.adapter.submit(KEY, request())
    // Ordinal 0 belongs to the crashed request; the replacement draft takes the next one.
    const issued = h.ops.filter((op) => op.op === 'issue' && op.kind === 'draft_create') as Array<{ ordinal: number }>
    expect(issued.map((op) => op.ordinal)).toEqual([1])
    expect(h.hook.codeReview?.ordinals).toMatchObject({ draft_create: 2 })
  })

  it('proves a started draft create had no effect when no marker exists', async () => {
    const h = harness({ hook: crashedAttempt(), seedStarted: ['rec-draft_create-0'] })
    await h.adapter.submit(KEY, request())
    const settle = h.ops.find((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0') as {
      outcome: { kind: string; code?: string }
    }
    expect(settle.outcome).toMatchObject({ kind: 'deterministic', code: 'draft_absent' })
    // The replacement draft is issued only AFTER the crashed record is accounted for.
    const settledAt = h.ops.findIndex((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0')
    const nextIssue = h.ops.findIndex((op) => op.op === 'issue' && op.kind === 'draft_create')
    expect(nextIssue).toBeGreaterThan(settledAt)
    expect([...h.records.values()].filter((phase) => phase === 'request_started')).toEqual([])
  })

  it('locks instead of republishing when a started bulk publish left no marker', async () => {
    const hook = hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        ordinals: { bulk_publish: 1 },
        operations: [
          {
            recordId: 'rec-bulk_publish-0',
            startToken: 'start-1',
            kind: 'bulk_publish',
            ordinal: 0,
            target: `/projects/${PROJECT}/merge_requests/${IID}/draft_notes/bulk_publish`,
            phase: 'started'
          }
        ]
      }
    })
    const h = harness({ hook, seedStarted: ['rec-bulk_publish-0'] })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(published(h.calls)).toEqual([])
    expect([...h.records.values()].filter((phase) => phase === 'request_started')).toEqual([])
  })

  it('adopts a started bulk publish that DID land, and never publishes a second time', async () => {
    const state = gitlabState()
    state.notes.push({ id: '9007199254746777', body: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
    const hook = hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        ordinals: { bulk_publish: 1 },
        operations: [
          {
            recordId: 'rec-bulk_publish-0',
            startToken: 'start-1',
            kind: 'bulk_publish',
            ordinal: 0,
            target: `/projects/${PROJECT}/merge_requests/${IID}/draft_notes/bulk_publish`,
            phase: 'started'
          }
        ]
      }
    })
    const h = harness({ state, hook, seedStarted: ['rec-bulk_publish-0'] })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    // A recovered publication cannot prove the unchanged-state postcondition.
    expect(outcome.state).toBe('review_state_not_recorded')
    expect(published(h.calls)).toEqual([])
    expect(outcome.externalIds).toEqual([{ kind: 'note', externalId: '9007199254746777' }])
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
  })
})

describe('GitLab review adapter — the durable chain across every crash point (round 4)', () => {
  /** A crash at a chosen point, as the durable hook row records it. */
  function crashedAt(phase: 'issued' | 'started', overrides: Partial<CodeReviewAttempt> = {}): HookDispatchContext {
    return hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        fence: '7',
        ordinals: { draft_create: 1 },
        operations: [
          {
            recordId: 'rec-draft_create-0',
            startToken: 'start-0',
            kind: 'draft_create',
            ordinal: 0,
            target: `/projects/${PROJECT}/merge_requests/${IID}/draft_notes`,
            phase,
            draftOrdinal: 0
          }
        ],
        ...overrides
      }
    })
  }

  it('returns a permit whose start was never acknowledged instead of settling it', async () => {
    const hook = crashedAt('issued')
    const h = harness({ hook, seedStarted: [] })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    // The unstarted permit is handed back, never settled — settling one is refused as `not_started`.
    expect(h.ops.some((op) => op.op === 'return-unused' && op.recordId === 'rec-draft_create-0')).toBe(true)
    expect(h.ops.some((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0')).toBe(false)
    expect(h.hook.codeReview?.operations).toEqual([])
    expect([...h.records.values()].filter((state) => state === 'request_started')).toEqual([])
  })

  it('falls through to marker reconciliation when the start had raced ahead of the local flip', async () => {
    const state = gitlabState()
    const draftId = '9007199254746333'
    state.drafts.push({ id: draftId, note: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
    const h = harness({
      state,
      hook: crashedAt('issued'),
      // The control plane had already started it, so the return is permanently refused.
      cp: { returnUnusedFails: () => Object.assign(new Error('already started'), { retryable: false }) }
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    const settle = h.ops.find((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0') as {
      outcome: { kind: string; externalId?: string }
    }
    expect(settle.outcome).toEqual({ kind: 'deterministic', status: 201, externalId: draftId })
  })

  it('never clears coordinates on a refusal it could not classify', async () => {
    const h = harness({
      hook: crashedAt('issued'),
      // A transport failure decides nothing, so the permit stays exactly where it was.
      cp: { returnUnusedFails: () => Object.assign(new Error('unreachable'), { retryable: true }) }
    })
    await h.adapter.submit(KEY, request())
    expect(h.hook.codeReview?.operations?.map((op) => op.recordId)).toEqual(['rec-draft_create-0'])
  })

  it('keeps a started operation’s coordinates when its settle is neither durable nor acked', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    const h = harness({
      reviewStore: store,
      cp: { operateFails: () => Object.assign(new Error('unreachable'), { retryable: true }) }
    })
    await h.adapter.submit(KEY, request())
    // Nothing durable owes the settle, so the only record that could rebuild it survives.
    expect(store.rows.size).toBe(0)
    expect((h.hook.codeReview?.operations ?? []).length).toBeGreaterThan(0)
    // The result frame WAS acknowledged, so its own upstream marker is released independently.
    expect(h.hook.codeReview?.resultOwed).toBeUndefined()
  })

  it('rebuilds the owed settle and result from the upstream records after the process dies', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    const first = harness({
      reviewStore: store,
      cp: {
        operateFails: () => Object.assign(new Error('unreachable'), { retryable: true }),
        reportFails: () => Object.assign(new Error('unreachable'), { retryable: true })
      }
    })
    await first.adapter.submit(KEY, request())
    expect(store.rows.size).toBe(0)
    const owedOps = (first.hook.codeReview?.operations ?? []).filter((op) => op.phase === 'issued')

    // A NEW adapter over the SAME store and hook row, with a control plane that answers.
    store.failWrites = 0
    const replay = harness({ reviewStore: store, hook: first.hook, open: false })
    const turn = replay.adapter.openTurn(KEY, first.hook, 'acp-session-2', {
      daemonId: DAEMON_ID,
      persist: async () => {}
    })!
    await replay.adapter.recoverTurn(turn)
    // The result frame is rebuilt from the attempt record alone and taken by the control plane.
    expect(replay.results.at(-1)).toMatchObject({ attemptId: ATTEMPT, state: 'submitted', provider: 'gitlab' })
    expect(first.hook.codeReview?.resultOwed).toBeUndefined()
    // The settle is replayed from the outcome parked on its coordinates, which then release.
    expect(replay.ops.some((frame) => frame.op === 'settle')).toBe(true)
    expect(first.hook.codeReview?.operations).toEqual([])
    expect(owedOps).toEqual([])
    expect(store.rows.size).toBe(0)
  })

  it('hands back an unstarted permit from its coordinates alone, with no turn replay', async () => {
    const hook = crashedAt('issued', { state: 'not_submitted', resultOwed: true })
    const h = harness({ hook, open: false })
    const turn = h.adapter.openTurn(KEY, hook, 'acp-session-2', { daemonId: DAEMON_ID, persist: async () => {} })!
    await h.adapter.recoverTurn(turn)
    expect(h.ops.some((op) => op.op === 'return-unused' && op.recordId === 'rec-draft_create-0')).toBe(true)
    expect(hook.codeReview?.operations).toEqual([])
    // ...and the classified-but-unreported result goes with it.
    expect(h.results.at(-1)).toMatchObject({ attemptId: ATTEMPT, state: 'not_submitted' })
    expect(hook.codeReview?.resultOwed).toBeUndefined()
  })
})

describe('GitLab review adapter — a terminal result waits for a replayable settle (round 5)', () => {
  /** A control plane that refuses settles but takes everything else. */
  const settlesRefused = { operateFails: () => Object.assign(new Error('unreachable'), { retryable: true }) }

  it('parks the exact settle outcome on the coordinates when its frame cannot be made durable', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    const h = harness({ reviewStore: store, cp: settlesRefused })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    // The result still lands, because the settle now HAS a durable replay source.
    expect(outcome.state).toBe('submitted')
    const parked = h.hook.codeReview?.operations ?? []
    expect(parked.length).toBeGreaterThan(0)
    expect(parked.every((op) => op.phase === 'started' && op.outcome !== undefined)).toBe(true)
    expect(parked.find((op) => op.kind === 'draft_create')?.outcome).toMatchObject({
      kind: 'deterministic',
      status: 201
    })
  })

  it('replays the parked settle after the process dies, and the lease releases', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    const first = harness({ reviewStore: store, cp: settlesRefused })
    await first.adapter.submit(KEY, request())
    expect(store.rows.size).toBe(0)

    // A NEW adapter over the SAME store and hook row, with a control plane that answers.
    store.failWrites = 0
    const replay = harness({ reviewStore: store, hook: first.hook, open: false })
    const turn = replay.adapter.openTurn(KEY, first.hook, 'acp-session-2', {
      daemonId: DAEMON_ID,
      persist: async () => {}
    })!
    await replay.adapter.recoverTurn(turn)
    // Every started record reaches `settled`, so nothing keeps the publication lease.
    expect(replay.ops.filter((op) => op.op === 'settle').length).toBeGreaterThan(0)
    expect([...replay.records.values()].filter((state) => state === 'request_started')).toEqual([])
    expect(first.hook.codeReview?.operations).toEqual([])
    expect(store.rows.size).toBe(0)
  })

  it('withholds the terminal result when even the parked outcome cannot be written', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    let allowPersist = true
    const h = harness({
      reviewStore: store,
      // The hook row stops accepting writes exactly when the first settle is refused, so
      // the parking write fails too and the settle has NO replay source at all.
      cp: {
        operateFails: (op) => {
          if (!('recordId' in op) || !op.recordId.includes('bulk_publish')) return undefined
          allowPersist = false
          return Object.assign(new Error('unreachable'), { retryable: true })
        }
      },
      persistFails: () => !allowPersist
    })
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/could not be made durable/)
    // No result reached the control plane, and the attempt stays pre-terminal.
    expect(h.results).toEqual([])
    expect(h.hook.codeReview?.state).toBeUndefined()
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
    // The turn stays open and the retry is armed.
    expect(h.timer.armed()).toBe(1)
    expect(h.adapter.owns(KEY, AGENT_ID)).toBe(true)
  })

  it('completes both halves on a later pass once the store recovers', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    let allowPersist = true
    let refuseSettles = true
    const h = harness({
      reviewStore: store,
      cp: {
        operateFails: (op) => {
          if (!refuseSettles || !('recordId' in op) || !op.recordId.includes('bulk_publish')) return undefined
          allowPersist = false
          return Object.assign(new Error('unreachable'), { retryable: true })
        }
      },
      persistFails: () => !allowPersist
    })
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/could not be made durable/)
    expect(h.results).toEqual([])

    // The turn stayed open, so the SAME attempt runs again once the store and control plane recover.
    allowPersist = true
    refuseSettles = false
    store.failWrites = 0
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    // The publication already landed, so the replay classifies it rather than repeating it.
    expect(outcome.state).toBe('review_state_not_recorded')
    expect(h.results.at(-1)).toMatchObject({ attemptId: ATTEMPT, state: 'review_state_not_recorded' })
    expect(published(h.calls)).toHaveLength(1)
    expect([...h.records.values()].filter((state) => state === 'request_started')).toEqual([])
  })

  it('leaves a started operation without a parked outcome on the marker-reconciliation path', async () => {
    const state = gitlabState()
    const draftId = '9007199254746555'
    state.drafts.push({ id: draftId, note: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
    const hook = hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        fence: '7',
        ordinals: { draft_create: 1 },
        operations: [
          {
            recordId: 'rec-draft_create-0',
            startToken: 'start-0',
            kind: 'draft_create',
            ordinal: 0,
            target: `/projects/${PROJECT}/merge_requests/${IID}/draft_notes`,
            phase: 'started',
            draftOrdinal: 0
          }
        ]
      }
    })
    const h = harness({ state, hook, open: false })
    const turn = h.adapter.openTurn(KEY, hook, 'acp-session-2', { daemonId: DAEMON_ID, persist: async () => {} })!
    // Recovery without evidence cannot classify it, so it is left for the turn's own replay.
    await h.adapter.recoverTurn(turn)
    expect(h.ops).toEqual([])
    expect(hook.codeReview?.operations).toHaveLength(1)
    // The turn replay then settles it from the marker, as before.
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    const settle = h.ops.find((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0') as {
      outcome: { externalId?: string }
    }
    expect(settle.outcome.externalId).toBe(draftId)
  })
})

describe('GitLab review adapter — an identified ambiguous mutation upgrades its record (round 6)', () => {
  /** §15.1: the lease may only be released once no record is still ambiguous. */
  const releasable = (records: Harness['records']) => ![...records.values()].includes('ambiguous')

  it('upgrades an ambiguous draft create once its signed marker identifies the draft', async () => {
    const state = gitlabState()
    let created: string | undefined
    const h = harness({
      state,
      script: [
        {
          method: 'POST',
          path: /draft_notes$/,
          reply: 'network',
          // The request DID land; only its response was lost.
          then: () => {
            created = String(state.nextId++)
            state.drafts.push({ id: created, note: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
          }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    // The ambiguous settle is followed by the deterministic upgrade that names the draft.
    const settles = h.ops.filter((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0') as Array<{
      outcome: { kind: string; externalId?: string }
    }>
    expect(settles.map((op) => op.outcome.kind)).toEqual(['ambiguous', 'deterministic'])
    expect(settles.at(-1)!.outcome.externalId).toBe(created)
    // ...so nothing is left ambiguous and the publication lease can be released.
    expect(h.records.get('rec-draft_create-0')).toBe('settled')
    expect(releasable(h.records)).toBe(true)
  })

  it('upgrades an ambiguous draft delete once the read-after proves the absence', async () => {
    const state = gitlabState()
    const stale = seedDraft(state, OLD_ATTEMPT, 0, HEAD, '9007199254746901')
    const h = harness({
      state,
      script: [
        {
          method: 'DELETE',
          path: /draft_notes\//,
          reply: 'network',
          // The delete landed; the response did not.
          then: () => void (state.drafts = state.drafts.filter((draft) => draft.id !== stale))
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    const settles = h.ops.filter((op) => op.op === 'settle' && op.recordId === 'rec-draft_delete-0') as Array<{
      outcome: { kind: string; externalId?: string; status?: number }
    }>
    expect(settles.map((op) => op.outcome.kind)).toEqual(['ambiguous', 'deterministic'])
    expect(settles.at(-1)!.outcome).toMatchObject({ status: 204, externalId: stale })
    expect(h.records.get('rec-draft_delete-0')).toBe('settled')
    expect(releasable(h.records)).toBe(true)
  })

  it('keeps the record ambiguous — and the lease unreleasable — when nothing identifies it', async () => {
    // The control: an ambiguous create whose marker never appears is exactly the state the
    // upgrade exists to leave behind, and the lease is retained until it is resolved.
    const h = harness({ script: [{ method: 'POST', path: /draft_notes$/, reply: 'network' }] })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
    expect(h.records.get('rec-draft_create-0')).toBe('ambiguous')
    expect(releasable(h.records)).toBe(false)
  })

  it('routes the upgrade through the durable chain, so an unsafe one is parked and replayed', async () => {
    const state = gitlabState()
    const store = new FakeReviewStore()
    let created: string | undefined
    let refuseUpgrade = true
    const h = harness({
      state,
      reviewStore: store,
      script: [
        {
          method: 'POST',
          path: /draft_notes$/,
          reply: 'network',
          then: () => {
            created = String(state.nextId++)
            state.drafts.push({ id: created, note: `summary\n\n${signer.mint(ATTEMPT, 0, HEAD)}` })
          }
        }
      ],
      cp: {
        // Local writes stop the moment the ambiguous settle lands, so the upgrade that follows
        // is neither durable nor acknowledged and must fall back to its parked coordinates.
        operateFails: (op) => {
          if (!('outcome' in op)) return undefined
          if (op.outcome.kind === 'ambiguous') {
            store.failWrites = Number.POSITIVE_INFINITY
            return undefined
          }
          return refuseUpgrade ? Object.assign(new Error('unreachable'), { retryable: true }) : undefined
        }
      }
    })
    await h.adapter.submit(KEY, request())
    // The upgrade is parked on the coordinates the ambiguous settle deliberately retained.
    const parked = (h.hook.codeReview?.operations ?? []).find((op) => op.recordId === 'rec-draft_create-0')
    expect(parked?.outcome).toMatchObject({ kind: 'deterministic', externalId: created })

    // A restart replays it from there, and the record finally leaves `ambiguous`.
    refuseUpgrade = false
    store.failWrites = 0
    const replay = harness({ reviewStore: store, hook: h.hook, open: false })
    const turn = replay.adapter.openTurn(KEY, h.hook, 'acp-session-2', {
      daemonId: DAEMON_ID,
      persist: async () => {}
    })!
    await replay.adapter.recoverTurn(turn)
    const upgraded = replay.ops.find((op) => op.op === 'settle' && op.recordId === 'rec-draft_create-0') as {
      outcome: { externalId?: string }
    }
    expect(upgraded.outcome.externalId).toBe(created)
    expect(h.hook.codeReview?.operations).toEqual([])
  })
})

describe('GitLab review adapter — owed frames are never dropped (round 3)', () => {
  it('absorbs a transient local write failure and still delivers the frame', async () => {
    const store = new FakeReviewStore()
    store.failWrites = 1
    const h = harness({ reviewStore: store })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(store.rows.size).toBe(0)
    expect(h.results.at(-1)).toMatchObject({ state: 'submitted' })
  })

  it('replays a frame whose durable write never landed, from memory, on the resweep', async () => {
    const store = new FakeReviewStore()
    store.failWrites = Number.POSITIVE_INFINITY
    let refuse = true
    const h = harness({
      reviewStore: store,
      cp: {
        reportFails: () => {
          const err = refuse ? Object.assign(new Error('control plane unreachable'), { retryable: true }) : undefined
          refuse = false
          return err
        }
      }
    })
    await h.adapter.submit(KEY, request())
    // Nothing reached the store, so only the in-memory copy can save the frame.
    expect(store.rows.size).toBe(0)
    expect(h.timer.armed()).toBe(1)
    store.failWrites = 0
    await h.timer.fire()
    expect(h.results.filter((row) => row.attemptId === ATTEMPT)).toHaveLength(2)
    expect(store.rows.size).toBe(0)
    expect(h.timer.armed()).toBe(0)
  })

  it('stays armed when a sweep hits its page cap with rows still unseen', async () => {
    const store = new FakeReviewStore()
    // Two rows per page against a 50-page cap leaves the 101st row unseen.
    store.pageSize = 2
    for (let index = 0; index < 101; index += 1) {
      await store.recordReviewIntent({
        intentId: `capped-${index}`,
        daemonId: DAEMON_ID,
        attemptId: ATTEMPT,
        kind: 'result',
        frame: JSON.stringify({
          hookId: HOOK_ID,
          deliveryKey: 'delivery-1',
          attemptId: ATTEMPT,
          snapshot: SNAPSHOT,
          provider: 'gitlab',
          projectId: PROJECT,
          mergeRequestIid: IID,
          event: 'COMMENT',
          verdict: 'neutral',
          headSha: HEAD,
          state: 'submitted'
        }),
        attempts: 0
      })
    }
    const h = harness({ reviewStore: store, open: false })
    await h.adapter.reconcilePending()
    // The cap proves nothing about what is left, so the scheduler keeps the chain alive.
    expect(store.rows.size).toBeGreaterThan(0)
    expect(h.timer.armed()).toBe(1)
  })

  it('drains every page of owed frames before it goes quiet', async () => {
    const store = new FakeReviewStore()
    for (let index = 0; index < 101; index += 1) {
      await store.recordReviewIntent({
        intentId: `owed-${index}`,
        daemonId: DAEMON_ID,
        attemptId: ATTEMPT,
        orgId: 'org-1',
        kind: 'result',
        frame: JSON.stringify({
          hookId: HOOK_ID,
          deliveryKey: 'delivery-1',
          attemptId: ATTEMPT,
          snapshot: SNAPSHOT,
          provider: 'gitlab',
          projectId: PROJECT,
          mergeRequestIid: IID,
          event: 'COMMENT',
          verdict: 'neutral',
          headSha: HEAD,
          state: 'submitted'
        }),
        attempts: 0
      })
    }
    const h = harness({ reviewStore: store, open: false })
    await h.adapter.reconcilePending()
    // The store answers 100 at a time; a page of acked rows is not an empty store.
    expect(store.rows.size).toBe(0)
    expect(h.results).toHaveLength(101)
    expect(h.timer.armed()).toBe(0)
  })
})

describe('GitLab review durability in the real daemon store', () => {
  let root: string
  let store: LocalStore

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gitlab-review-store-'))
    store = await LocalStore.open(join(root, 'state.db'))
  })

  afterEach(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('mints the marker key once and returns the same value to every later caller', async () => {
    const first = await store.getOrCreateDaemonSecret('gitlab-review-marker-key', () => 'first', 1)
    const second = await store.getOrCreateDaemonSecret('gitlab-review-marker-key', () => 'second', 2)
    expect(second).toBe(first)
    // A restart over the same file reads the stored key rather than minting a new one.
    await store.close()
    const reopened = await LocalStore.open(join(root, 'state.db'))
    expect(await reopened.getOrCreateDaemonSecret('gitlab-review-marker-key', () => 'third', 3)).toBe(first)
    store = reopened
  })

  it('keeps owed frames per daemon identity, upserts by intent, and clears on ack', async () => {
    const row: ReviewIntentRow = {
      intentId: `${ATTEMPT}:result`,
      daemonId: DAEMON_ID,
      attemptId: ATTEMPT,
      orgId: 'org-1',
      kind: 'result',
      frame: '{"state":"submitted"}',
      attempts: 0
    }
    await store.recordReviewIntent(row, 1)
    await store.recordReviewIntent({ ...row, attempts: 4, frame: '{"state":"ambiguous_locked"}' }, 2)
    await store.recordReviewIntent({ ...row, intentId: 'other', daemonId: 'peer-daemon' }, 3)

    const mine = await store.listReviewIntents(DAEMON_ID)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ attempts: 4, frame: '{"state":"ambiguous_locked"}', orgId: 'org-1' })
    // A peer's owed frame is never replayed by this identity.
    expect(await store.listReviewIntents('peer-daemon')).toHaveLength(1)

    await store.clearReviewIntent(row.intentId)
    expect(await store.listReviewIntents(DAEMON_ID)).toEqual([])
  })
})

describe('GitLab review adapter — credentials and features', () => {
  it('refreshes the effect lease exactly once after a definite 401 and retries under a new record', async () => {
    const h = harness({
      tokens: ['glpat-stale', 'glpat-fresh'],
      script: [{ method: 'POST', path: /draft_notes$/, reply: { status: 401, body: { message: 'unauthorized' } } }]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(h.invalidated()).toEqual(['glpat-stale'])
    const creates = drafted(h.calls)
    expect(creates).toHaveLength(2)
    expect(creates[0]!.token).toBe('glpat-stale')
    expect(creates[1]!.token).toBe('glpat-fresh')
    // One record permits one request, so the retry took the next ordinal.
    const issued = h.ops.filter((op) => op.op === 'issue' && op.kind === 'draft_create')
    expect(issued.map((op) => (op as { ordinal: number }).ordinal)).toEqual([0, 1])
  })

  it('routes a code review to the adapter that owns the active turn', async () => {
    const h = harness()
    const router = new CodeHostReviewRouter()
    const github = { provider: 'github' as const, owns: () => false, submit: vi.fn() }
    router.register(github)
    router.register(h.adapter)
    const outcome = (await router.submit(request())) as GitlabReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(github.submit).not.toHaveBeenCalled()
    await expect(router.submit(request({ channel: 'nowhere' }))).rejects.toThrow(/active pull\/merge request hook turn/)
  })

  it('advertises codehost-review-v1 in the daemon registration features', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-review-feature-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: {} })
    )
    mkdirSync(join(root, 'agents'), { recursive: true })
    const daemon = new Daemon({
      root,
      hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
    })
    await daemon.start()
    try {
      const features = (daemon as unknown as { registrationFeatures(): string[] }).registrationFeatures()
      expect(features).toContain(CODEHOST_REVIEW_V1_FEATURE)
    } finally {
      await daemon.stop().catch(() => {})
    }
  }, 20_000)
})
