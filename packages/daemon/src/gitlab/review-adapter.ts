/**
 * The GitLab formal merge-request review adapter (gitlab-com-integration.md §15).
 *
 * One attempt per active turn, under the Control Plane's durable publication
 * lease: reconcile before create, marker-signed drafts created under single-use
 * operation records, head and reviewer state re-verified around ONE bulk publish,
 * tier-aware postcondition classification, and an approval fenced on the exact
 * head. Every ambiguous effect fails closed — no republish, no ordinary fallback.
 *
 * The target project, merge-request IID, and head come from daemon-private
 * active-turn state; they are never tool input. Review bodies never reach the
 * Control Plane: the result frame carries ids and one normalized state only.
 */
import { randomUUID } from 'node:crypto'
import {
  codeHostReviewPublicEffect,
  type CodeHostReviewAuthorize,
  type CodeHostReviewAuthorized,
  type CodeHostReviewExternalRef,
  type CodeHostReviewLeaseRenew,
  type CodeHostReviewLeaseRenewed,
  type CodeHostReviewOpAccepted,
  type CodeHostReviewOpKind,
  type CodeHostReviewOpMethod,
  type CodeHostReviewOpRequest,
  type CodeHostReviewOpOutcome,
  type CodeHostReviewResultOk,
  type CodeHostReviewResultReport,
  type CodeHostReviewState,
  type HookConfigSnapshot
} from '@agentconnect.md/protocol'
import { reviewPolicyAllows, type CodeReviewOperation, type HookDispatchContext } from '../github/hook-coords.js'
import { gitlabOpensReviewGeneration } from '../messages/hook-message.js'
import {
  validateCodeReviewInput,
  type CodeHostReviewAdapter,
  type CodeReviewEvent,
  type CodeReviewVerdict,
  type SubmitCodeReviewReq
} from '../codehost/review-adapter.js'
import {
  appendGithubMarkdownChrome,
  githubAttributionFooter,
  type GithubCommentAttribution,
  type PosterScheduler
} from '../github/poster.js'
import { parseGitlabJson } from './broker.js'
import { ReviewMarkerSigner } from './review-marker.js'

/** One authorized merge-request review turn; every field is trusted daemon state. */
export interface GitlabReviewTurn {
  hookId: string
  agentId: string
  deliveryKey: string
  snapshot: HookConfigSnapshot
  /** Numeric project id (decimal string) — the rename-stable match key. */
  projectId: string
  projectPath: string
  mergeRequestIid: number
  expectedHeadSha: string
  expectedBaseSha?: string
  sessionId: string
  /** The durable hook row this attempt's identity and outcome live on (§15, §15.2). */
  hook: HookDispatchContext
  /** Persist that row; `required` makes a failed write fail the caller. */
  persist: (required?: boolean) => Promise<void>
  /** §15 step 1: one review attempt per turn, reserved synchronously. */
  state: 'idle' | 'submitting' | 'done'
}

/** One control-plane frame a finished attempt still owes, replayed verbatim until acked (§15.1). */
export interface ReviewIntentRow {
  intentId: string
  daemonId: string
  attemptId: string
  orgId?: string
  kind: 'operation' | 'result'
  /** The exact JSON payload; both frames are idempotent REQs by contract. */
  frame: string
  attempts: number
}

export interface ReviewIntentStore {
  recordReviewIntent(row: ReviewIntentRow, now: number): Promise<void>
  clearReviewIntent(intentId: string): Promise<void>
  listReviewIntents(daemonId: string): Promise<ReviewIntentRow[]>
}

/** The narrow Control-Plane surface this adapter needs (§15.1 lease + operation ledger). */
export interface GitlabReviewControlPlane {
  /** The CP advertises `codehost-review-v1`; without it the adapter refuses before any effect. */
  supportsReview(): boolean
  authorize(payload: CodeHostReviewAuthorize, orgId?: string): Promise<CodeHostReviewAuthorized>
  operate(payload: CodeHostReviewOpRequest, orgId?: string): Promise<CodeHostReviewOpAccepted>
  renew(payload: CodeHostReviewLeaseRenew, orgId?: string): Promise<CodeHostReviewLeaseRenewed>
  report(payload: CodeHostReviewResultReport, orgId?: string): Promise<CodeHostReviewResultOk>
}

export interface GitlabReviewAdapterDeps {
  cp: () => GitlabReviewControlPlane | undefined
  orgForAgent: (agentId: string) => string | undefined
  /** The STABLE daemon identity owed frames are recovered under — never a process incarnation. */
  daemonId: () => string | undefined
  store: ReviewIntentStore
  /** Restart-stable marker key; see the trust model on {@link ReviewMarkerSigner}. */
  markerKey: () => Promise<Buffer>
  /** §14.1 effect lease: the binding's effect PAT; it never enters the agent environment. */
  token: (turn: GitlabReviewTurn) => Promise<string>
  invalidateToken: (turn: GitlabReviewTurn, token: string) => void
  attribution?: (turn: GitlabReviewTurn) => Promise<GithubCommentAttribution | undefined>
  log: { warn: (message: string) => void }
  /** The instance's `/api/v4` root for THIS turn's agent, resolved per turn (§24.4). */
  apiBaseUrl: (turn: GitlabReviewTurn) => string
  fetchImpl?: typeof fetch
  newAttemptId?: () => string
  newStartToken?: () => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** §15.2 bounded observation window for an ambiguous bulk publish. */
  ambiguousWindowMs?: number
  /** §15.2/§15 step 13 bounded wait for `detailed_merge_status` to leave its unstable values. */
  mergeStatusWindowMs?: number
  pollIntervalMs?: number
  /** Timer seam for the owed-frame resweep; tests drive it, production uses real timers. */
  scheduler?: PosterScheduler
  resweepBaseMs?: number
  resweepCapMs?: number
}

