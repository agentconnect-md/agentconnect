// Gitea formal review adapter (§10.3): shared-bot lease, reconcile-before-submit, marker-first recovery, the lock's one exit, self-review downgrade.
import { describe, expect, it } from 'vitest'
import {
  codeHostReviewPublicEffect,
  type CodeHostReviewAuthorize,
  type CodeHostReviewAuthorized,
  type CodeHostReviewLeasePhase,
  type CodeHostReviewOpAccepted,
  type CodeHostReviewOpRequest,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewResultReport,
  type CodeHostReviewState,
  type HookConfigSnapshot
} from '@agentconnect.md/protocol'
import { sessionKey } from '../src/store/local-store.js'
import { CodeHostReviewRouter, type SubmitCodeReviewReq } from '../src/codehost/review-adapter.js'
import { codeHostReviewFallbackAllowed, type HookDispatchContext } from '../src/github/hook-coords.js'
import { GiteaReviewAdapter, type GiteaReviewOutcome } from '../src/gitea/review-adapter.js'
import { ReviewMarkerSigner } from '../src/codehost/review-marker.js'
import type { CodeHostReviewControlPlane, ReviewIntentRow } from '../src/codehost/review-outbox.js'

const BASE = 'https://gitea.example.test/api/v1'
const REPO = '556677'
const PATH = 'example-org/example-repo'
const INDEX = 12
const HEAD = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const OTHER_HEAD = 'c'.repeat(40)
// Deliberately past 2^53 so every id path stays a decimal string end to end.
const BOT_USER = '9007199254740993'
const HUMAN_USER = '9007199254740999'
const ATTEMPT = '11111111-1111-4111-8111-111111111111'
const OLD_ATTEMPT = '22222222-2222-4222-8222-222222222222'
const SECOND_ATTEMPT = '55555555-5555-4555-8555-555555555555'
const THIRD_ATTEMPT = '66666666-6666-4666-8666-666666666666'
const HOOK_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_HOOK_ID = '77777777-7777-4777-8777-777777777777'
const DAEMON_ID = '44444444-4444-4444-8444-444444444444'
const AGENT_ID = 'bot-a'
const OTHER_AGENT_ID = 'bot-b'
const THREAD = `gitea:${REPO}:pull:${INDEX}`
const KEY = sessionKey('hook', HOOK_ID, THREAD, AGENT_ID)
const MARKER_SEED = 'gitea-review-marker-test-key-001'
const PULL_PATH = `/repos/example-org/example-repo/pulls/${INDEX}`

const OTHER_DAEMON_SEED = 'gitea-review-marker-test-key-002'

// The adapter keys markers per attempt off the daemon key, so fixtures mint the same way.
const signer = ReviewMarkerSigner.derived(Buffer.from(MARKER_SEED, 'utf8'))

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
    firedAt: '2026-09-12T00:00:00.000Z',
    event: 'merge_request:opened',
    snapshot: SNAPSHOT,
    gitea: { repoId: REPO, repoPath: PATH, target: { kind: 'pull', index: INDEX, headSha: HEAD, baseSha: BASE_SHA } },
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

interface FakeComment {
  id: string
  path: string
  body: string
  position?: number
  original_position?: number
}

interface FakeReview {
  id: string
  user: { id: string }
  state: 'PENDING' | 'COMMENT' | 'APPROVED' | 'REQUEST_CHANGES' | 'REQUEST_REVIEW'
  body: string
  commit_id: string
  comments: FakeComment[]
}

interface GiteaState {
  botUserId: string
  headSha: string
  /** The pull request's author; the bot authoring it is the §10.3 internal-CI lane. */
  authorId: string
  reviews: FakeReview[]
  nextId: bigint
}

function giteaState(overrides: Partial<GiteaState> = {}): GiteaState {
  return {
    botUserId: BOT_USER,
    headSha: HEAD,
    authorId: HUMAN_USER,
    reviews: [],
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

type Reply = 'network' | { status: number; body?: unknown } | 'defer'

interface ScriptEntry {
  method: string
  path: RegExp
  reply: Reply
  /** Provider-side effect this scripted reply also had (the request landed even though the reply was lost). */
  then?: () => void
  used?: boolean
}

/** Ids are written as strings here and emitted UNQUOTED, so every response exercises the big-int-safe re-quoting. */
function json(value: unknown, status = 200): Response {
  const text = JSON.stringify(value).replace(/"((?:[a-z][a-z0-9_]*_)?id)":"(\d{15,})"/g, '"$1":$2')
  return new Response(text, { status, headers: { 'content-type': 'application/json' } })
}

const SELF_REVIEW: Record<string, string> = {
  APPROVED: 'approve your own pull is not allowed',
  REQUEST_CHANGES: 'reject your own pull is not allowed'
}

/** Fake Gitea (§16): POST stages then submits the caller's one pending review; the list is unfiltered; DELETE removes submitted reviews; own verdicts 422. */
function fakeGitea(state: GiteaState, script: ScriptEntry[] = []) {
  const calls: Call[] = []
  const deferred: Array<() => void> = []
  const nextId = () => {
    const id = state.nextId
    state.nextId += 1n
    return String(id)
  }
  const reviewJson = (review: FakeReview) => ({
    id: review.id,
    user: { id: review.user.id, login: review.user.id === state.botUserId ? 'example-bot' : 'alice' },
    state: review.state,
    body: review.body,
    commit_id: review.commit_id,
    comments_count: review.comments.length
  })
  /** The staging-then-submit the probe recorded (§16). */
  const submit = (body: Record<string, unknown>): FakeReview => {
    const event = String(body.event ?? 'PENDING')
    let pending = state.reviews.find((review) => review.user.id === state.botUserId && review.state === 'PENDING')
    const comments = Array.isArray(body.comments) ? (body.comments as Record<string, unknown>[]) : []
    if (!pending && (comments.length > 0 || event !== 'PENDING')) {
      pending = {
        id: nextId(),
        user: { id: state.botUserId },
        state: 'PENDING',
        body: '',
        commit_id: String(body.commit_id ?? state.headSha),
        comments: []
      }
      state.reviews.push(pending)
    }
    for (const comment of comments) {
      pending!.comments.push({
        id: nextId(),
        path: String(comment.path),
        body: String(comment.body),
        ...(typeof comment.new_position === 'number' ? { position: comment.new_position } : {}),
        ...(typeof comment.old_position === 'number' ? { original_position: comment.old_position } : {})
      })
    }
    if (event !== 'PENDING') {
      pending!.state = event as FakeReview['state']
      pending!.body = String(body.body ?? '')
      pending!.commit_id = String(body.commit_id ?? state.headSha)
    }
    return pending!
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({
      method,
      path,
      query: parsed.search,
      token: (headers.authorization ?? '').replace(/^token /, ''),
      ...(body === undefined ? {} : { body })
    })
    const hit = script.find((entry) => !entry.used && entry.method === method && entry.path.test(path))
    if (hit) {
      hit.used = true
      hit.then?.()
      if (hit.reply === 'defer') await new Promise<void>((resolve) => deferred.push(resolve))
      else if (hit.reply === 'network') throw new Error('socket hang up')
      else {
        return new Response(hit.reply.body === undefined ? null : JSON.stringify(hit.reply.body), {
          status: hit.reply.status,
          ...(hit.reply.body === undefined ? {} : { headers: { 'content-type': 'application/json' } })
        })
      }
    }
    if (path === '/user') return json({ id: state.botUserId, login: 'example-bot' })
    if (path === PULL_PATH) {
      return json({
        id: '9007199254740995',
        number: INDEX,
        state: 'open',
        head: { sha: state.headSha, ref: 'feature', repo_id: Number(REPO) },
        base: { sha: BASE_SHA, ref: 'main' },
        user: { id: state.authorId }
      })
    }
    if (path === `${PULL_PATH}/reviews`) {
      if (method === 'GET') return json(state.reviews.map(reviewJson))
      const event = String(body?.event ?? '')
      if (SELF_REVIEW[event] && state.authorId === state.botUserId) {
        return json({ message: SELF_REVIEW[event] }, 422)
      }
      return json(reviewJson(submit(body ?? {})))
    }
    const one = new RegExp(`^${PULL_PATH}/reviews/(\\d+)(/comments)?$`).exec(path)
    if (one) {
      const review = state.reviews.find((candidate) => candidate.id === one[1])
      if (!review) return json({ message: 'review does not exist' }, 404)
      if (one[2]) return json(review.comments)
      if (method === 'DELETE') {
        // Upstream authorizes only the author or an admin and imposes NO pending-only restriction (§16).
        state.reviews = state.reviews.filter((candidate) => candidate.id !== review.id)
        return new Response(null, { status: 204 })
      }
      return json(reviewJson(review))
    }
    return json({ message: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, calls, release: () => deferred.splice(0).forEach((resolve) => resolve()) }
}

interface LeaseRow {
  attemptId: string | null
  fence: number
  phase: CodeHostReviewLeasePhase
  leaseUntil: number
  event?: string
  verdict?: string
  headSha?: string
  markerSeed?: string
}

interface OpRow {
  attemptId: string
  fence: string
  kind: string
  ordinal: number
  state: 'issued' | 'request_started' | 'settled' | 'ambiguous' | 'unused'
  everAmbiguous: boolean
  externalId?: string
}

interface CpOptions {
  refuse?: CodeHostReviewRefusalReason
  supports?: boolean
  renewPhase?: CodeHostReviewLeasePhase
  serviceAccountUserId?: string
  /** Operation records a previous incarnation left permitted but unsettled, owned by the seeded lease. */
  seedStarted?: { attemptId: string; recordId: string; kind: string; ordinal: number; fence?: number }[]
  operateFails?: (op: CodeHostReviewOpRequest) => Error | undefined
  reportFails?: (result: CodeHostReviewResultReport) => Error | undefined
  now?: () => number
}

const reconciles = (state: CodeHostReviewState) => codeHostReviewPublicEffect(state) !== 'unknown'

/** The permit key the real ledger uses: attempt, fence, kind, ordinal. */
const recordIdOf = (attemptId: string, fence: string | number, kind: string, ordinal: number) =>
  `rec-${attemptId.slice(0, 8)}-${fence}-${kind}-${ordinal}`

function permanent(message: string): Error {
  return Object.assign(new Error(message), { retryable: false })
}

/** Fake control plane (§15.1): one lease per subject, idempotent re-acquisition, the indefinite lock, the single-use ledger, the owner's one lock exit. */
function fakeCp(opts: CpOptions = {}) {
  const now = opts.now ?? (() => 1_000)
  const leases = new Map<string, LeaseRow>()
  const records = new Map<string, OpRow>()
  const outcomes = new Map<string, CodeHostReviewState>()
  const authorizations: CodeHostReviewAuthorize[] = []
  const ops: CodeHostReviewOpRequest[] = []
  const results: CodeHostReviewResultReport[] = []
  for (const seed of opts.seedStarted ?? []) {
    records.set(seed.recordId, {
      attemptId: seed.attemptId,
      fence: String(seed.fence ?? 7),
      kind: seed.kind,
      ordinal: seed.ordinal,
      state: 'request_started',
      everAmbiguous: false
    })
  }
  const subjectOf = (projectId: string, iid: number) => `${projectId}#${iid}`
  const leaseOf = (attemptId: string): [string, LeaseRow] | undefined => {
    for (const entry of leases) if (entry[1].attemptId === attemptId) return entry
    return undefined
  }
  const ledger = (attemptId: string) => [...records.values()].filter((row) => row.attemptId === attemptId)
  const release = (lease: LeaseRow): CodeHostReviewLeasePhase => {
    if (!lease.attemptId) return lease.phase
    const outcome = outcomes.get(lease.attemptId)
    if (!outcome) return lease.phase
    const rows = ledger(lease.attemptId)
    if (rows.some((row) => row.state === 'issued' || row.state === 'request_started')) {
      lease.phase = 'classifying'
    } else if (rows.some((row) => row.state === 'ambiguous') || !reconciles(outcome)) {
      lease.phase = 'ambiguous_locked'
    } else {
      lease.phase = 'settled'
      lease.attemptId = null
    }
    return lease.phase
  }
  // The lock's durable coordinates: the owner, its fence, the retained ambiguous record, the head, and the seed the owner left.
  const retainedOf = (lease: LeaseRow) =>
    [...records.entries()].find(([, row]) => row.attemptId === lease.attemptId && row.state === 'ambiguous')
  const lockOf = (lease: LeaseRow): Pick<Extract<CodeHostReviewAuthorized, { authorized: false }>, 'lock'> => {
    const retained = retainedOf(lease)
    if (!lease.attemptId || !lease.headSha || !lease.markerSeed || !retained) return {}
    return {
      lock: {
        attemptId: lease.attemptId,
        fence: String(lease.fence),
        recordId: retained[0],
        headSha: lease.headSha,
        markerSeed: lease.markerSeed
      }
    }
  }
  const locked = (attemptId: string, lease: LeaseRow): CodeHostReviewAuthorized => ({
    authorized: false,
    attemptId,
    reason: 'ambiguous_locked',
    retryable: false,
    ...lockOf(lease)
  })
  const cp: CodeHostReviewControlPlane = {
    supportsReview: () => opts.supports !== false,
    authorize: async (payload): Promise<CodeHostReviewAuthorized> => {
      authorizations.push(payload)
      if (opts.refuse) return { authorized: false, attemptId: payload.attemptId, reason: opts.refuse, retryable: false }
      const key = subjectOf(payload.projectId, payload.mergeRequestIid)
      let lease = leases.get(key)
      // The lock's one exit: the refused daemon names the retained record's object; the owner's effect is recorded and the lease releases.
      const unlock = payload.unlock
      if (unlock && lease?.phase === 'ambiguous_locked' && lease.attemptId === unlock.attemptId) {
        const retained = records.get(unlock.recordId)
        if (
          String(lease.fence) === unlock.fence &&
          retained?.attemptId === lease.attemptId &&
          retained.state === 'ambiguous'
        ) {
          retained.state = 'settled'
          retained.externalId = unlock.externalRef.externalId
          outcomes.set(lease.attemptId, 'submitted')
          release(lease)
        }
      }
      if (lease?.phase === 'ambiguous_locked') return locked(payload.attemptId, lease)
      if (lease && lease.attemptId !== null && lease.attemptId !== payload.attemptId && lease.phase !== 'settled') {
        if (lease.leaseUntil > now()) {
          return { authorized: false, attemptId: payload.attemptId, reason: 'lease_held', retryable: true }
        }
        // An expired lease transfers only under the §15.1 conditions; an outstanding record locks it.
        if (ledger(lease.attemptId).some((row) => row.state !== 'settled' && row.state !== 'unused')) {
          lease.phase = 'ambiguous_locked'
          return locked(payload.attemptId, lease)
        }
      }
      if (!lease || lease.attemptId !== payload.attemptId) {
        lease = {
          attemptId: payload.attemptId,
          fence: (lease?.fence ?? 6) + 1,
          phase: 'open',
          leaseUntil: now() + 300_000,
          event: payload.requestedEvent,
          verdict: payload.requestedVerdict,
          headSha: payload.headSha,
          ...(payload.markerSeed ? { markerSeed: payload.markerSeed } : {})
        }
        leases.set(key, lease)
      } else {
        lease.leaseUntil = now() + 300_000
      }
      return {
        authorized: true,
        attemptId: payload.attemptId,
        provider: 'gitea',
        projectId: payload.projectId,
        mergeRequestIid: payload.mergeRequestIid,
        expectedHeadSha: payload.headSha,
        lease: {
          attemptId: payload.attemptId,
          fence: String(lease.fence),
          leaseUntil: '2026-09-12T00:05:00.000Z',
          serviceAccountUserId: opts.serviceAccountUserId ?? BOT_USER
        }
      }
    },
    operate: async (payload): Promise<CodeHostReviewOpAccepted> => {
      ops.push(payload)
      const failure = opts.operateFails?.(payload)
      if (failure) throw failure
      const owner = leaseOf(payload.attemptId)?.[1]
      const recordId =
        payload.op === 'issue'
          ? recordIdOf(payload.attemptId, payload.fence, payload.kind, payload.ordinal)
          : payload.recordId
      const existing = records.get(recordId)
      // A terminal record answers from itself, even once its lease has moved on (record-first replay).
      if (payload.op === 'settle' && existing && existing.state === 'settled') {
        return accepted(payload.op, recordId, existing, owner?.phase ?? 'settled')
      }
      if (!owner || String(owner.fence) !== payload.fence)
        throw permanent('this daemon does not own that operation record')
      if (owner.phase === 'settled') throw permanent('the publication lease is no longer open')
      // The lock's one exit: the owner naming the object its ambiguous record left behind.
      const identifies =
        payload.op === 'settle' &&
        payload.outcome.kind === 'deterministic' &&
        payload.outcome.externalId !== undefined &&
        existing?.state === 'ambiguous'
      if (owner.phase === 'ambiguous_locked' && !identifies) throw permanent('the publication lease is no longer open')
      if (payload.op === 'issue') {
        if (existing && existing.state !== 'issued')
          throw permanent('an operation record already exists for those coordinates')
        const row: OpRow = {
          attemptId: payload.attemptId,
          fence: payload.fence,
          kind: payload.kind,
          ordinal: payload.ordinal,
          state: 'issued',
          everAmbiguous: false
        }
        records.set(recordId, row)
        if (payload.kind === 'bulk_publish' && owner.phase === 'open') owner.phase = 'publishing'
        return accepted(payload.op, recordId, row, owner.phase)
      }
      if (!existing) throw permanent('no such record')
      if (payload.op === 'start') {
        if (existing.state !== 'issued' && existing.state !== 'request_started') throw permanent('record is terminal')
        existing.state = 'request_started'
      } else if (payload.op === 'return-unused') {
        if (existing.state !== 'issued' && existing.state !== 'unused') throw permanent('record already started')
        existing.state = 'unused'
      } else if (payload.op === 'settle') {
        if (existing.state === 'issued') throw permanent('record not started')
        if (payload.outcome.kind === 'ambiguous') {
          existing.state = 'ambiguous'
          existing.everAmbiguous = true
        } else if (existing.state === 'ambiguous' && !payload.outcome.externalId) {
          throw permanent('an ambiguous record settles only by naming its object')
        } else {
          existing.state = 'settled'
          if (payload.outcome.externalId) existing.externalId = payload.outcome.externalId
        }
        if (existing.kind === 'bulk_publish' && owner.phase === 'publishing') owner.phase = 'classifying'
      }
      return accepted(payload.op, recordId, existing, release(owner))
    },
    renew: async ({ attemptId, fence }) => {
      const owner = leaseOf(attemptId)?.[1]
      if (!owner || String(owner.fence) !== fence) throw permanent('this attempt does not own the publication lease')
      return {
        attemptId,
        fence,
        leaseUntil: '2026-09-12T00:10:00.000Z',
        phase: opts.renewPhase ?? owner.phase
      }
    },
    report: async (payload) => {
      results.push(payload)
      const failure = opts.reportFails?.(payload)
      if (failure) throw failure
      const owner = leaseOf(payload.attemptId)?.[1]
      const existing = outcomes.get(payload.attemptId)
      if (!owner) {
        if (existing === payload.state)
          return { accepted: true, phase: reconciles(payload.state) ? 'settled' : 'ambiguous_locked' }
        throw permanent('this attempt does not own the publication lease')
      }
      if (owner.event !== payload.event || owner.verdict !== payload.verdict || owner.headSha !== payload.headSha) {
        throw permanent('review result does not match the reserved attempt')
      }
      // A recorded outcome moves only from a non-reconciling state to a reconciling one (the lock's exit).
      if (existing && existing !== payload.state && !(!reconciles(existing) && reconciles(payload.state))) {
        throw permanent('review result does not match the reserved attempt')
      }
      outcomes.set(payload.attemptId, payload.state)
      return { accepted: true, phase: release(owner) }
    }
  }
  function accepted(
    op: CodeHostReviewOpRequest['op'],
    recordId: string,
    row: OpRow,
    phase: CodeHostReviewLeasePhase
  ): CodeHostReviewOpAccepted {
    return {
      op,
      recordId,
      attemptId: row.attemptId,
      fence: row.fence,
      kind: row.kind as CodeHostReviewOpAccepted['kind'],
      ordinal: row.ordinal,
      state: row.state,
      phase
    }
  }
  return { cp, authorizations, ops, results, records, leases, outcomes, subjectOf }
}

/** The daemon-local durability the adapter depends on, in memory. */
class FakeReviewStore {
  readonly rows = new Map<string, ReviewIntentRow>()
  private secret?: string

  async recordReviewIntent(row: ReviewIntentRow): Promise<void> {
    this.rows.set(row.intentId, { ...row })
  }

  async clearReviewIntent(intentId: string): Promise<void> {
    this.rows.delete(intentId)
  }

  async listReviewIntents(daemonId: string): Promise<ReviewIntentRow[]> {
    return [...this.rows.values()].filter((row) => row.daemonId === daemonId)
  }

  async getOrCreateDaemonSecret(mint: () => string): Promise<string> {
    this.secret ??= mint()
    return this.secret
  }
}

function fakeScheduler() {
  const pending: Array<{ fn: () => void; id: number }> = []
  let next = 1
  return {
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
}

type Control = ReturnType<typeof fakeCp>

interface HarnessOptions {
  state?: GiteaState
  script?: ScriptEntry[]
  cp?: CpOptions
  /** Share one control plane between two adapters — two agents, one pull request. */
  control?: Control
  tokens?: string[]
  hook?: HookDispatchContext
  key?: string
  reviewStore?: FakeReviewStore
  /** The daemon key a fresh store mints; a different one is another daemon. */
  markerSeed?: string
  attemptIds?: string[]
  open?: boolean
  failPersist?: boolean
}

function harness(opts: HarnessOptions = {}) {
  const state = opts.state ?? giteaState()
  const gitea = fakeGitea(state, opts.script ?? [])
  const control = opts.control ?? fakeCp(opts.cp ?? {})
  const supply = opts.tokens ?? ['gitea-effect-1']
  const minted: string[] = []
  const invalidated: string[] = []
  const reviewStore = opts.reviewStore ?? new FakeReviewStore()
  const hook = opts.hook ?? hookContext()
  const key = opts.key ?? KEY
  const attemptIds = opts.attemptIds ?? [ATTEMPT]
  let mintedAttempts = 0
  let persisted = 0
  let clock = 1_000
  const adapter = new GiteaReviewAdapter({
    cp: () => control.cp,
    orgForAgent: () => 'org-1',
    daemonId: () => DAEMON_ID,
    store: reviewStore,
    markerKey: async () =>
      Buffer.from(await reviewStore.getOrCreateDaemonSecret(() => opts.markerSeed ?? MARKER_SEED), 'utf8'),
    token: async () => {
      const token = supply[Math.min(minted.length, supply.length - 1)]!
      minted.push(token)
      return token
    },
    invalidateToken: (_turn, token) => void invalidated.push(token),
    log: { warn: () => {} },
    apiBaseUrl: () => BASE,
    fetchImpl: gitea.fetchImpl,
    newAttemptId: () => attemptIds[Math.min(mintedAttempts++, attemptIds.length - 1)]!,
    newStartToken: () => `start-${control.ops.filter((op) => op.op === 'issue').length}`,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ambiguousWindowMs: 4_000,
    pollIntervalMs: 1_000,
    scheduler: fakeScheduler(),
    resweepBaseMs: 1_000
  })
  const open = (turnHook = hook, turnKey = key) =>
    adapter.openTurn(turnKey, turnHook, 'acp-session-1', {
      daemonId: DAEMON_ID,
      persist: async () => {
        persisted += 1
        if (opts.failPersist) throw new Error('inbox row is missing')
      }
    })
  if (opts.open !== false) open()
  return {
    adapter,
    state,
    hook,
    control,
    calls: gitea.calls,
    release: gitea.release,
    ops: control.ops,
    results: control.results,
    authorizations: control.authorizations,
    reviewStore,
    open,
    persisted: () => persisted,
    tokens: () => minted,
    invalidated: () => invalidated
  }
}

const submissions = (calls: Call[]) =>
  calls.filter((call) => call.method === 'POST' && call.path === `${PULL_PATH}/reviews`)
const deletes = (calls: Call[]) => calls.filter((call) => call.method === 'DELETE')
const mutations = (calls: Call[]) =>
  calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)

/** A pending review the bot left behind, staged at `head` with one comment marked by `attemptId`. */
function seedPending(state: GiteaState, attemptId: string, head = HEAD, marked = true): FakeReview {
  const review: FakeReview = {
    id: String(state.nextId++),
    user: { id: state.botUserId },
    state: 'PENDING',
    body: '',
    commit_id: head,
    comments: [
      {
        id: String(state.nextId++),
        path: 'src/a.ts',
        body: marked ? `stale finding\n\n${signer.mint(attemptId, 1, head)}` : 'someone typed this by hand',
        position: 3
      }
    ]
  }
  state.reviews.push(review)
  return review
}

/** A review the bot already submitted under `attemptId` — what a landed request leaves visible. */
function seedSubmitted(state: GiteaState, attemptId: string, reviewState: FakeReview['state'] = 'COMMENT'): FakeReview {
  const review: FakeReview = {
    id: String(state.nextId++),
    user: { id: state.botUserId },
    state: reviewState,
    body: `summary\n\n${signer.mint(attemptId, 0, HEAD)}`,
    commit_id: HEAD,
    comments: []
  }
  state.reviews.push(review)
  return review
}

describe('Gitea review adapter — pre-effect rejections and turn ownership', () => {
  it('rejects an incompatible pair, an empty body, and an event above the policy before any call', async () => {
    const h = harness({ hook: hookContext({ snapshot: { ...SNAPSHOT, reviewPolicy: 'comment' } }) })
    await expect(h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'fail' }))).rejects.toThrow(
      /APPROVE requires verdict=pass/
    )
    await expect(h.adapter.submit(KEY, request({ body: '  ' }))).rejects.toThrow(/non-empty body/)
    await expect(h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))).rejects.toThrow(
      /exceeds this hook's comment review policy/
    )
    expect(h.calls).toEqual([])
    expect(h.authorizations).toEqual([])
  })

  it('refuses when the control plane does not advertise codehost-review-v1', async () => {
    const h = harness({ cp: { supports: false } })
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/codehost-review-v1/)
    expect(h.calls).toEqual([])
  })

  it('allows only one review attempt per turn and is unavailable outside the active pull-request turn', async () => {
    const h = harness()
    await h.adapter.submit(KEY, request())
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/already has a formal review attempt/)
    await expect(h.adapter.submit('other-key', request())).rejects.toThrow(/active pull-request hook turn/)
    expect(submissions(h.calls)).toHaveLength(1)
  })

  it('opens a review turn only for a delivery that opens a review generation on a headed pull request', () => {
    const h = harness({ open: false })
    const gitea = hookContext().gitea!
    expect(h.open(hookContext({ snapshot: { ...SNAPSHOT, reviewPolicy: 'off' } }), 'k1')).toBeUndefined()
    expect(h.open(hookContext({ gitea: { ...gitea, target: { kind: 'issue', index: 5 } } }), 'k2')).toBeUndefined()
    expect(h.open(hookContext({ event: 'note:created' }), 'k3')).toBeUndefined()
    expect(h.open(hookContext({ gitea: { ...gitea, target: { kind: 'pull', index: INDEX } } }), 'k4')).toBeUndefined()
    expect(
      h.open(hookContext({ snapshot: { ...SNAPSHOT, dispatchDaemonId: '99999999-9999-4999-8999-999999999999' } }), 'k5')
    ).toBeUndefined()
    // The console re-run and a relay-flagged reviewer request open one like a revision does.
    expect(h.open(hookContext({ event: 'merge_request:rerun' }), 'k6')).toBeDefined()
    expect(
      h.open(
        hookContext({
          event: 'note:created',
          gitea: { ...gitea, target: { kind: 'pull', index: INDEX, headSha: HEAD, explicitReviewRequest: true } }
        }),
        'k7'
      )
    ).toBeDefined()
    // A durable attempt that already reached an effect leaves the turn terminal.
    const done = h.open(
      hookContext({
        codeReview: { attemptId: ATTEMPT, event: 'COMMENT', verdict: 'neutral', headSha: HEAD, state: 'submitted' }
      }),
      'k8'
    )
    expect(done?.state).toBe('done')
  })

  it('routes a code review to the adapter that owns the active turn', async () => {
    const h = harness()
    const router = new CodeHostReviewRouter()
    router.register({ provider: 'gitlab', owns: () => false, submit: async () => undefined })
    router.register(h.adapter)
    const outcome = (await router.submit(request())) as GiteaReviewOutcome
    expect(outcome).toMatchObject({ provider: 'gitea', state: 'submitted' })
  })
})