/** The model-visible outcome: one normalized state plus a plain-English sentence. */
export interface GitlabReviewOutcome {
  provider: 'gitlab'
  state: CodeHostReviewState
  event: CodeReviewEvent
  verdict: CodeReviewVerdict
  message: string
  externalIds?: CodeHostReviewExternalRef[]
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_AMBIGUOUS_WINDOW_MS = 30_000
const DEFAULT_MERGE_STATUS_WINDOW_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_RESWEEP_BASE_MS = 30_000
const DEFAULT_RESWEEP_CAP_MS = 300_000
/** Pages of owed frames one sweep drains; the store answers a bounded page at a time. */
const MAX_SWEEP_PAGES = 50
const MAX_NOTE_PAGES = 10
const NOTES_PER_PAGE = 100
const MAX_DRAFTS = 100

/** Merge-status values that mean "GitLab has not finished computing"; never read a verdict from them. */
const UNSTABLE_MERGE_STATUS = new Set(['checking', 'approvals_syncing', 'unchecked', 'preparing'])

/** One English sentence per normalized state, so the tool result mirrors §15.2 exactly. */
const OUTCOME_SENTENCE: Record<CodeHostReviewState, string> = {
  submitted: 'The formal review was published on the merge request.',
  not_submitted: 'No review was published; nothing was changed on the merge request.',
  ambiguous_locked:
    'GitLab did not confirm the publication and no review marker became visible, so this merge request is locked against further automated review attempts and no fallback comment was posted.',
  approval_not_recorded:
    'The review comments were published but the approval was not recorded; do not re-run the approval automatically.',
  review_state_not_recorded:
    'The review was published but GitLab did not report the resulting reviewer state, so the recorded state is unknown.',
  review_state_changed_unexpectedly:
    'The review was published but the reviewer state changed unexpectedly, so the recorded state is unknown.',
  requested_changes_block_observed:
    'The review was published and the merge request is currently blocked by a change request.',
  requested_changes_state_ambiguous:
    'The review was published but GitLab did not confirm the requested-changes state, so it may or may not be blocking.',
  reviewer_assignment_required:
    'REQUEST_CHANGES needs the project service account to be a current reviewer; ask a user to request a review through GitLab, or record the finding with COMMENT and verdict fail.',
  review_reconciliation_required:
    'Pending review drafts on this merge request could not be reconciled, so no review was published and this merge request stays fail-closed.'
}

/** What a settle left behind: nothing, replayable coordinates, or no replay source at all. */
type SettleDisposition = 'safe' | 'replayable' | 'blocked'

/** The terminal result is withheld until every unsafe settle has a durable replay source. */
class ResultWithheld extends Error {
  constructor() {
    super('the formal review outcome could not be made durable yet; the daemon will retry before reporting it')
    this.name = 'ResultWithheld'
  }
}

class AmbiguousSend extends Error {
  constructor(readonly code: string) {
    super(`GitLab review request outcome is unknown (${code})`)
    this.name = 'AmbiguousSend'
  }
}

interface SendResult {
  status: number
  parsed: unknown
}

interface DraftNote {
  id: string
  note: string
}

interface ReviewerRecord {
  userId: string
  state?: string
}

interface MergeRequestFacts {
  headSha: string
  baseSha?: string
  startSha?: string
  state?: string
  detailedMergeStatus?: string
  numericId?: string
}

/** The turn plus its live effect token; the token is re-minted in place on a refresh. */
interface Session {
  turn: GitlabReviewTurn
  token: string
}

/** What a ledger frame needs to name itself — an in-flight attempt or a recovered record. */
interface LeaseRef {
  turn: GitlabReviewTurn
  attemptId: string
  fence: string
  orgId?: string
}

/** Everything one attempt carries between steps. */
interface Attempt extends Session {
  req: SubmitCodeReviewReq
  signer: ReviewMarkerSigner
  orgId?: string
  attemptId: string
  fence: string
  serviceAccountUserId: string
  /** Per-kind monotonic operation-record counter; a retried mutation takes the next one. */
  ordinals: Map<CodeHostReviewOpKind, number>
  /** Draft ordinal (0 = summary) → provider draft id, for the exact-set check. */
  drafts: Map<number, string>
  externalIds: CodeHostReviewExternalRef[]
  reviewerBefore?: ReviewerRecord
  /** A settle this attempt owes has no durable replay source yet, so no result may be reported. */
  settleBlocked?: boolean
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** A big-int-safe numeric id as a decimal string; undefined when the value is not one. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function mergeRequestFacts(parsed: unknown): MergeRequestFacts | undefined {
  const mr = record(parsed)
  const refs = record(mr.diff_refs)
  const headSha = text(mr.sha) ?? text(refs.head_sha)
  if (!headSha) return undefined
  return {
    headSha,
    ...(text(refs.base_sha) ? { baseSha: text(refs.base_sha)! } : {}),
    ...(text(refs.start_sha) ? { startSha: text(refs.start_sha)! } : {}),
    ...(text(mr.state) ? { state: text(mr.state)! } : {}),
    ...(text(mr.detailed_merge_status) ? { detailedMergeStatus: text(mr.detailed_merge_status)! } : {}),
    ...(idOf(mr.id) ? { numericId: idOf(mr.id)! } : {})
  }
}

function reviewerRecords(parsed: unknown): ReviewerRecord[] {
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((row) => {
    const entry = record(row)
    const userId = idOf(record(entry.user).id)
    if (!userId) return []
    return [{ userId, ...(text(entry.state) ? { state: text(entry.state)! } : {}) }]
  })
}

function draftNotes(parsed: unknown): DraftNote[] {
  if (!Array.isArray(parsed)) return []
  return parsed.slice(0, MAX_DRAFTS).flatMap((row) => {
    const entry = record(row)
    const id = idOf(entry.id)
    return id ? [{ id, note: text(entry.note) ?? '' }] : []
  })
}

export class GitlabReviewAdapter implements CodeHostReviewAdapter {
  readonly provider = 'gitlab' as const

  private readonly turns = new Map<string, GitlabReviewTurn>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly sched: PosterScheduler
  private signerPromise?: Promise<ReviewMarkerSigner>
  /** Owed frames whose durable write has not landed yet; replayed and re-written from here. */
  private readonly unwritten = new Map<string, ReviewIntentRow>()
  private resweepHandle?: unknown
  private resweepAttempt = 0
  /** Monotonic count of arm REQUESTS, so a zero-work disarm can tell whether it raced new work. */
  private armGeneration = 0
  private sweeping = false
  private stopped = false

  constructor(private readonly deps: GitlabReviewAdapterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.sched = deps.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
  }

  /** Drop the pending resweep so a shutting-down daemon leaves no timer behind. */
  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  /**
   * Install the active review turn for one logical session key. Returns undefined
   * for every delivery that is not an authorized merge-request review generation —
   * an ordinary merge-request conversation must not own the structured tool.
   */
  openTurn(
    key: string,
    hook: HookDispatchContext | undefined,
    sessionId: string,
    options: { daemonId?: string; persist: (required?: boolean) => Promise<void> }
  ): GitlabReviewTurn | undefined {
    const gitlab = hook?.gitlab
    const snapshot = hook?.snapshot
    if (!hook || !gitlab || !snapshot) return undefined
    if (gitlab.target.kind !== 'merge_request' || !gitlab.target.headSha) return undefined
    // The same trusted predicate the prompt uses: only a delivery that OPENS a review
    // generation for this head may publish one (§15).
    if (!gitlabOpensReviewGeneration(hook.event, gitlab, snapshot.reviewPolicy)) return undefined
    if (options.daemonId && snapshot.dispatchDaemonId !== options.daemonId) return undefined
    // A durable attempt that already reached a present or unknown effect is terminal for this turn.
    const prior = hook.codeReview
    const terminal = prior?.state !== undefined && codeHostReviewPublicEffect(prior.state) !== 'absent'
    const turn: GitlabReviewTurn = {
      hookId: hook.hookId,
      agentId: hook.agentId,
      deliveryKey: hook.deliveryKey,
      snapshot,
      projectId: gitlab.projectId,
      projectPath: gitlab.projectPath,
      mergeRequestIid: gitlab.target.iid,
      expectedHeadSha: gitlab.target.headSha,
      ...(gitlab.target.baseSha ? { expectedBaseSha: gitlab.target.baseSha } : {}),
      sessionId,
      hook,
      persist: options.persist,
      state: terminal ? 'done' : 'idle'
    }
    this.turns.set(key, turn)
    return turn
  }

  /** The restart-stable signer, minted from the daemon store on first use. */
  private markerSigner(): Promise<ReviewMarkerSigner> {
    this.signerPromise ??= this.deps.markerKey().then((key) => new ReviewMarkerSigner(key))
    return this.signerPromise
  }

  closeTurn(key: string, turn?: GitlabReviewTurn): void {
    if (turn && this.turns.get(key) !== turn) return
    this.turns.delete(key)
  }

  owns(key: string, agentId: string): boolean {
    return this.turns.get(key)?.agentId === agentId
  }

  async submit(key: string, req: SubmitCodeReviewReq): Promise<GitlabReviewOutcome> {
    const turn = this.turns.get(key)
    if (!turn || turn.agentId !== req.agentId) {
      throw new Error('a formal GitLab review is only available during the active merge-request hook turn')
    }
    // §15: an incompatible pair or unusable body is rejected before any provider effect.
    const invalid = validateCodeReviewInput(req)
    if (invalid) throw new Error(invalid)
    if (!reviewPolicyAllows(turn.snapshot.reviewPolicy, req.event)) {
      throw new Error(`${req.event} exceeds this hook's ${turn.snapshot.reviewPolicy} review policy`)
    }
    if (turn.state !== 'idle') throw new Error('this merge-request hook turn already has a formal review attempt')
    // §15 step 1: turn-local CAS before the first await.
    turn.state = 'submitting'
    const cp = this.deps.cp()
    if (!cp) {
      turn.state = 'done'
      throw new Error('control plane is not connected; formal review denied')
    }
    if (!cp.supportsReview()) {
      turn.state = 'done'
      throw new Error('the control plane does not serve formal code-host reviews yet (codehost-review-v1)')
    }
    try {
      const outcome = await this.run(turn, req, cp)
      // A proven no-effect outcome leaves the turn free to correct its input and retry.
      turn.state = codeHostReviewPublicEffect(outcome.state) === 'absent' ? 'idle' : 'done'
      return outcome
    } catch (err) {
      // A withheld result leaves the turn open and the attempt pre-terminal, by design.
      turn.state = err instanceof ResultWithheld ? 'idle' : 'done'
      throw err
    }
  }