describe('Gitea review adapter — the happy path per verdict (§10.3 steps 1-4)', () => {
  it('publishes a COMMENT review with marker-signed summary and inline comments, and reports body-free', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      KEY,
      request({
        comments: [
          { path: 'src/a.ts', body: 'Bug here.', line: 9, side: 'RIGHT' },
          { path: 'src/b.ts', body: 'Removed too much.', line: 4, side: 'LEFT' }
        ]
      })
    )) as GiteaReviewOutcome

    expect(outcome.state).toBe('submitted')
    expect(outcome.message).toContain('published on the pull request')
    expect(outcome.publishedEvent).toBeUndefined()
    const [post] = submissions(h.calls)
    expect(post!.body).toMatchObject({ commit_id: HEAD, event: 'COMMENT' })
    expect(String(post!.body!.body)).toContain('Looks reasonable overall.')
    expect(String(post!.body!.body)).toContain(signer.mint(ATTEMPT, 0, HEAD))
    const comments = post!.body!.comments as Array<Record<string, unknown>>
    expect(comments).toHaveLength(2)
    // RIGHT → new_position, LEFT → old_position, and every inline comment carries its ordinal marker.
    expect(comments[0]).toMatchObject({ path: 'src/a.ts', new_position: 9 })
    expect(comments[0]!.old_position).toBeUndefined()
    expect(String(comments[0]!.body)).toContain(signer.mint(ATTEMPT, 1, HEAD))
    expect(comments[1]).toMatchObject({ path: 'src/b.ts', old_position: 4 })
    expect(String(comments[1]!.body)).toContain(signer.mint(ATTEMPT, 2, HEAD))
    // The reconcile read precedes the one submission; nothing was deleted.
    expect(mutations(h.calls)).toEqual([`POST ${PULL_PATH}/reviews`])
    // Body-free result: ids and one normalized state, never review text.
    const report = h.results.at(-1)!
    expect(report).toMatchObject({ provider: 'gitea', projectId: REPO, mergeRequestIid: INDEX, state: 'submitted' })
    expect(JSON.stringify(report)).not.toContain('Looks reasonable overall.')
    expect(report.externalIds).toEqual([{ kind: 'review', externalId: h.state.reviews[0]!.id }])
    expect(report.externalIds![0]!.externalId).toMatch(/^\d{16}$/)
    expect(h.state.reviews[0]!.state).toBe('COMMENT')
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
  })

  it('publishes REQUEST_CHANGES natively, with no reviewer precondition', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event: 'REQUEST_CHANGES', verdict: 'fail' })
    )) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(submissions(h.calls)[0]!.body).toMatchObject({ event: 'REQUEST_CHANGES' })
    // Gitea needs no reviewer record, so the authorization carries no reviewer fact.
    expect(h.authorizations[0]!.serviceAccountIsReviewer).toBeUndefined()
    expect(h.state.reviews[0]!.state).toBe('REQUEST_CHANGES')
  })

  it('publishes APPROVE as APPROVED in the same call', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(submissions(h.calls)[0]!.body).toMatchObject({ event: 'APPROVED' })
    expect(h.state.reviews[0]!.state).toBe('APPROVED')
    expect(h.results.at(-1)).toMatchObject({ event: 'APPROVE', verdict: 'pass', state: 'submitted' })
  })

  it('runs issue → start → settle for the one submission and releases the lease on the result', async () => {
    const h = harness()
    await h.adapter.submit(KEY, request())
    expect(h.ops.map((op) => (op.op === 'issue' ? `issue:${op.kind}:${op.ordinal}` : op.op))).toEqual([
      'issue:bulk_publish:0',
      'start',
      'settle'
    ])
    expect(h.control.leases.get(h.control.subjectOf(REPO, INDEX))).toMatchObject({ phase: 'settled', attemptId: null })
  })

  it('refreshes the effect lease exactly once after a definite 401 and retries under a new record', async () => {
    const h = harness({
      tokens: ['gitea-stale', 'gitea-fresh'],
      script: [{ method: 'POST', path: /\/reviews$/, reply: { status: 401, body: { message: 'token is required' } } }]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(h.invalidated()).toEqual(['gitea-stale'])
    const posts = submissions(h.calls)
    expect(posts.map((post) => post.token)).toEqual(['gitea-stale', 'gitea-fresh'])
    const issued = h.ops.filter((op) => op.op === 'issue') as Array<{ ordinal: number }>
    expect(issued.map((op) => op.ordinal)).toEqual([0, 1])
  })

  it('collapses a range to its end line and names the start on the comment’s first line', async () => {
    const h = harness()
    await h.adapter.submit(
      KEY,
      request({
        comments: [
          { path: 'src/a.ts', body: 'Whole block.', line: 14, side: 'RIGHT', startLine: 10, startSide: 'RIGHT' }
        ]
      })
    )
    const [comment] = submissions(h.calls)[0]!.body!.comments as Array<Record<string, unknown>>
    expect(comment).toMatchObject({ path: 'src/a.ts', new_position: 14 })
    expect(String(comment!.body).startsWith('Lines 10-14:\n\nWhole block.')).toBe(true)
  })
})

describe('Gitea review adapter — reconcile before submit (§10.3 step 2)', () => {
  it('deletes only the bot’s own pending review, never a submitted one or another user’s pending one', async () => {
    const state = giteaState()
    const orphan = seedPending(state, OLD_ATTEMPT)
    const submitted = seedSubmitted(state, OLD_ATTEMPT)
    const human: FakeReview = {
      id: String(state.nextId++),
      user: { id: HUMAN_USER },
      state: 'PENDING',
      body: '',
      commit_id: HEAD,
      comments: []
    }
    state.reviews.push(human)
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(deletes(h.calls).map((call) => call.path)).toEqual([`${PULL_PATH}/reviews/${orphan.id}`])
    // The state guard is re-read right before the delete, and the delete rides its own record.
    const reads = h.calls.filter((call) => call.method === 'GET' && call.path === `${PULL_PATH}/reviews/${orphan.id}`)
    expect(reads).toHaveLength(1)
    expect(h.ops.some((op) => op.op === 'issue' && op.kind === 'draft_delete')).toBe(true)
    expect(state.reviews.map((review) => review.id)).toContain(submitted.id)
    expect(state.reviews.map((review) => review.id)).toContain(human.id)
    // The delete precedes the submission.
    expect(h.calls.findIndex((call) => call.method === 'DELETE')).toBeLessThan(
      h.calls.findIndex((call) => call.method === 'POST')
    )
  })

  it('deletes an orphan staged against an earlier head by verifying its markers under that head', async () => {
    const state = giteaState()
    seedPending(state, OLD_ATTEMPT, OTHER_HEAD)
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(deletes(h.calls)).toHaveLength(1)
  })

  it('fails closed on a pending review with an unmarked comment, without deleting or submitting', async () => {
    const state = giteaState()
    seedPending(state, OLD_ATTEMPT, HEAD, false)
    const h = harness({ state })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
    expect(mutations(h.calls)).toEqual([])
    expect(h.results.at(-1)!.state).toBe('review_reconciliation_required')
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)
  })

  it('fails closed on a marker this daemon cannot verify', async () => {
    const state = giteaState()
    const foreign = new ReviewMarkerSigner(Buffer.from('a-different-daemons-marker-key-01'))
    state.reviews.push({
      id: String(state.nextId++),
      user: { id: BOT_USER },
      state: 'PENDING',
      body: '',
      commit_id: HEAD,
      comments: [
        { id: String(state.nextId++), path: 'x', body: `x\n\n${foreign.mint(OLD_ATTEMPT, 1, HEAD)}`, position: 1 }
      ]
    })
    const h = harness({ state })
    expect(((await h.adapter.submit(KEY, request())) as GiteaReviewOutcome).state).toBe(
      'review_reconciliation_required'
    )
    expect(mutations(h.calls)).toEqual([])
  })

  it('refuses to delete a row that stopped being pending between the list and the delete', async () => {
    const state = giteaState()
    const orphan = seedPending(state, OLD_ATTEMPT)
    const h = harness({
      state,
      // The re-read right before the delete sees the row already submitted by a request still in flight.
      script: [
        {
          method: 'GET',
          path: new RegExp(`/reviews/${orphan.id}$`),
          reply: { status: 200, body: { id: Number(orphan.id), user: { id: Number(BOT_USER) }, state: 'COMMENT' } }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('review_reconciliation_required')
    expect(deletes(h.calls)).toEqual([])
    expect(submissions(h.calls)).toEqual([])
  })

  it('reads back after an ambiguous delete: proven absence upgrades the record, presence fails closed', async () => {
    const gone = giteaState()
    const orphan = seedPending(gone, OLD_ATTEMPT)
    const h = harness({
      state: gone,
      script: [
        {
          method: 'DELETE',
          path: /\/reviews\//,
          reply: 'network',
          then: () => void (gone.reviews = gone.reviews.filter((review) => review.id !== orphan.id))
        }
      ]
    })
    expect(((await h.adapter.submit(KEY, request())) as GiteaReviewOutcome).state).toBe('submitted')
    const settles = h.ops.filter((op) => op.op === 'settle') as Array<{
      outcome: { kind: string; externalId?: string }
    }>
    expect(settles.map((op) => op.outcome.kind)).toEqual(['ambiguous', 'deterministic', 'deterministic'])
    expect(settles[1]!.outcome).toMatchObject({ kind: 'deterministic', status: 204, externalId: orphan.id })

    const stuck = giteaState()
    seedPending(stuck, OLD_ATTEMPT)
    const h2 = harness({ state: stuck, script: [{ method: 'DELETE', path: /\/reviews\//, reply: 'network' }] })
    expect(((await h2.adapter.submit(KEY, request())) as GiteaReviewOutcome).state).toBe(
      'review_reconciliation_required'
    )
    expect(submissions(h2.calls)).toEqual([])
  })

  it('cannot be confused by a marker the model planted in its own review body', async () => {
    const h = harness()
    const outcome = (await h.adapter.submit(
      KEY,
      request({ body: `Please look here.\n${signer.mint(ATTEMPT, 0, HEAD)}` })
    )) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    const body = String(submissions(h.calls)[0]!.body!.body)
    expect(body.split('<!-- agentconnect-review:')).toHaveLength(2)
  })
})

describe('Gitea review adapter — head fences and preemption (§10.3 step 3, §15.1)', () => {
  it('refuses a changed head before the request and releases the lease with nothing staged', async () => {
    const h = harness({ state: giteaState({ headSha: OTHER_HEAD }) })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(submissions(h.calls)).toEqual([])
    expect(h.state.reviews).toEqual([])
    expect(h.control.leases.get(h.control.subjectOf(REPO, INDEX))?.phase).toBe('settled')
    // A proven no-effect attempt leaves the ordinary reply available and the turn free to retry.
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(true)
    expect(h.adapter.owns(KEY, AGENT_ID)).toBe(true)
  })

  it('settles a started request by its own evidence even when the head moves on afterwards', async () => {
    const state = giteaState()
    const h = harness({
      state,
      script: [
        {
          method: 'POST',
          path: /\/reviews$/,
          reply: 'network',
          // The request landed, and a newer revision arrived right after it.
          then: () => {
            seedSubmitted(state, ATTEMPT)
            state.headSha = OTHER_HEAD
          }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(submissions(h.calls)).toHaveLength(1)
    expect(outcome.externalIds).toEqual([{ kind: 'review', externalId: state.reviews[0]!.id }])
  })

  it('surfaces a control-plane head_changed or lease_held refusal without touching the provider', async () => {
    const h = harness({ cp: { refuse: 'head_changed' } })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(outcome.message).toContain('pull request head changed')
    expect(mutations(h.calls)).toEqual([])
  })
})

describe('Gitea review adapter — ambiguous submission (§10.3 step 5, §15.2)', () => {
  it('identifies an ambiguous submission by its summary marker and never submits twice', async () => {
    const state = giteaState()
    const h = harness({
      state,
      script: [{ method: 'POST', path: /\/reviews$/, reply: 'network', then: () => void seedSubmitted(state, ATTEMPT) }]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(submissions(h.calls)).toHaveLength(1)
    expect(outcome.externalIds).toEqual([{ kind: 'review', externalId: state.reviews[0]!.id }])
    const settle = h.ops.filter((op) => op.op === 'settle').at(-1) as { outcome: { kind: string; externalId?: string } }
    expect(settle.outcome).toMatchObject({ kind: 'deterministic', externalId: state.reviews[0]!.id })
  })

  it('treats a pending review carrying this attempt’s inline markers as staged, not submitted', async () => {
    const state = giteaState()
    const h = harness({
      state,
      script: [
        {
          method: 'POST',
          path: /\/reviews$/,
          reply: 'network',
          // Gitea staged the comments and is still running the submission step.
          then: () => void seedPending(state, ATTEMPT)
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(submissions(h.calls)).toHaveLength(1)
    // No delete either: deletion is never a basis for release.
    expect(deletes(h.calls)).toEqual([])
  })

  it('reports not_submitted for a deterministic rejection and leaves the same attempt free to retry', async () => {
    const h = harness({
      attemptIds: [ATTEMPT, SECOND_ATTEMPT],
      script: [
        {
          method: 'POST',
          path: /\/reviews$/,
          reply: { status: 422, body: { message: 'review event COMMENT requires a body or a comment' } }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(h.results.at(-1)!.externalIds).toBeUndefined()
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(true)
    const retry = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(retry.state).toBe('submitted')
    // A proven no-effect attempt is superseded by a fresh id under a fresh lease.
    expect(h.authorizations.map((authorization) => authorization.attemptId)).toEqual([ATTEMPT, SECOND_ATTEMPT])
  })

  it('locks the pull request when no marked review appears, stays locked across a retry, and clears on a later reconciliation', async () => {
    const state = giteaState()
    const h = harness({
      state,
      attemptIds: [ATTEMPT, SECOND_ATTEMPT, THIRD_ATTEMPT],
      script: [{ method: 'POST', path: /\/reviews$/, reply: 'network' }]
    })
    const locked = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(locked.state).toBe('ambiguous_locked')
    expect(locked.message).toContain('locked against further automated review attempts')
    expect(h.results.at(-1)).toMatchObject({ attemptId: ATTEMPT, state: 'ambiguous_locked' })
    expect(h.control.leases.get(h.control.subjectOf(REPO, INDEX))).toMatchObject({
      phase: 'ambiguous_locked',
      attemptId: ATTEMPT
    })
    expect(codeHostReviewFallbackAllowed(h.hook)).toBe(false)

    // A later delivery on the same pull request is refused by the lock: nothing is submitted, the lock holds.
    const retryHook = hookContext({ deliveryKey: 'delivery-2', event: 'merge_request:rerun' })
    const retryKey = sessionKey('hook', HOOK_ID, THREAD, AGENT_ID, `gitea:${REPO}`)
    h.open(retryHook, retryKey)
    const retried = (await h.adapter.submit(retryKey, {
      ...request(),
      transportScope: `gitea:${REPO}`
    })) as GiteaReviewOutcome
    expect(retried.state).toBe('ambiguous_locked')
    expect(retried.message).toContain('stays locked until its marked review is found submitted')
    expect(submissions(h.calls)).toHaveLength(1)
    expect(h.control.leases.get(h.control.subjectOf(REPO, INDEX))!.phase).toBe('ambiguous_locked')
    expect(codeHostReviewFallbackAllowed(retryHook)).toBe(false)

    // The refused attempt read the pull request from the lock's coordinates and found nothing submitted: it asked once.
    expect(h.authorizations.filter((authorization) => authorization.attemptId === SECOND_ATTEMPT)).toHaveLength(1)

    // The lost request finished at Gitea: the next attempt's refusal runs the pass, names the review when it asks again, and publishes under a fresh fence.
    seedSubmitted(state, ATTEMPT)
    const laterHook = hookContext({ deliveryKey: 'delivery-3', event: 'merge_request:rerun' })
    const laterKey = sessionKey('hook', HOOK_ID, THREAD, AGENT_ID, `gitea:${REPO}:later`)
    h.open(laterHook, laterKey)
    const cleared = (await h.adapter.submit(laterKey, {
      ...request(),
      transportScope: `gitea:${REPO}:later`
    })) as GiteaReviewOutcome
    expect(cleared.state).toBe('submitted')
    expect(submissions(h.calls)).toHaveLength(2)
    const asks = h.authorizations.filter((authorization) => authorization.attemptId === THIRD_ATTEMPT)
    expect(asks.map((ask) => ask.unlock)).toEqual([
      undefined,
      {
        attemptId: ATTEMPT,
        fence: '7',
        recordId: recordIdOf(ATTEMPT, 7, 'bulk_publish', 0),
        externalRef: { kind: 'review', externalId: state.reviews[0]!.id }
      }
    ])
    // The control plane settled the retained record by its object and recorded the owner's effect; the daemon settles and reports nothing for it.
    expect(h.control.records.get(recordIdOf(ATTEMPT, 7, 'bulk_publish', 0))).toMatchObject({
      state: 'settled',
      externalId: state.reviews[0]!.id
    })
    expect(h.control.outcomes.get(ATTEMPT)).toBe('submitted')
    expect(
      h.ops.filter((op) => op.attemptId === ATTEMPT).flatMap((op) => (op.op === 'settle' ? [op.outcome.kind] : []))
    ).toEqual(['ambiguous'])
    expect(h.results.filter((result) => result.attemptId === ATTEMPT).map((result) => result.state)).toEqual([
      'ambiguous_locked'
    ])
    expect(h.control.leases.get(h.control.subjectOf(REPO, INDEX))).toMatchObject({ phase: 'settled', attemptId: null })
  })

  it('clears the lock from another daemon: the seed and the record travel with the lease, not with the process', async () => {
    const state = giteaState()
    const first = harness({ state, script: [{ method: 'POST', path: /\/reviews$/, reply: 'network' }] })
    expect(((await first.adapter.submit(KEY, request())) as GiteaReviewOutcome).state).toBe('ambiguous_locked')
    // The owner left its per-attempt seed with the lease when it asked.
    const seed = ReviewMarkerSigner.seed(Buffer.from(MARKER_SEED, 'utf8'), ATTEMPT).toString('hex')
    expect(first.authorizations[0]!.markerSeed).toBe(seed)
    expect(first.control.leases.get(first.control.subjectOf(REPO, INDEX))!.markerSeed).toBe(seed)

    // The lost request finished at Gitea after the daemon that sent it was gone; another daemon picks up the next delivery.
    seedSubmitted(state, ATTEMPT)
    const second = harness({
      state,
      control: first.control,
      reviewStore: new FakeReviewStore(),
      markerSeed: OTHER_DAEMON_SEED,
      hook: hookContext({ deliveryKey: 'delivery-2', event: 'merge_request:rerun' }),
      attemptIds: [SECOND_ATTEMPT]
    })
    const cleared = (await second.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(cleared.state).toBe('submitted')
    expect(second.authorizations.at(-1)?.unlock).toEqual({
      attemptId: ATTEMPT,
      fence: '7',
      recordId: recordIdOf(ATTEMPT, 7, 'bulk_publish', 0),
      externalRef: { kind: 'review', externalId: state.reviews[0]!.id }
    })
    expect(first.control.records.get(recordIdOf(ATTEMPT, 7, 'bulk_publish', 0))).toMatchObject({
      state: 'settled',
      externalId: state.reviews[0]!.id
    })
    expect(first.control.outcomes.get(ATTEMPT)).toBe('submitted')
    expect(first.control.leases.get(first.control.subjectOf(REPO, INDEX))).toMatchObject({
      phase: 'settled',
      attemptId: null
    })
    // The other daemon's own key never signed that marker: only the seed the lease carried could verify it.
    const foreign = ReviewMarkerSigner.derived(Buffer.from(OTHER_DAEMON_SEED, 'utf8'))
    expect(foreign.read(state.reviews[0]!.body, HEAD)).toBeUndefined()
  })

  it('keeps the lock while the marked review is only pending: the coordinates let a daemon look, not unlock', async () => {
    const state = giteaState()
    const h = harness({
      state,
      attemptIds: [ATTEMPT, SECOND_ATTEMPT],
      script: [{ method: 'POST', path: /\/reviews$/, reply: 'network' }]
    })
    expect(((await h.adapter.submit(KEY, request())) as GiteaReviewOutcome).state).toBe('ambiguous_locked')
    // Staging happened; submission did not.
    seedPending(state, ATTEMPT)
    const retryHook = hookContext({ deliveryKey: 'delivery-2', event: 'merge_request:rerun' })
    const retryKey = sessionKey('hook', HOOK_ID, THREAD, AGENT_ID, `gitea:${REPO}`)
    h.open(retryHook, retryKey)
    const retried = (await h.adapter.submit(retryKey, {
      ...request(),
      transportScope: `gitea:${REPO}`
    })) as GiteaReviewOutcome
    expect(retried.state).toBe('ambiguous_locked')
    expect(h.authorizations.filter((authorization) => authorization.attemptId === SECOND_ATTEMPT)).toHaveLength(1)
    expect(mutations(h.calls)).toEqual([`POST ${PULL_PATH}/reviews`])
    expect(h.control.leases.get(h.control.subjectOf(REPO, INDEX))).toMatchObject({
      phase: 'ambiguous_locked',
      attemptId: ATTEMPT
    })
  })

  it('surfaces a control-plane ambiguous_locked refusal it holds no record for, without touching the provider', async () => {
    const h = harness({ cp: { refuse: 'ambiguous_locked' } })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(mutations(h.calls)).toEqual([])
  })

  it('stops before the request when the lease has already locked at renewal', async () => {
    const h = harness({ cp: { renewPhase: 'ambiguous_locked' } })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(submissions(h.calls)).toEqual([])
  })
})

describe('Gitea review adapter — the self-review downgrade (§10.3)', () => {
  it.each([
    { event: 'APPROVE' as const, verdict: 'pass' as const, wire: 'APPROVED' },
    { event: 'REQUEST_CHANGES' as const, verdict: 'fail' as const, wire: 'REQUEST_CHANGES' }
  ])('republishes a refused $event on the bot’s own pull request as COMMENT', async ({ event, verdict, wire }) => {
    const state = giteaState({ authorId: BOT_USER })
    const h = harness({ state })
    const outcome = (await h.adapter.submit(
      KEY,
      request({ event, verdict, comments: [{ path: 'src/a.ts', body: 'Careful.', line: 2, side: 'RIGHT' }] })
    )) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(outcome.event).toBe(event)
    expect(outcome.publishedEvent).toBe('COMMENT')
    expect(outcome.message).toContain('self_review_forbidden')
    const posts = submissions(h.calls)
    expect(posts.map((post) => post.body!.event)).toEqual([wire, 'COMMENT'])
    // The same content, marker included, rides the republish; the first request staged nothing.
    expect(posts[1]!.body!.body).toBe(posts[0]!.body!.body)
    expect(posts[1]!.body!.comments).toEqual(posts[0]!.body!.comments)
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews[0]!.state).toBe('COMMENT')
    // Two records, one per request; the result names the requested event and the published review.
    const issued = h.ops.filter((op) => op.op === 'issue') as Array<{ ordinal: number }>
    expect(issued.map((op) => op.ordinal)).toEqual([0, 1])
    expect(h.results.at(-1)).toMatchObject({ event, verdict, state: 'submitted' })
    expect(h.results.at(-1)!.externalIds).toEqual([{ kind: 'review', externalId: state.reviews[0]!.id }])
  })

  it('does not downgrade on an unrelated 422', async () => {
    const h = harness({
      state: giteaState({ authorId: BOT_USER }),
      script: [
        {
          method: 'POST',
          path: /\/reviews$/,
          reply: { status: 422, body: { message: 'review event APPROVED requires a body' } }
        }
      ]
    })
    const outcome = (await h.adapter.submit(KEY, request({ event: 'APPROVE', verdict: 'pass' }))) as GiteaReviewOutcome
    expect(outcome.state).toBe('not_submitted')
    expect(submissions(h.calls)).toHaveLength(1)
  })
})

describe('Gitea review adapter — started-operation recovery (§15.1)', () => {
  const crashed = (): HookDispatchContext =>
    hookContext({
      codeReview: {
        attemptId: ATTEMPT,
        event: 'COMMENT',
        verdict: 'neutral',
        headSha: HEAD,
        fence: '7',
        ordinals: { bulk_publish: 1 },
        operations: [
          {
            recordId: recordIdOf(ATTEMPT, 7, 'bulk_publish', 0),
            startToken: 'start-1',
            kind: 'bulk_publish',
            ordinal: 0,
            target: `${PULL_PATH}/reviews`,
            phase: 'started'
          }
        ]
      }
    })
  const seeded = () => [
    { attemptId: ATTEMPT, recordId: recordIdOf(ATTEMPT, 7, 'bulk_publish', 0), kind: 'bulk_publish', ordinal: 0 }
  ]

  it('adopts a started submission that DID land and never submits a second time', async () => {
    const state = giteaState()
    const review = seedSubmitted(state, ATTEMPT, 'APPROVED')
    const h = harness({ state, hook: crashed(), cp: { seedStarted: seeded() } })
    // The lease is reacquired by the same attempt; the fake mints fence 7 for it.
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(submissions(h.calls)).toEqual([])
    expect(outcome.externalIds).toEqual([{ kind: 'review', externalId: review.id }])
    // A review that published a different verdict than the request is reported as the downgrade it is.
    expect(outcome.publishedEvent).toBe('APPROVE')
    expect([...h.control.records.values()].filter((row) => row.state === 'request_started')).toEqual([])
  })

  it('locks instead of resubmitting when a started submission left no marked review', async () => {
    const h = harness({ hook: crashed(), cp: { seedStarted: seeded() } })
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('ambiguous_locked')
    expect(submissions(h.calls)).toEqual([])
    expect(h.control.records.get(recordIdOf(ATTEMPT, 7, 'bulk_publish', 0))?.state).toBe('ambiguous')
  })

  it('returns an unstarted permit instead of settling a request that never went out', async () => {
    const hook = crashed()
    hook.codeReview!.operations![0]!.phase = 'issued'
    const h = harness({ hook, cp: { seedStarted: seeded() } })
    h.control.records.get(recordIdOf(ATTEMPT, 7, 'bulk_publish', 0))!.state = 'issued'
    const outcome = (await h.adapter.submit(KEY, request())) as GiteaReviewOutcome
    expect(outcome.state).toBe('submitted')
    expect(h.ops.some((op) => op.op === 'return-unused')).toBe(true)
    // The replacement request takes the next coordinate.
    const issued = h.ops.filter((op) => op.op === 'issue') as Array<{ ordinal: number }>
    expect(issued.map((op) => op.ordinal)).toEqual([1])
  })
})

describe('Gitea review adapter — two agents on one pull request (§10.3, §15.1)', () => {
  it('serializes two agents through the lease and publishes two distinct reviews under the one bot', async () => {
    const state = giteaState()
    const control = fakeCp()
    const first = harness({
      state,
      control,
      script: [{ method: 'POST', path: /\/reviews$/, reply: 'defer', then: () => void 0 }]
    })
    const otherHook = hookContext({ hookId: OTHER_HOOK_ID, agentId: OTHER_AGENT_ID, deliveryKey: 'delivery-b' })
    const otherKey = sessionKey('hook', OTHER_HOOK_ID, THREAD, OTHER_AGENT_ID)
    const second = harness({ state, control, hook: otherHook, key: otherKey, attemptIds: [SECOND_ATTEMPT] })
    const otherRequest = request({ agentId: OTHER_AGENT_ID, channel: OTHER_HOOK_ID, body: 'Second opinion.' })

    // Agent A holds the lease while its submission is in flight; agent B is refused, retryably.
    const inFlight = first.adapter.submit(KEY, request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const refused = (await second.adapter.submit(otherKey, otherRequest)) as GiteaReviewOutcome
    expect(refused.state).toBe('not_submitted')
    expect(refused.message).toContain('Another review attempt currently owns publication')
    expect(second.calls.filter((call) => call.method === 'POST')).toEqual([])

    // A finishes; the lease releases; B's retry publishes its own review.
    first.release()
    expect(((await inFlight) as GiteaReviewOutcome).state).toBe('submitted')
    expect(control.leases.get(control.subjectOf(REPO, INDEX))!.phase).toBe('settled')
    const published = (await second.adapter.submit(otherKey, otherRequest)) as GiteaReviewOutcome
    expect(published.state).toBe('submitted')
    expect(state.reviews).toHaveLength(2)
    expect(state.reviews.map((review) => review.state)).toEqual(['COMMENT', 'COMMENT'])
    expect(new Set(state.reviews.map((review) => review.id)).size).toBe(2)
    // Each review carries its own attempt's marker; neither absorbed the other's staging.
    expect(signer.read(state.reviews[0]!.body, HEAD)).toEqual({ attemptId: ATTEMPT, ordinal: 0 })
    expect(signer.read(state.reviews[1]!.body, HEAD)).toEqual({ attemptId: SECOND_ATTEMPT, ordinal: 0 })
  })
})

describe('Gitea review adapter — durable ownership', () => {
  it('claims the reply gate durably for a submitted review and keeps it across a restart', async () => {
    const h = harness()
    expect(((await h.adapter.submit(KEY, request())) as GiteaReviewOutcome).state).toBe('submitted')
    expect(h.hook.codeReview).toMatchObject({ attemptId: ATTEMPT, state: 'submitted', headSha: HEAD })
    const restarted = harness({ hook: h.hook, reviewStore: h.reviewStore })
    await expect(restarted.adapter.submit(KEY, request())).rejects.toThrow(/already has a formal review attempt/)
    expect(mutations(restarted.calls)).toEqual([])
  })

  it('records the attempt before the first provider call and refuses when that write fails', async () => {
    const h = harness({ failPersist: true })
    await expect(h.adapter.submit(KEY, request())).rejects.toThrow(/durability barrier failed/)
    expect(h.calls).toEqual([])
    expect(h.hook.codeReview).toBeUndefined()
  })

  it('replays an unacknowledged result report through the shared outbox', async () => {
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
    await h.adapter.reconcilePending()
    expect(h.reviewStore.rows.size).toBe(0)
    expect(h.results.filter((row) => row.attemptId === ATTEMPT).at(-1)).toMatchObject({
      state: 'submitted',
      provider: 'gitea'
    })
  })
})