  /**
   * RECORD-FIRST (§15, §15.1): the attempt identity lands on the durable hook row
   * before any provider or control-plane call, so a crash replays the SAME attempt —
   * its lease is reacquired idempotently and its marked drafts are recoverable. A
   * prior attempt that proved no effect is superseded by a fresh id.
   */
  private async reserveAttempt(turn: GitlabReviewTurn, req: SubmitCodeReviewReq): Promise<string> {
    const prior = turn.hook.codeReview
    const recovering = prior !== undefined && prior.state === undefined
    if (recovering) {
      if (prior.event !== req.event || prior.verdict !== req.verdict || prior.headSha !== turn.expectedHeadSha) {
        throw new Error('a recovered formal-review attempt must keep its original event, verdict, and head')
      }
      return prior.attemptId
    }
    const attemptId = (this.deps.newAttemptId ?? randomUUID)()
    turn.hook.codeReview = {
      attemptId,
      event: req.event,
      verdict: req.verdict,
      headSha: turn.expectedHeadSha
    }
    try {
      await turn.persist(true)
    } catch (err) {
      if (prior) turn.hook.codeReview = prior
      else delete turn.hook.codeReview
      throw new Error(`formal review durability barrier failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return attemptId
  }

  private async run(
    turn: GitlabReviewTurn,
    req: SubmitCodeReviewReq,
    cp: GitlabReviewControlPlane
  ): Promise<GitlabReviewOutcome> {
    const orgId = this.deps.orgForAgent(turn.agentId)
    const attemptId = await this.reserveAttempt(turn, req)
    const signer = await this.markerSigner()
    const session: Session = { turn, token: await this.deps.token(turn) }

    // Read pre-lease so the authz can carry the §15 step 6/7 reviewer fact and prove the leased account is ours.
    const serviceAccountUserId = idOf(record(await this.get(session, '/user')).id)
    if (!serviceAccountUserId) throw new Error('GitLab did not identify the review publishing account')
    const reviewersBefore = reviewerRecords(await this.get(session, this.mrPath(turn, '/reviewers')))
    const reviewerBefore = reviewersBefore.find((row) => row.userId === serviceAccountUserId)

    // §15 steps 2-3: the durable publication lease and the CP's authorization in one round trip.
    const authorized = await cp.authorize(
      {
        hookId: turn.hookId,
        deliveryKey: turn.deliveryKey,
        attemptId,
        provider: 'gitlab',
        projectId: turn.projectId,
        mergeRequestIid: turn.mergeRequestIid,
        requestedEvent: req.event,
        requestedVerdict: req.verdict,
        snapshot: turn.snapshot,
        headSha: turn.expectedHeadSha,
        ...(turn.expectedBaseSha ? { baseSha: turn.expectedBaseSha } : {}),
        serviceAccountIsReviewer: reviewerBefore !== undefined
      },
      orgId
    )
    if (!authorized.authorized) return await this.refused(turn, req, authorized)
    if (
      authorized.projectId !== turn.projectId ||
      authorized.mergeRequestIid !== turn.mergeRequestIid ||
      authorized.expectedHeadSha !== turn.expectedHeadSha
    ) {
      throw new Error('control plane returned a mismatched formal-review target')
    }

    const attempt: Attempt = {
      turn,
      req,
      signer,
      ...(orgId ? { orgId } : {}),
      attemptId,
      fence: authorized.lease.fence,
      token: session.token,
      serviceAccountUserId,
      // Seeded from the durable record: a replayed attempt must never reuse a spent coordinate.
      ordinals: new Map(
        Object.entries(turn.hook.codeReview?.ordinals ?? {}).map(([kind, next]) => [kind as CodeHostReviewOpKind, next])
      ),
      drafts: new Map(),
      externalIds: [],
      ...(reviewerBefore ? { reviewerBefore } : {})
    }
    // The fence rides the durable record so an owed ledger frame stays derivable after a restart.
    if (turn.hook.codeReview) {
      turn.hook.codeReview.fence = attempt.fence
      await turn.persist(true)
    }
    // The leased publishing identity must be the account this effect token speaks as.
    if (authorized.lease.serviceAccountUserId !== serviceAccountUserId) {
      return this.settle(cp, attempt, 'not_submitted')
    }
    return await this.publish(cp, attempt)
  }

  private async publish(cp: GitlabReviewControlPlane, attempt: Attempt): Promise<GitlabReviewOutcome> {
    const { turn, req } = attempt

    // §15.1: a request this attempt already permitted must be classified against the
    // control plane's ledger before another one is issued.
    const recovered = await this.reconcileOperations(cp, attempt)
    if (recovered) return recovered

    // §15 step 4: reconcile every pending draft this account owns before creating one.
    const reconciled = await this.reconcileDrafts(cp, attempt)
    if (reconciled) return reconciled

    // §15 step 5: re-fetch the merge request and reject a changed head.
    const before = mergeRequestFacts(await this.get(attempt, this.mrPath(turn)))
    if (!before) throw new Error('GitLab did not return the merge request revision')
    if (before.headSha !== turn.expectedHeadSha) return this.settle(cp, attempt, 'not_submitted')

    // §15 step 10 is the authoritative reviewer read; step 6/7 already ran pre-lease.
    if (req.event === 'REQUEST_CHANGES' && attempt.reviewerBefore === undefined) {
      return this.settle(cp, attempt, 'reviewer_assignment_required')
    }

    // §15 step 8: the summary rides draft ordinal 0, so ONE bulk publish leaves its marker on a published note.
    const created = await this.createDrafts(cp, attempt, before)
    if (created) return created

    // §15 step 9: the current attempt must own the complete, exact draft set.
    if (!(await this.draftSetIsExact(attempt))) {
      return this.settle(cp, attempt, 'review_reconciliation_required')
    }

    // §15 step 10: reviewer state immediately before publication.
    const reviewerNow = await this.readReviewer(attempt)
    if (req.event === 'REQUEST_CHANGES' && reviewerNow === undefined) {
      await this.deleteAttemptDrafts(cp, attempt)
      return this.settle(cp, attempt, 'reviewer_assignment_required')
    }

    // §15 step 11: renew the lease, re-verify head and fence, re-list drafts, publish once.
    const renewed = await cp.renew({ attemptId: attempt.attemptId, fence: attempt.fence }, attempt.orgId)
    if (renewed.phase === 'ambiguous_locked') return this.settle(cp, attempt, 'ambiguous_locked')
    attempt.fence = renewed.fence
    const atPublish = mergeRequestFacts(await this.get(attempt, this.mrPath(turn)))
    if (!atPublish || atPublish.headSha !== turn.expectedHeadSha) {
      await this.deleteAttemptDrafts(cp, attempt)
      return this.settle(cp, attempt, 'not_submitted')
    }
    if (!(await this.draftSetIsExact(attempt))) {
      return this.settle(cp, attempt, 'review_reconciliation_required')
    }

    const published = await this.bulkPublish(cp, attempt)
    if (published !== 'published') return this.settle(cp, attempt, published)

    // §15 step 12: classify the postcondition from reviewer state and mergeability.
    const postcondition = await this.classifyPostcondition(attempt, reviewerNow)
    if (postcondition !== 'submitted') return this.settle(cp, attempt, postcondition)

    // §15 step 13: APPROVE only after the unchanged-state postcondition holds.
    if (req.event === 'APPROVE') {
      return this.settle(cp, attempt, await this.approve(cp, attempt, atPublish))
    }
    return this.settle(cp, attempt, 'submitted')
  }

  /**
   * §15.1 ledger recovery: every operation whose one request was permitted but never
   * settled is classified by its provider effect and settled before this attempt
   * issues another. A publication or approval that got that far is TERMINAL — the
   * attempt must never create or publish again.
   */
  private async reconcileOperations(
    cp: GitlabReviewControlPlane,
    attempt: Attempt
  ): Promise<GitlabReviewOutcome | undefined> {
    const pending = [...(attempt.turn.hook.codeReview?.operations ?? [])]
    if (pending.length === 0) return undefined
    const marked = new Map<number, string>()
    for (const draft of draftNotes(
      await this.get(attempt, this.mrPath(attempt.turn, '/draft_notes')).catch(() => undefined)
    )) {
      const marker = attempt.signer.read(draft.note, attempt.turn.expectedHeadSha)
      if (marker?.attemptId === attempt.attemptId.toLowerCase()) marked.set(marker.ordinal, draft.id)
    }
    const outstanding: CodeReviewOperation[] = []
    for (const op of pending) {
      // A permit whose start was never acknowledged had no request: return it unused.
      if (op.phase === 'issued' && (await this.returnUnused(cp, attempt, op)) !== 'started') continue
      if (op.kind === 'bulk_publish' || op.kind === 'approval') {
        outstanding.push(op)
        continue
      }
      await this.settleAndClear(cp, attempt, op.recordId, this.classifyDraftOperation(op, marked, attempt))
    }
    const publish = outstanding.find((op) => op.kind === 'bulk_publish')
    const approval = outstanding.find((op) => op.kind === 'approval')
    if (!publish && !approval) return undefined

    // Only positive provider evidence can classify a permitted publication.
    const note = await this.findSummaryNote(attempt).catch(() => undefined)
    if (publish) {
      if (!note) {
        await this.settleAndClear(cp, attempt, publish.recordId, { kind: 'ambiguous', code: 'publish_unreconciled' })
        return await this.settle(cp, attempt, 'ambiguous_locked')
      }
      await this.settleAndClear(cp, attempt, publish.recordId, {
        kind: 'deterministic',
        status: 201,
        externalId: note
      })
    }
    if (note) attempt.externalIds.push({ kind: 'note', externalId: note })
    if (approval) {
      const readback = await this.get(attempt, this.mrPath(attempt.turn, '/approvals')).catch(() => undefined)
      const approved = this.approvalReadback(readback, attempt)
      const approvalId = idOf(record(readback).id)
      await this.settleAndClear(cp, attempt, approval.recordId, {
        kind: 'deterministic',
        status: approved ? 201 : 422,
        ...(approved && approvalId ? { externalId: approvalId } : {})
      })
      if (approved && approvalId) attempt.externalIds.push({ kind: 'approval', externalId: approvalId })
      return await this.settle(cp, attempt, approved ? 'submitted' : 'approval_not_recorded')
    }
    // A recovered publication cannot prove the unchanged-state postcondition, so only the
    // baseline-free requested-changes classification stays available (§15.2).
    if (attempt.req.event === 'REQUEST_CHANGES') {
      const status = await this.stableMergeStatus(attempt, true)
      return await this.settle(
        cp,
        attempt,
        status === 'requested_changes' ? 'requested_changes_block_observed' : 'requested_changes_state_ambiguous'
      )
    }
    return await this.settle(cp, attempt, 'review_state_not_recorded')
  }

  /**
   * Hand back a permit no request ever started (§15.1's second transfer condition).
   *
   * `returned` — acknowledged, so the coordinates are gone. `started` — the control plane
   * had already recorded the start, so the local phase raced behind it and the caller must
   * classify by provider evidence instead. `deferred` — nothing was decided, so the
   * coordinates stay exactly as they are.
   */
  private async returnUnused(
    cp: GitlabReviewControlPlane,
    ref: LeaseRef,
    op: CodeReviewOperation
  ): Promise<'returned' | 'started' | 'deferred'> {
    try {
      await cp.operate(
        { op: 'return-unused', attemptId: ref.attemptId, fence: ref.fence, recordId: op.recordId },
        ref.orgId
      )
      await this.clearOperation(ref, op.recordId)
      return 'returned'
    } catch (err) {
      // A permanent refusal means the record moved on without this daemon; evidence decides.
      if ((err as { retryable?: unknown }).retryable === false) return 'started'
      this.warn(`gitlab review: unused permit return deferred (${err instanceof Error ? err.message : err})`)
      return 'deferred'
    }
  }

  /**
   * Rebuild the frames a restart can owe WITHOUT provider evidence: an unstarted permit is
   * returned, and a classified attempt whose result never became durable is re-owed. An
   * operation that did start needs a marker read, so it waits for the turn's own replay.
   */
  async recoverTurn(turn: GitlabReviewTurn): Promise<void> {
    const attemptRecord = turn.hook.codeReview
    const cp = this.deps.cp()
    if (!attemptRecord || !cp || !cp.supportsReview()) return
    const fence = attemptRecord.fence
    const orgId = this.deps.orgForAgent(turn.agentId)
    if (fence) {
      const ref: LeaseRef = { turn, attemptId: attemptRecord.attemptId, fence, ...(orgId ? { orgId } : {}) }
      for (const op of [...(attemptRecord.operations ?? [])]) {
        // An unstarted permit is handed back; a started one replays the outcome parked on it.
        if (op.phase === 'issued') {
          await this.returnUnused(cp, ref, op)
          continue
        }
        if (!op.outcome) continue
        if (await this.owe(cp, this.settleIntent(ref, op.recordId, op.outcome))) {
          await this.clearOperation(ref, op.recordId)
        }
      }
    }
    if (!attemptRecord.resultOwed || !attemptRecord.state) return
    const safe = await this.owe(cp, {
      intentId: `${attemptRecord.attemptId}:result`,
      daemonId: this.deps.daemonId() ?? '',
      attemptId: attemptRecord.attemptId,
      ...(orgId ? { orgId } : {}),
      kind: 'result',
      frame: JSON.stringify({
        hookId: turn.hookId,
        deliveryKey: turn.deliveryKey,
        attemptId: attemptRecord.attemptId,
        snapshot: turn.snapshot,
        provider: 'gitlab',
        projectId: turn.projectId,
        mergeRequestIid: turn.mergeRequestIid,
        event: attemptRecord.event,
        verdict: attemptRecord.verdict,
        headSha: attemptRecord.headSha,
        state: attemptRecord.state,
        ...(attemptRecord.externalIds?.length ? { externalIds: attemptRecord.externalIds } : {})
      } satisfies CodeHostReviewResultReport),
      attempts: 0
    })
    if (safe) await this.clearResultOwed(turn)
  }

  /** A draft create is proven by its marker; a draft delete is proven by the absence it asked for. */
  private classifyDraftOperation(
    op: CodeReviewOperation,
    marked: Map<number, string>,
    attempt: Attempt
  ): CodeHostReviewOpOutcome {
    if (op.kind === 'draft_create') {
      const draftId = op.draftOrdinal === undefined ? undefined : marked.get(op.draftOrdinal)
      if (draftId) {
        attempt.drafts.set(op.draftOrdinal!, draftId)
        return { kind: 'deterministic', status: 201, externalId: draftId }
      }
      return { kind: 'deterministic', status: 422, code: 'draft_absent' }
    }
    const draftId = op.target.split('/').at(-1) ?? ''
    const present = [...marked.values()].includes(draftId)
    if (present) return { kind: 'deterministic', status: 422, code: 'draft_present' }
    // Naming the target is what upgrades a record this delete may have left ambiguous.
    return { kind: 'deterministic', status: 204, ...(idOf(draftId) ? { externalId: draftId } : {}) }
  }

  /** RECORD-FIRST: the coordinates of the one permitted request, before it is permitted. */
  private async noteOperation(attempt: Attempt, op: CodeReviewOperation): Promise<void> {
    const attemptRecord = attempt.turn.hook.codeReview
    if (!attemptRecord) return
    attemptRecord.ordinals = Object.fromEntries(attempt.ordinals)
    attemptRecord.operations = [...(attemptRecord.operations ?? []).filter((e) => e.recordId !== op.recordId), op]
    await attempt.turn.persist(true)
  }

  /** Flip the local phase once the control plane acknowledged the start transition. */
  private async markOperationStarted(attempt: Attempt, recordId: string): Promise<void> {
    const op = attempt.turn.hook.codeReview?.operations?.find((entry) => entry.recordId === recordId)
    if (!op || op.phase === 'started') return
    op.phase = 'started'
    await attempt.turn.persist(true)
  }

  /** Settled, so the coordinates are no longer owed. A lost removal costs one idempotent re-settle. */
  private async clearOperation(ref: LeaseRef, recordId: string): Promise<void> {
    const attemptRecord = ref.turn.hook.codeReview
    if (!attemptRecord?.operations) return
    attemptRecord.operations = attemptRecord.operations.filter((op) => op.recordId !== recordId)
    await ref.turn.persist().catch(() => undefined)
  }

  /** §15.1 orphan recovery, run while holding the lease and before any create. */
  private async reconcileDrafts(
    cp: GitlabReviewControlPlane,
    attempt: Attempt
  ): Promise<GitlabReviewOutcome | undefined> {
    const { turn } = attempt
    const pending = draftNotes(await this.get(attempt, this.mrPath(turn, '/draft_notes')))
    const stale: string[] = []
    for (const draft of pending) {
      const marker = attempt.signer.read(draft.note, turn.expectedHeadSha)
      // Unmarked, invalid, or unverifiable: nothing proves what it is, so fail closed.
      if (!marker) return this.settle(cp, attempt, 'review_reconciliation_required')
      if (marker.attemptId === attempt.attemptId.toLowerCase()) {
        attempt.drafts.set(marker.ordinal, draft.id)
        continue
      }
      // The grant certifies every prior attempt here was classified, so a signed foreign draft is expired (§15.1).
      stale.push(draft.id)
    }
    for (const draftId of stale) {
      const deleted = await this.deleteDraft(cp, attempt, draftId)
      if (!deleted) return this.settle(cp, attempt, 'review_reconciliation_required')
    }
    return undefined
  }

  /** Delete one stale draft, with the read-after-ambiguous-delete §15.1 requires. */
  private async deleteDraft(cp: GitlabReviewControlPlane, attempt: Attempt, draftId: string): Promise<boolean> {
    const path = this.mrPath(attempt.turn, `/draft_notes/${draftId}`)
    const outcome = await this.mutate(cp, attempt, 'draft_delete', 'DELETE', path, undefined)
    if (outcome.kind === 'sent') return true
    // A 404 is the same proven absence the delete was asking for.
    if (outcome.kind === 'rejected') return outcome.status === 404
    const remaining = await this.listDraftIds(attempt).catch(() => undefined)
    if (remaining === undefined || remaining.has(draftId)) return false
    // Read-after-ambiguous-delete proved the absence, so the record is upgraded, not left ambiguous.
    await this.upgradeAmbiguous(cp, attempt, outcome.recordId, draftId, 204)
    return true
  }

  private async deleteAttemptDrafts(cp: GitlabReviewControlPlane, attempt: Attempt): Promise<void> {
    for (const draftId of [...attempt.drafts.values()]) {
      await this.deleteDraft(cp, attempt, draftId).catch(() => false)
    }
    attempt.drafts.clear()
  }

  /** §15 step 8: one regular summary draft plus one diff draft per inline comment. */
  private async createDrafts(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    facts: MergeRequestFacts
  ): Promise<GitlabReviewOutcome | undefined> {
    const { turn, req } = attempt
    const attribution = await this.deps.attribution?.(turn)
    const bodies: Array<{ ordinal: number; note: string; position?: Record<string, unknown> }> = []
    if (!attempt.drafts.has(0)) {
      bodies.push({
        ordinal: 0,
        note: this.render(req.body, attribution, attempt.signer.mint(attempt.attemptId, 0, turn.expectedHeadSha))
      })
    }
    ;(req.comments ?? []).forEach((comment, index) => {
      const ordinal = index + 1
      if (attempt.drafts.has(ordinal)) return
      bodies.push({
        ordinal,
        note: `${ReviewMarkerSigner.neutralize(comment.body)}\n\n${attempt.signer.mint(attempt.attemptId, ordinal, turn.expectedHeadSha)}`,
        position: diffPosition(comment, facts)
      })
    })
    for (const draft of bodies) {
      const outcome = await this.mutate(
        cp,
        attempt,
        'draft_create',
        'POST',
        this.mrPath(turn, '/draft_notes'),
        { note: draft.note, ...(draft.position ? { position: draft.position } : {}) },
        draft.ordinal
      )
      if (outcome.kind === 'rejected') {
        await this.deleteAttemptDrafts(cp, attempt)
        return this.settle(cp, attempt, 'not_submitted')
      }
      if (outcome.kind === 'ambiguous') {
        // A draft is not a public effect: re-read by marker instead of retrying the POST.
        const recovered = await this.findDraftByOrdinal(attempt, draft.ordinal)
        if (!recovered) return this.settle(cp, attempt, 'review_reconciliation_required')
        await this.upgradeAmbiguous(cp, attempt, outcome.recordId, recovered, 201)
        attempt.drafts.set(draft.ordinal, recovered)
        continue
      }
      const draftId = idOf(record(outcome.parsed).id)
      if (!draftId) return this.settle(cp, attempt, 'review_reconciliation_required')
      attempt.drafts.set(draft.ordinal, draftId)
    }
    return undefined
  }

  private async findDraftByOrdinal(attempt: Attempt, ordinal: number): Promise<string | undefined> {
    const pending = draftNotes(await this.get(attempt, this.mrPath(attempt.turn, '/draft_notes')).catch(() => []))
    for (const draft of pending) {
      const marker = attempt.signer.read(draft.note, attempt.turn.expectedHeadSha)
      if (marker?.attemptId === attempt.attemptId.toLowerCase() && marker.ordinal === ordinal) return draft.id
    }
    return undefined
  }

  private async listDraftIds(attempt: Attempt): Promise<Set<string>> {
    const pending = draftNotes(await this.get(attempt, this.mrPath(attempt.turn, '/draft_notes')))
    return new Set(pending.map((draft) => draft.id))
  }

  /** §15 step 9/11: every pending draft carries this attempt's marker and the ordinal set is exact. */
  private async draftSetIsExact(attempt: Attempt): Promise<boolean> {
    const pending = draftNotes(
      await this.get(attempt, this.mrPath(attempt.turn, '/draft_notes')).catch(() => undefined)
    )
    if (pending.length !== attempt.drafts.size) return false
    const seen = new Set<number>()
    for (const draft of pending) {
      const marker = attempt.signer.read(draft.note, attempt.turn.expectedHeadSha)
      if (!marker || marker.attemptId !== attempt.attemptId.toLowerCase()) return false
      if (attempt.drafts.get(marker.ordinal) !== draft.id) return false
      seen.add(marker.ordinal)
    }
    return seen.size === attempt.drafts.size
  }

  private async readReviewer(attempt: Attempt): Promise<ReviewerRecord | undefined> {
    const rows = reviewerRecords(await this.get(attempt, this.mrPath(attempt.turn, '/reviewers')))
    return rows.find((row) => row.userId === attempt.serviceAccountUserId)
  }

  /** §15 step 11 + §15.2: ONE bulk publish, then marker-first recovery when it is unknown. */
  private async bulkPublish(
    cp: GitlabReviewControlPlane,
    attempt: Attempt
  ): Promise<'published' | 'not_submitted' | 'ambiguous_locked'> {
    const outcome = await this.mutate(
      cp,
      attempt,
      'bulk_publish',
      'POST',
      this.mrPath(attempt.turn, '/draft_notes/bulk_publish'),
      attempt.req.event === 'REQUEST_CHANGES' ? { reviewer_state: 'requested_changes' } : {}
    )
    if (outcome.kind === 'rejected') return 'not_submitted'
    if (outcome.kind === 'sent') {
      const note = await this.findSummaryNote(attempt).catch(() => undefined)
      if (note) attempt.externalIds.push({ kind: 'note', externalId: note })
      return 'published'
    }
    // §15.2: retain ownership and search the merge request for THIS attempt's summary marker.
    const deadline = this.now() + (this.deps.ambiguousWindowMs ?? DEFAULT_AMBIGUOUS_WINDOW_MS)
    for (;;) {
      const note = await this.findSummaryNote(attempt).catch(() => undefined)
      if (note) {
        attempt.externalIds.push({ kind: 'note', externalId: note })
        await this.upgradeAmbiguous(cp, attempt, outcome.recordId, note, 201)
        return 'published'
      }
      if (this.now() >= deadline) break
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
    return 'ambiguous_locked'
  }

  private async findSummaryNote(attempt: Attempt): Promise<string | undefined> {
    for (let page = 1; page <= MAX_NOTE_PAGES; page += 1) {
      const parsed = await this.get(
        attempt,
        this.mrPath(attempt.turn, '/notes'),
        `per_page=${NOTES_PER_PAGE}&page=${page}`
      )
      if (!Array.isArray(parsed)) return undefined
      for (const row of parsed) {
        const note = record(row)
        const marker = attempt.signer.read(text(note.body), attempt.turn.expectedHeadSha)
        if (marker?.attemptId === attempt.attemptId.toLowerCase() && marker.ordinal === 0) return idOf(note.id)
      }
      if (parsed.length < NOTES_PER_PAGE) return undefined
    }
    return undefined
  }

  /** §15 step 12 / §15.2: publication success alone never proves the recorded state. */
  private async classifyPostcondition(
    attempt: Attempt,
    before: ReviewerRecord | undefined
  ): Promise<CodeHostReviewState> {
    let after: ReviewerRecord | undefined
    try {
      after = await this.readReviewer(attempt)
    } catch {
      return attempt.req.event === 'REQUEST_CHANGES' ? 'requested_changes_state_ambiguous' : 'review_state_not_recorded'
    }
    if (attempt.req.event !== 'REQUEST_CHANGES') {
      if (before === undefined && after === undefined) return 'submitted'
      if (before !== undefined && after !== undefined && before.state === after.state) return 'submitted'
      return 'review_state_changed_unexpectedly'
    }
    if (after?.state === 'requested_changes') return 'submitted'
    // Reviewer absence is NOT evidence of failure: GitLab persists the block separately.
    const status = await this.stableMergeStatus(attempt, true)
    if (status === 'requested_changes') return 'requested_changes_block_observed'
    return 'requested_changes_state_ambiguous'
  }

  /** Read `detailed_merge_status` after it leaves its unstable values, optionally forcing a recheck. */
  private async stableMergeStatus(attempt: Attempt, recheck: boolean): Promise<string | undefined> {
    const deadline = this.now() + (this.deps.mergeStatusWindowMs ?? DEFAULT_MERGE_STATUS_WINDOW_MS)
    for (;;) {
      const facts = mergeRequestFacts(
        await this.get(
          attempt,
          this.mrPath(attempt.turn),
          recheck ? 'with_merge_status_recheck=true' : undefined
        ).catch(() => undefined)
      )
      const status = facts?.detailedMergeStatus
      if (status !== undefined && !UNSTABLE_MERGE_STATUS.has(status)) return status
      if (this.now() >= deadline) return undefined
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
  }

  /** §15 step 13: the SHA-fenced approval, and its readback. A failure here never falls back. */
  private async approve(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    facts: MergeRequestFacts
  ): Promise<CodeHostReviewState> {
    const status = await this.stableMergeStatus(attempt, false)
    if (status === undefined) return 'approval_not_recorded'
    if (!(await this.diffIsReady(attempt))) return 'approval_not_recorded'
    const outcome = await this.mutate(cp, attempt, 'approval', 'POST', this.mrPath(attempt.turn, '/approve'), {
      sha: attempt.turn.expectedHeadSha
    })
    if (outcome.kind === 'rejected') return 'approval_not_recorded'
    if (outcome.kind === 'sent' && this.approvalReadback(outcome.parsed, attempt)) {
      const approvalId = facts.numericId ?? idOf(record(outcome.parsed).id)
      if (approvalId) attempt.externalIds.push({ kind: 'approval', externalId: approvalId })
      return 'submitted'
    }
    // Ambiguous or unconvincing: one read-only readback decides, and nothing retries.
    const readback = await this.get(attempt, this.mrPath(attempt.turn, '/approvals')).catch(() => undefined)
    if (!this.approvalReadback(readback, attempt)) return 'approval_not_recorded'
    // An upgrade must name an object, so the readback's own id backs up the merge request's.
    const approvalId = facts.numericId ?? idOf(record(readback).id)
    if (approvalId) attempt.externalIds.push({ kind: 'approval', externalId: approvalId })
    if (outcome.kind === 'ambiguous') {
      if (!approvalId) return 'approval_not_recorded'
      // Positive identification of an ambiguous request, per §15.1's fourth condition.
      await this.upgradeAmbiguous(cp, attempt, outcome.recordId, approvalId, 201)
    }
    return 'submitted'
  }

  /** The approval endpoint needs a settled diff; a null `patch_id_sha` means GitLab is still computing. */
  private async diffIsReady(attempt: Attempt): Promise<boolean> {
    const deadline = this.now() + (this.deps.mergeStatusWindowMs ?? DEFAULT_MERGE_STATUS_WINDOW_MS)
    for (;;) {
      const versions = await this.get(attempt, this.mrPath(attempt.turn, '/versions')).catch(() => undefined)
      const latest = Array.isArray(versions) ? record(versions[0]) : {}
      if (text(latest.patch_id_sha)) return true
      if (this.now() >= deadline) return false
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
  }

  private approvalReadback(parsed: unknown, attempt: Attempt): boolean {
    const body = record(parsed)
    const sha = text(body.sha)
    if (sha !== undefined && sha !== attempt.turn.expectedHeadSha) return false
    const approvers = Array.isArray(body.approved_by) ? body.approved_by : []
    return approvers.some((row) => idOf(record(record(row).user).id) === attempt.serviceAccountUserId)
  }

  /**
   * One provider mutation under one single-use operation record: issue → start →
   * one outbound request → settle. A definite 401/403 buys exactly ONE lease
   * refresh, and the retry runs under a NEW record — one record permits one request.
   */
  private async mutate(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    kind: CodeHostReviewOpKind,
    method: CodeHostReviewOpMethod,
    target: string,
    body: Record<string, unknown> | undefined,
    draftOrdinal?: number
  ): Promise<
    | { kind: 'sent'; status: number; parsed: unknown; recordId: string }
    | { kind: 'rejected'; status: number; recordId: string }
    | { kind: 'ambiguous'; recordId: string }
  > {
    for (let attemptNo = 0; attemptNo < 2; attemptNo += 1) {
      const ordinal = attempt.ordinals.get(kind) ?? 0
      attempt.ordinals.set(kind, ordinal + 1)
      const issued = await cp.operate(
        { op: 'issue', attemptId: attempt.attemptId, fence: attempt.fence, kind, method, target, ordinal },
        attempt.orgId
      )
      const startToken = (this.deps.newStartToken ?? randomUUID)()
      // Durable BEFORE the request is permitted, so a crash between them is reconcilable.
      await this.noteOperation(attempt, {
        recordId: issued.recordId,
        startToken,
        kind,
        ordinal,
        target,
        phase: 'issued',
        ...(draftOrdinal !== undefined ? { draftOrdinal } : {})
      })
      await this.startOperation(cp, attempt, issued.recordId, startToken)
      // Only now may a replay assume a request was permitted under this record.
      await this.markOperationStarted(attempt, issued.recordId)
      let result: SendResult
      try {
        result = await this.send(method, target, undefined, body, attempt.token, attempt.turn)
      } catch (err) {
        if (err instanceof AmbiguousSend) {
          await this.settleAndClear(cp, attempt, issued.recordId, { kind: 'ambiguous', code: err.code }, true)
          return { kind: 'ambiguous', recordId: issued.recordId }
        }
        throw err
      }
      const authRejected = result.status === 401 || result.status === 403
      const externalId = idOf(record(result.parsed).id)
      await this.settleAndClear(cp, attempt, issued.recordId, {
        kind: 'deterministic',
        status: result.status,
        ...(externalId ? { externalId } : {})
      })
      if (result.status < 300) {
        return { kind: 'sent', status: result.status, parsed: result.parsed, recordId: issued.recordId }
      }
      if (!authRejected || attemptNo === 1) {
        return { kind: 'rejected', status: result.status, recordId: issued.recordId }
      }
      this.deps.invalidateToken(attempt.turn, attempt.token)
      attempt.token = await this.deps.token(attempt.turn)
    }
    throw new Error('GitLab review mutation exhausted its single authorization refresh')
  }

  /** `startToken` names the one intended request, so a lost reply is retransmitted with the SAME token. */
  private async startOperation(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    recordId: string,
    startToken: string
  ): Promise<void> {
    let last: unknown
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        await cp.operate(
          { op: 'start', attemptId: attempt.attemptId, fence: attempt.fence, recordId, startToken },
          attempt.orgId
        )
        return
      } catch (err) {
        last = err
      }
    }
    throw last instanceof Error ? last : new Error('the control plane refused to start the review operation')
  }

  /** The settle is owed durably first: a lost ack must never strand a started record.
   *  Returns whether the operation's own coordinates may now be forgotten. */
  private async settleOperation(
    cp: GitlabReviewControlPlane,
    ref: LeaseRef,
    recordId: string,
    outcome: CodeHostReviewOpOutcome
  ): Promise<SettleDisposition> {
    const safe = await this.owe(cp, this.settleIntent(ref, recordId, outcome))
    if (safe) return 'safe'
    // Neither written nor acknowledged: the coordinates become the replay source instead.
    return (await this.persistSettleOutcome(ref, recordId, outcome)) ? 'replayable' : 'blocked'
  }

  /** The one settle frame, built the same way whether it is owed now or replayed later. */
  private settleIntent(ref: LeaseRef, recordId: string, outcome: CodeHostReviewOpOutcome): ReviewIntentRow {
    return {
      intentId: `${ref.attemptId}:op:${recordId}`,
      daemonId: this.deps.daemonId() ?? '',
      attemptId: ref.attemptId,
      ...(ref.orgId ? { orgId: ref.orgId } : {}),
      kind: 'operation',
      frame: JSON.stringify({
        op: 'settle',
        attemptId: ref.attemptId,
        fence: ref.fence,
        recordId,
        outcome
      } satisfies CodeHostReviewOpRequest),
      attempts: 0
    }
  }

  /** Park the exact outcome on the surviving coordinates so a restart can replay it blind. */
  private async persistSettleOutcome(
    ref: LeaseRef,
    recordId: string,
    outcome: CodeHostReviewOpOutcome
  ): Promise<boolean> {
    const op = ref.turn.hook.codeReview?.operations?.find((entry) => entry.recordId === recordId)
    if (!op) return false
    op.outcome = outcome
    try {
      await ref.turn.persist(true)
      return true
    } catch (err) {
      this.warn(`gitlab review: settle outcome could not be parked (${err instanceof Error ? err.message : err})`)
      return false
    }
  }

  /** Owe the settle, then forget the coordinates only once something can replay it. */
  private async settleAndClear(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    recordId: string,
    outcome: CodeHostReviewOpOutcome,
    // An `ambiguous` record stays non-terminal until an upgrade names its object, so its
    // coordinates are kept as the replay source for exactly that upgrade (§15.1).
    retain = false
  ): Promise<void> {
    const disposition = await this.settleOperation(cp, attempt, recordId, outcome)
    if (disposition === 'safe' && !retain) await this.clearOperation(attempt, recordId)
    if (disposition === 'blocked') attempt.settleBlocked = true
  }

  /**
   * Upgrade a positively identified ambiguous record to `settled` by naming the provider
   * object. The control plane keeps an ambiguous record non-terminal until exactly this
   * frame arrives, and retains the publication lease while one remains.
   */
  private async upgradeAmbiguous(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    recordId: string,
    externalId: string,
    status: number
  ): Promise<void> {
    await this.settleAndClear(cp, attempt, recordId, { kind: 'deterministic', status, externalId })
  }

  /** Record the terminal classification, releasing (or locking) the publication lease. */
  private async settle(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    state: CodeHostReviewState
  ): Promise<GitlabReviewOutcome> {
    const externalIds = codeHostReviewPublicEffect(state) === 'absent' ? [] : attempt.externalIds
    // No terminal result while a started operation has no durable replay source: the control
    // plane would record the outcome and keep the lease on a record nothing can settle (§15.1).
    if (attempt.settleBlocked) {
      this.arm()
      throw new ResultWithheld()
    }
    // The durable single-writer gate first: only a PROVEN no-effect attempt may be followed
    // by the ordinary note, and a replay must read the same verdict this turn reached (§15.2).
    // The same record is the result frame's upstream entry, so it also marks it owed.
    await this.recordOutcome(attempt.turn, state, externalIds, true)
    const safe = await this.owe(cp, {
      intentId: `${attempt.attemptId}:result`,
      daemonId: this.deps.daemonId() ?? '',
      attemptId: attempt.attemptId,
      ...(attempt.orgId ? { orgId: attempt.orgId } : {}),
      kind: 'result',
      frame: JSON.stringify({
        hookId: attempt.turn.hookId,
        deliveryKey: attempt.turn.deliveryKey,
        attemptId: attempt.attemptId,
        snapshot: attempt.turn.snapshot,
        provider: 'gitlab',
        projectId: attempt.turn.projectId,
        mergeRequestIid: attempt.turn.mergeRequestIid,
        event: attempt.req.event,
        verdict: attempt.req.verdict,
        headSha: attempt.turn.expectedHeadSha,
        state,
        ...(externalIds.length ? { externalIds } : {})
      } satisfies CodeHostReviewResultReport),
      attempts: 0
    })
    if (safe) await this.clearResultOwed(attempt.turn)
    return {
      provider: 'gitlab',
      state,
      event: attempt.req.event,
      verdict: attempt.req.verdict,
      message: OUTCOME_SENTENCE[state],
      ...(externalIds.length ? { externalIds } : {})
    }
  }

  /** A typed CP refusal is an ordinary control outcome the model must read precisely. */
  private async refused(
    turn: GitlabReviewTurn,
    req: SubmitCodeReviewReq,
    answer: Extract<CodeHostReviewAuthorized, { authorized: false }>
  ): Promise<GitlabReviewOutcome> {
    const state: CodeHostReviewState =
      answer.reason === 'reviewer_assignment_required'
        ? 'reviewer_assignment_required'
        : answer.reason === 'ambiguous_locked'
          ? 'ambiguous_locked'
          : 'not_submitted'
    const detail =
      answer.reason === 'lease_held'
        ? ' Another review attempt currently owns publication on this merge request.'
        : answer.reason === 'head_changed'
          ? ' The merge request head changed while this turn was running.'
          : answer.reason === 'policy_denied'
            ? " This hook's review policy does not permit that review event."
            : answer.reason === 'binding_unavailable'
              ? ' This project has no ready GitLab binding to publish as.'
              : ''
    // No lease was granted, so nothing is owed to the control plane — but the durable
    // gate still has to learn whether the ordinary note may follow this attempt.
    await this.recordOutcome(turn, state, [], false)
    return {
      provider: 'gitlab',
      state,
      event: req.event,
      verdict: req.verdict,
      message: `${OUTCOME_SENTENCE[state]}${detail}`
    }
  }

  /** Stamp the durable attempt with its classification; the in-memory copy guards this process. */
  private async recordOutcome(
    turn: GitlabReviewTurn,
    state: CodeHostReviewState,
    externalIds: CodeHostReviewExternalRef[],
    owed: boolean
  ): Promise<void> {
    const attemptRecord = turn.hook.codeReview
    if (!attemptRecord) return
    attemptRecord.state = state
    if (owed) attemptRecord.resultOwed = true
    else delete attemptRecord.resultOwed
    if (externalIds.length) attemptRecord.externalIds = externalIds
    else delete attemptRecord.externalIds
    try {
      await turn.persist(true)
    } catch (err) {
      // A stateless durable attempt reads as unknown, which blocks the fallback — the safe direction.
      this.warn(`gitlab review: outcome persistence deferred (${err instanceof Error ? err.message : err})`)
    }
  }

  /** The result frame is durable or acknowledged, so the attempt no longer owes it. */
  private async clearResultOwed(turn: GitlabReviewTurn): Promise<void> {
    if (!turn.hook.codeReview?.resultOwed) return
    delete turn.hook.codeReview.resultOwed
    await turn.persist().catch(() => undefined)
  }

  /**
   * Owe one control-plane frame, then try to deliver it.
   *
   * The row lands BEFORE the send, so a crash in between still replays it; both frames
   * are idempotent REQs, so replaying one the control plane already took is a no-op. A
   * permanently refused frame is dropped rather than replayed forever (§15.1).
   */
  /**
   * Owe one control-plane frame. Returns whether the chain may move on: true once the
   * frame is durably recorded OR the control plane has answered it. While it is false the
   * caller must KEEP its own upstream record, because that record is the only thing a
   * restart could rebuild this frame from (§15.1).
   */
  private async owe(cp: GitlabReviewControlPlane, row: ReviewIntentRow): Promise<boolean> {
    const durable = await this.persistIntent(row)
    if (!durable) this.unwritten.set(row.intentId, row)
    const answer = await this.deliver(cp, row)
    if (answer === 'retry') {
      this.arm()
      return durable
    }
    await this.forget(row.intentId)
    return true
  }

  /** Bounded local-write retry; false means the row is only in memory for now. */
  private async persistIntent(row: ReviewIntentRow): Promise<boolean> {
    for (let tries = 0; tries < 3; tries += 1) {
      try {
        await this.deps.store.recordReviewIntent(row, this.now())
        this.unwritten.delete(row.intentId)
        return true
      } catch (err) {
        if (tries === 2) {
          this.warn(`gitlab review: owed frame write deferred (${err instanceof Error ? err.message : err})`)
        }
      }
    }
    return false
  }

  /** Send one owed frame verbatim. `retry` keeps it; anything else is finished with. */
  private async deliver(cp: GitlabReviewControlPlane, row: ReviewIntentRow): Promise<'sent' | 'retry' | 'refused'> {
    try {
      if (row.kind === 'operation') await cp.operate(JSON.parse(row.frame) as CodeHostReviewOpRequest, row.orgId)
      else await cp.report(JSON.parse(row.frame) as CodeHostReviewResultReport, row.orgId)
      return 'sent'
    } catch (err) {
      // A control plane that answered `retryable: false` has decided; replaying cannot change it.
      const permanent = (err as { retryable?: unknown }).retryable === false
      this.warn(
        `gitlab review: owed ${row.kind} frame ${permanent ? 'refused' : 'deferred'} (${err instanceof Error ? err.message : err})`
      )
      return permanent ? 'refused' : 'retry'
    }
  }

  private async forget(intentId: string): Promise<void> {
    this.unwritten.delete(intentId)
    try {
      await this.deps.store.clearReviewIntent(intentId)
    } catch (err) {
      // The frame is delivered; a stale row only costs one idempotent replay later.
      this.warn(`gitlab review: owed frame could not be cleared (${err instanceof Error ? err.message : err})`)
    }
  }

  /**
   * Replay everything this daemon identity still owes the control plane (§15.1). Runs at
   * startup and on reconnect, and re-arms itself on backoff while anything remains, so a
   * dropped ack cannot leave an operation record started or an outcome unreconciled.
   */
  async reconcilePending(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    // Read BEFORE the scan: work that arms after this point owns the timer, not this sweep.
    const armedThrough = this.armGeneration
    try {
      const remaining = await this.sweepOnce()
      if (remaining === undefined || remaining > 0) this.arm()
      else this.disarm(armedThrough)
    } finally {
      this.sweeping = false
    }
  }

  /**
   * One pass over the owed frames; the count still outstanding after it, or undefined.
   *
   * The store answers one PAGE at a time, so the pass drains successive pages until it
   * sees nothing new — a page of acked rows must never be mistaken for an empty store.
   */
  private async sweepOnce(): Promise<number | undefined> {
    const daemonId = this.deps.daemonId()
    // Before the control plane adopts an id there is no identity to recover rows under.
    if (!daemonId) return 0
    const cp = this.deps.cp()
    if (!cp) return undefined
    const seen = new Set<string>()
    let outstanding = 0
    let unreadable = false
    // Hitting the cap proves nothing about what is left, so the sweep stays armed.
    let capped = true
    for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
      let rows: ReviewIntentRow[]
      try {
        rows = await this.deps.store.listReviewIntents(daemonId)
      } catch (err) {
        this.warn(`gitlab review: owed frame scan failed (${err instanceof Error ? err.message : err})`)
        unreadable = true
        break
      }
      const fresh = rows.filter((row) => !seen.has(row.intentId))
      if (fresh.length === 0) {
        capped = false
        break
      }
      for (const row of fresh) {
        seen.add(row.intentId)
        outstanding += await this.replay(cp, row)
      }
    }
    // Frames whose durable write never landed live only here; they are owed all the same.
    for (const row of [...this.unwritten.values()]) {
      if (seen.has(row.intentId)) continue
      seen.add(row.intentId)
      await this.persistIntent(row)
      outstanding += await this.replay(cp, row)
    }
    return unreadable || capped ? undefined : outstanding
  }

  /** Deliver one owed frame; 1 when it is still owed afterwards, 0 when it is finished with. */
  private async replay(cp: GitlabReviewControlPlane, row: ReviewIntentRow): Promise<number> {
    const answer = await this.deliver(cp, row)
    if (answer !== 'retry') {
      await this.forget(row.intentId)
      return 0
    }
    const next = { ...row, attempts: row.attempts + 1 }
    if (this.unwritten.has(row.intentId)) this.unwritten.set(row.intentId, next)
    await this.deps.store.recordReviewIntent(next, this.now()).catch(() => undefined)
    return 1
  }

  /** Arm the next resweep on exponential backoff, capped. An armed timer is never restarted early. */
  private arm(): void {
    if (this.stopped) return
    this.armGeneration += 1
    if (this.resweepHandle !== undefined) return
    const base = this.deps.resweepBaseMs ?? DEFAULT_RESWEEP_BASE_MS
    const cap = this.deps.resweepCapMs ?? DEFAULT_RESWEEP_CAP_MS
    const delay = Math.min(base * 2 ** Math.min(this.resweepAttempt, 16), cap)
    this.resweepAttempt += 1
    try {
      this.resweepHandle = this.sched.setTimeout(() => {
        this.resweepHandle = undefined
        void this.reconcilePending()
      }, delay)
    } catch (err) {
      this.warn(`gitlab review: resweep scheduling failed (${err instanceof Error ? err.message : err})`)
    }
  }

  /** Go quiet — but only if nothing armed after the sweep that decided there was no work left. */
  private disarm(armedThrough: number): void {
    if (this.armGeneration !== armedThrough) return
    this.resweepAttempt = 0
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.resweepHandle === undefined) return
    try {
      this.sched.clearTimeout(this.resweepHandle)
    } catch {
      // A failed clear only leaves a sweep that finds nothing to do.
    }
    this.resweepHandle = undefined
  }

  private warn(message: string): void {
    try {
      this.deps.log.warn(message)
    } catch {
      // A broken logger must not break a settlement path.
    }
  }

  private render(body: string, attribution: GithubCommentAttribution | undefined, marker: string): string {
    return appendGithubMarkdownChrome(
      ReviewMarkerSigner.neutralize(body),
      `${githubAttributionFooter(attribution)}\n\n${marker}`
    )
  }

  private mrPath(turn: GitlabReviewTurn, suffix = ''): string {
    return `/projects/${turn.projectId}/merge_requests/${turn.mergeRequestIid}${suffix}`
  }

  private async get(session: Session, path: string, query?: string): Promise<unknown> {
    for (let tries = 0; tries < 2; tries += 1) {
      let result: SendResult
      try {
        result = await this.send('GET', path, query, undefined, session.token, session.turn)
      } catch {
        throw new Error(`GitLab GET ${path} did not complete`)
      }
      if (result.status < 300) return result.parsed
      if ((result.status !== 401 && result.status !== 403) || tries === 1) {
        throw new Error(`GitLab GET ${path} failed with ${result.status}`)
      }
      this.deps.invalidateToken(session.turn, session.token)
      session.token = await this.deps.token(session.turn)
    }
    throw new Error(`GitLab GET ${path} failed`)
  }

  private async send(
    method: 'GET' | CodeHostReviewOpMethod,
    path: string,
    query: string | undefined,
    body: Record<string, unknown> | undefined,
    token: string,
    turn: GitlabReviewTurn
  ): Promise<SendResult> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const url = `${this.deps.apiBaseUrl(turn)}${path}${query ? `?${query}` : ''}`
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers: {
          'private-token': token,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      })
    } catch {
      // Nothing was received, so a mutation's effect is unknown; GETs treat it the same.
      throw new AmbiguousSend('transport_failed')
    }
    // A 5xx may or may not have applied the effect; only a received 4xx is definite.
    if (response.status >= 500) throw new AmbiguousSend(`upstream_${response.status}`)
    const raw = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = raw ? parseGitlabJson(raw) : undefined
    } catch {
      parsed = undefined
    }
    return { status: response.status, parsed }
  }
}

/** The exact diff refs one inline comment is anchored to (§15 step 8). */
function diffPosition(
  comment: NonNullable<SubmitCodeReviewReq['comments']>[number],
  facts: MergeRequestFacts
): Record<string, unknown> {
  const lineKey = comment.side === 'LEFT' ? 'old_line' : 'new_line'
  const startKey = comment.startSide === 'LEFT' ? 'old_line' : 'new_line'
  return {
    position_type: 'text',
    base_sha: facts.baseSha ?? '',
    start_sha: facts.startSha ?? facts.baseSha ?? '',
    head_sha: facts.headSha,
    old_path: comment.path,
    new_path: comment.path,
    [lineKey]: comment.line,
    ...(comment.startLine !== undefined
      ? {
          line_range: {
            start: { type: comment.startSide === 'LEFT' ? 'old' : 'new', [startKey]: comment.startLine },
            end: { type: comment.side === 'LEFT' ? 'old' : 'new', [lineKey]: comment.line }
          }
        }
      : {})
  }
}
