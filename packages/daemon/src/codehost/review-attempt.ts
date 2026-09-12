// Provider-neutral engine behind every formal code-host review adapter (gitlab §15–§15.2, gitea §10.3); bodies never reach the CP.
import { randomUUID } from 'node:crypto'
import { WireError } from '@agentconnect.md/connection'
import {
  codeHostReviewPublicEffect,
  type CodeHostProvider,
  type CodeHostReviewAuthorized,
  type CodeHostReviewExternalRef,
  type CodeHostReviewOpKind,
  type CodeHostReviewOpMethod,
  type CodeHostReviewOpOutcome,
  type CodeHostReviewOpRequest,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewResultReport,
  type CodeHostReviewState,
  type HookConfigSnapshot
} from '@agentconnect.md/protocol'
import { reviewPolicyAllows, type CodeReviewOperation, type HookDispatchContext } from '../github/hook-coords.js'
import type { GithubCommentAttribution, PosterScheduler } from '../github/poster.js'
import {
  validateCodeReviewInput,
  type CodeHostReviewAdapter,
  type CodeReviewEvent,
  type CodeReviewVerdict,
  type SubmitCodeReviewReq
} from './review-adapter.js'
import { parseCodeHostJson } from './json.js'
import { ReviewMarkerSigner } from './review-marker.js'
import {
  CodeHostReviewOutbox,
  type CodeHostReviewControlPlane,
  type ReviewIntentRow,
  type ReviewIntentStore
} from './review-outbox.js'

/** One authorized review turn; every field is trusted daemon state. */
export interface CodeHostReviewTurn {
  hookId: string
  agentId: string
  deliveryKey: string
  snapshot: HookConfigSnapshot
  /** Numeric repository/project id (decimal string) — the rename-stable match key. */
  repoId: string
  repoPath: string
  /** The number the provider addresses the subject by: a merge-request IID, a pull-request index. */
  subjectNumber: number
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

export interface CodeHostReviewAdapterDeps<Turn extends CodeHostReviewTurn> {
  cp: () => CodeHostReviewControlPlane | undefined
  orgForAgent: (agentId: string) => string | undefined
  /** The STABLE daemon identity owed frames are recovered under — never a process incarnation. */
  daemonId: () => string | undefined
  store: ReviewIntentStore
  /** The daemon-wide outbox; absent ⇒ this adapter runs one of its own over `store`. */
  outbox?: CodeHostReviewOutbox
  /** Restart-stable marker key; see the trust model on {@link ReviewMarkerSigner}. */
  markerKey: () => Promise<Buffer>
  /** The effect lease this provider publishes under; it never enters the agent environment. */
  token: (turn: Turn) => Promise<string>
  invalidateToken: (turn: Turn, token: string) => void
  attribution?: (turn: Turn) => Promise<GithubCommentAttribution | undefined>
  log: { warn: (message: string) => void }
  /** The instance's REST root for THIS turn's agent, resolved per turn. */
  apiBaseUrl: (turn: Turn) => string
  fetchImpl?: typeof fetch
  newAttemptId?: () => string
  newStartToken?: () => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** §15.2 bounded observation window for an ambiguous publication. */
  ambiguousWindowMs?: number
  pollIntervalMs?: number
  /** Timer seam for the owed-frame resweep; tests drive it, production uses real timers. */
  scheduler?: PosterScheduler
  resweepBaseMs?: number
  resweepCapMs?: number
}

/** The model-visible outcome: one normalized state plus a plain-English sentence. */
export interface CodeHostReviewOutcome {
  provider: CodeHostProvider
  state: CodeHostReviewState
  event: CodeReviewEvent
  verdict: CodeReviewVerdict
  message: string
  externalIds?: CodeHostReviewExternalRef[]
  /** The event actually published when it differs from the requested one (gitea-integration.md §10.3 self-review downgrade). */
  publishedEvent?: CodeReviewEvent
}

export const DEFAULT_REVIEW_TIMEOUT_MS = 20_000
export const DEFAULT_AMBIGUOUS_WINDOW_MS = 30_000
export const DEFAULT_POLL_INTERVAL_MS = 2_000

/** What a settle left behind: nothing, replayable coordinates, or no replay source at all. */
type SettleDisposition = 'safe' | 'replayable' | 'blocked'

/** The terminal result is withheld until every unsafe settle has a durable replay source. */
export class ResultWithheld extends Error {
  constructor() {
    super('the formal review outcome could not be made durable yet; the daemon will retry before reporting it')
    this.name = 'ResultWithheld'
  }
}

export class AmbiguousSend extends Error {
  constructor(
    readonly host: string,
    readonly code: string
  ) {
    super(`${host} review request outcome is unknown (${code})`)
    this.name = 'AmbiguousSend'
  }
}

export interface SendResult {
  status: number
  parsed: unknown
}

/** The turn plus its live effect token; the token is re-minted in place on a refresh. */
export interface ReviewSession<Turn extends CodeHostReviewTurn> {
  turn: Turn
  token: string
}

/** What a ledger frame needs to name itself — an in-flight attempt or a recovered record. */
export interface ReviewLeaseRef<Turn extends CodeHostReviewTurn> {
  turn: Turn
  attemptId: string
  fence: string
  orgId?: string
}

/** Everything one attempt carries between steps; a provider extends it with its own facts. */
export interface CodeHostReviewAttempt<Turn extends CodeHostReviewTurn> extends ReviewSession<Turn> {
  req: SubmitCodeReviewReq
  signer: ReviewMarkerSigner
  orgId?: string
  attemptId: string
  fence: string
  /** The provider user this effect token speaks as — what the lease must name (§15.1). */
  publisherUserId: string
  /** Per-kind monotonic operation-record counter; a retried mutation takes the next one. */
  ordinals: Map<CodeHostReviewOpKind, number>
  externalIds: CodeHostReviewExternalRef[]
  /** A settle this attempt owes has no durable replay source yet, so no result may be reported. */
  settleBlocked?: boolean
}

/** What a provider reads before the lease: who it publishes as, plus any authorization fact the CP fences on. */
export interface PreLeaseFacts {
  publisherUserId: string
  serviceAccountIsReviewer?: boolean
}

export type MutationOutcome =
  | { kind: 'sent'; status: number; parsed: unknown; recordId: string }
  | { kind: 'rejected'; status: number; parsed: unknown; recordId: string }
  | { kind: 'ambiguous'; recordId: string }

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** A big-int-safe numeric id as a decimal string; undefined when the value is not one. */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export abstract class CodeHostReviewAttemptAdapter<
  Turn extends CodeHostReviewTurn,
  Attempt extends CodeHostReviewAttempt<Turn>,
  Facts extends PreLeaseFacts
> implements CodeHostReviewAdapter {
  abstract readonly provider: CodeHostProvider
  /** How the host is named in model-visible errors (`GitLab`, `Gitea`). */
  protected abstract readonly hostLabel: string
  /** How the subject is named in model-visible errors (`merge-request`, `pull-request`). */
  protected abstract readonly subjectLabel: string

  protected readonly turns = new Map<string, Turn>()
  protected readonly now: () => number
  protected readonly sleep: (ms: number) => Promise<void>
  protected readonly outbox: CodeHostReviewOutbox
  private readonly ownsOutbox: boolean
  private signerPromise?: Promise<ReviewMarkerSigner>

  constructor(protected readonly deps: CodeHostReviewAdapterDeps<Turn>) {
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.ownsOutbox = deps.outbox === undefined
    this.outbox =
      deps.outbox ??
      new CodeHostReviewOutbox({
        cp: deps.cp,
        daemonId: deps.daemonId,
        store: deps.store,
        log: deps.log,
        ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
        ...(deps.resweepBaseMs !== undefined ? { resweepBaseMs: deps.resweepBaseMs } : {}),
        ...(deps.resweepCapMs !== undefined ? { resweepCapMs: deps.resweepCapMs } : {}),
        ...(deps.now ? { now: deps.now } : {})
      })
  }

  /** Drop the pending resweep so a shutting-down daemon leaves no timer behind. */
  stop(): void {
    if (this.ownsOutbox) this.outbox.stop()
  }

  /** Replay every frame this daemon still owes (§15.1); a shared outbox is swept by its owner. */
  reconcilePending(): Promise<void> {
    return this.outbox.reconcilePending()
  }

  /** The restart-stable signer, minted from the daemon store on first use. */
  protected markerSigner(): Promise<ReviewMarkerSigner> {
    this.signerPromise ??= this.deps.markerKey().then((key) => new ReviewMarkerSigner(key))
    return this.signerPromise
  }

  closeTurn(key: string, turn?: Turn): void {
    if (turn && this.turns.get(key) !== turn) return
    this.turns.delete(key)
  }

  owns(key: string, agentId: string): boolean {
    return this.turns.get(key)?.agentId === agentId
  }

  /** One English sentence per normalized state, so the tool result mirrors §15.2 exactly. */
  protected abstract outcomeSentence(state: CodeHostReviewState): string
  /** The sentence appended to a typed CP refusal, naming this provider's subject. */
  protected abstract refusalDetail(reason: CodeHostReviewRefusalReason): string
  /** The authentication header(s) this host takes the effect token in. */
  protected abstract authHeaders(token: string): Record<string, string>
  /** What the provider reads BEFORE the lease: the publishing identity and any fact the authorization fences on. */
  protected abstract preLeaseFacts(session: ReviewSession<Turn>, req: SubmitCodeReviewReq): Promise<Facts>
  /** Widen the engine's attempt with this provider's own facts. */
  protected abstract openAttempt(base: CodeHostReviewAttempt<Turn>, facts: Facts): Attempt
  /** The provider's publication pipeline, run under the lease; every path ends in `settle`. */
  protected abstract publish(cp: CodeHostReviewControlPlane, attempt: Attempt): Promise<CodeHostReviewOutcome>
  /** §15.1 ledger recovery: classify every operation a previous incarnation left permitted but unsettled. */
  protected abstract reconcileOperations(
    cp: CodeHostReviewControlPlane,
    attempt: Attempt
  ): Promise<CodeHostReviewOutcome | undefined>

  /** A typed refusal's second chance: `retry` re-asks the authorization once. Default: none. */
  protected async onRefused(
    _cp: CodeHostReviewControlPlane,
    _turn: Turn,
    _req: SubmitCodeReviewReq,
    _answer: Extract<CodeHostReviewAuthorized, { authorized: false }>
  ): Promise<'refuse' | 'retry'> {
    return 'refuse'
  }

  async submit(key: string, req: SubmitCodeReviewReq): Promise<CodeHostReviewOutcome> {
    const turn = this.turns.get(key)
    if (!turn || turn.agentId !== req.agentId) {
      throw new Error(
        `a formal ${this.hostLabel} review is only available during the active ${this.subjectLabel} hook turn`
      )
    }
    // §15: an incompatible pair or unusable body is rejected before any provider effect.
    const invalid = validateCodeReviewInput(req)
    if (invalid) throw new Error(invalid)
    if (!reviewPolicyAllows(turn.snapshot.reviewPolicy, req.event)) {
      throw new Error(`${req.event} exceeds this hook's ${turn.snapshot.reviewPolicy} review policy`)
    }
    if (turn.state !== 'idle')
      throw new Error(`this ${this.subjectLabel} hook turn already has a formal review attempt`)
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
      // A retryable wire failure before the lease exists wrote nothing; once it does, a replay could publish twice.
      if (err instanceof WireError && err.retryable && turn.hook.codeReview?.fence === undefined) {
        turn.state = 'idle'
        throw new Error(`formal review not submitted: control plane unreachable (${err.message}); call the tool again`)
      }
      // A withheld result leaves the turn open and the attempt pre-terminal, by design.
      turn.state = err instanceof ResultWithheld ? 'idle' : 'done'
      throw err
    }
  }

  /** RECORD-FIRST (§15.1): the attempt id lands on the durable hook row before any call, so a crash replays the same attempt. */
  protected async reserveAttempt(turn: Turn, req: SubmitCodeReviewReq): Promise<string> {
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
    turn: Turn,
    req: SubmitCodeReviewReq,
    cp: CodeHostReviewControlPlane
  ): Promise<CodeHostReviewOutcome> {
    const orgId = this.deps.orgForAgent(turn.agentId)
    const attemptId = await this.reserveAttempt(turn, req)
    const signer = await this.markerSigner()
    const session: ReviewSession<Turn> = { turn, token: await this.deps.token(turn) }
    // Read pre-lease so the authorization can carry the provider's facts and prove the leased identity is ours.
    const facts = await this.preLeaseFacts(session, req)

    // §15 steps 2-3: the durable publication lease and the CP's authorization in one round trip.
    const authorize = () =>
      cp.authorize(
        {
          hookId: turn.hookId,
          deliveryKey: turn.deliveryKey,
          attemptId,
          provider: this.provider,
          projectId: turn.repoId,
          mergeRequestIid: turn.subjectNumber,
          requestedEvent: req.event,
          requestedVerdict: req.verdict,
          snapshot: turn.snapshot,
          headSha: turn.expectedHeadSha,
          ...(turn.expectedBaseSha ? { baseSha: turn.expectedBaseSha } : {}),
          ...(facts.serviceAccountIsReviewer !== undefined
            ? { serviceAccountIsReviewer: facts.serviceAccountIsReviewer }
            : {})
        },
        orgId
      )
    let authorized = await authorize()
    if (!authorized.authorized && (await this.onRefused(cp, turn, req, authorized)) === 'retry') {
      authorized = await authorize()
    }
    if (!authorized.authorized) return await this.refused(turn, req, authorized)
    if (
      authorized.projectId !== turn.repoId ||
      authorized.mergeRequestIid !== turn.subjectNumber ||
      authorized.expectedHeadSha !== turn.expectedHeadSha
    ) {
      throw new Error('control plane returned a mismatched formal-review target')
    }

    const attempt = this.openAttempt(
      {
        turn,
        req,
        signer,
        ...(orgId ? { orgId } : {}),
        attemptId,
        fence: authorized.lease.fence,
        token: session.token,
        publisherUserId: facts.publisherUserId,
        // Seeded from the durable record: a replayed attempt must never reuse a spent coordinate.
        ordinals: new Map(
          Object.entries(turn.hook.codeReview?.ordinals ?? {}).map(([kind, next]) => [
            kind as CodeHostReviewOpKind,
            next
          ])
        ),
        externalIds: []
      },
      facts
    )
    // The fence rides the durable record so an owed ledger frame stays derivable after a restart.
    if (turn.hook.codeReview) {
      turn.hook.codeReview.fence = attempt.fence
      await turn.persist(true)
    }
    // The leased publishing identity must be the account this effect token speaks as.
    if (authorized.lease.serviceAccountUserId !== facts.publisherUserId) {
      return this.settle(cp, attempt, 'not_submitted')
    }
    return await this.publish(cp, attempt)
  }

  /** Hand back a permit no request started (§15.1): returned, or started (classify by provider evidence), or deferred (nothing decided). */
  protected async returnUnused(
    cp: CodeHostReviewControlPlane,
    ref: ReviewLeaseRef<Turn>,
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
      this.warn(`unused permit return deferred (${err instanceof Error ? err.message : err})`)
      return 'deferred'
    }
  }

  /** Rebuild owed frames without provider evidence: return unstarted permits, re-owe lost results; started operations await the replay. */
  async recoverTurn(turn: Turn): Promise<void> {
    const attemptRecord = turn.hook.codeReview
    const cp = this.deps.cp()
    if (!attemptRecord || !cp || !cp.supportsReview()) return
    const fence = attemptRecord.fence
    const orgId = this.deps.orgForAgent(turn.agentId)
    if (fence) {
      const ref: ReviewLeaseRef<Turn> = { turn, attemptId: attemptRecord.attemptId, fence, ...(orgId ? { orgId } : {}) }
      for (const op of [...(attemptRecord.operations ?? [])]) {
        // An unstarted permit is handed back; a started one replays the outcome parked on it.
        if (op.phase === 'issued') {
          await this.returnUnused(cp, ref, op)
          continue
        }
        if (!op.outcome) continue
        if (await this.outbox.owe(this.settleIntent(ref, op.recordId, op.outcome))) {
          await this.clearOperation(ref, op.recordId)
        }
      }
    }
    if (!attemptRecord.resultOwed || !attemptRecord.state) return
    const safe = await this.outbox.owe({
      intentId: `${attemptRecord.attemptId}:result`,
      daemonId: this.deps.daemonId() ?? '',
      attemptId: attemptRecord.attemptId,
      ...(orgId ? { orgId } : {}),
      kind: 'result',
      frame: JSON.stringify(
        this.resultFrame(turn, attemptRecord.attemptId, attemptRecord.event, attemptRecord.verdict, {
          headSha: attemptRecord.headSha,
          state: attemptRecord.state,
          externalIds: attemptRecord.externalIds ?? []
        })
      ),
      attempts: 0
    })
    if (safe) await this.clearResultOwed(turn)
  }

  /** The body-free result frame, built the same way whether it is owed now or replayed later. */
  protected resultFrame(
    turn: Turn,
    attemptId: string,
    event: CodeReviewEvent,
    verdict: CodeReviewVerdict,
    result: { headSha: string; state: CodeHostReviewState; externalIds: CodeHostReviewExternalRef[] }
  ): CodeHostReviewResultReport {
    return {
      hookId: turn.hookId,
      deliveryKey: turn.deliveryKey,
      attemptId,
      snapshot: turn.snapshot,
      provider: this.provider,
      projectId: turn.repoId,
      mergeRequestIid: turn.subjectNumber,
      event,
      verdict,
      headSha: result.headSha,
      state: result.state,
      ...(result.externalIds.length ? { externalIds: result.externalIds } : {})
    }
  }

  /** RECORD-FIRST: the coordinates of the one permitted request, before it is permitted. */
  protected async noteOperation(attempt: Attempt, op: CodeReviewOperation): Promise<void> {
    const attemptRecord = attempt.turn.hook.codeReview
    if (!attemptRecord) return
    attemptRecord.ordinals = Object.fromEntries(attempt.ordinals)
    attemptRecord.operations = [...(attemptRecord.operations ?? []).filter((e) => e.recordId !== op.recordId), op]
    await attempt.turn.persist(true)
  }

  /** Flip the local phase once the control plane acknowledged the start transition. */
  protected async markOperationStarted(attempt: Attempt, recordId: string): Promise<void> {
    const op = attempt.turn.hook.codeReview?.operations?.find((entry) => entry.recordId === recordId)
    if (!op || op.phase === 'started') return
    op.phase = 'started'
    await attempt.turn.persist(true)
  }

  /** Settled, so the coordinates are no longer owed. A lost removal costs one idempotent re-settle. */
  protected async clearOperation(ref: ReviewLeaseRef<Turn>, recordId: string): Promise<void> {
    const attemptRecord = ref.turn.hook.codeReview
    if (!attemptRecord?.operations) return
    attemptRecord.operations = attemptRecord.operations.filter((op) => op.recordId !== recordId)
    await ref.turn.persist().catch(() => undefined)
  }

  /** One mutation per single-use record: issue → start → one request → settle; a definite 401/403 buys one refresh under a NEW record. */
  protected async mutate(
    cp: CodeHostReviewControlPlane,
    attempt: Attempt,
    kind: CodeHostReviewOpKind,
    method: CodeHostReviewOpMethod,
    target: string,
    body: Record<string, unknown> | undefined,
    draftOrdinal?: number
  ): Promise<MutationOutcome> {
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
        return { kind: 'rejected', status: result.status, parsed: result.parsed, recordId: issued.recordId }
      }
      this.deps.invalidateToken(attempt.turn, attempt.token)
      attempt.token = await this.deps.token(attempt.turn)
    }
    throw new Error(`${this.hostLabel} review mutation exhausted its single authorization refresh`)
  }

  /** `startToken` names the one intended request, so a lost reply is retransmitted with the SAME token. */
  private async startOperation(
    cp: CodeHostReviewControlPlane,
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

  /** The settle is owed durably first so a lost ack never strands a started record; returns whether its coordinates may be forgotten. */
  private async settleOperation(
    ref: ReviewLeaseRef<Turn>,
    recordId: string,
    outcome: CodeHostReviewOpOutcome
  ): Promise<SettleDisposition> {
    const safe = await this.outbox.owe(this.settleIntent(ref, recordId, outcome))
    if (safe) return 'safe'
    // Neither written nor acknowledged: the coordinates become the replay source instead.
    return (await this.persistSettleOutcome(ref, recordId, outcome)) ? 'replayable' : 'blocked'
  }

  /** The one settle frame, built the same way whether it is owed now or replayed later. */
  protected settleIntent(
    ref: ReviewLeaseRef<Turn>,
    recordId: string,
    outcome: CodeHostReviewOpOutcome
  ): ReviewIntentRow {
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
    ref: ReviewLeaseRef<Turn>,
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
      this.warn(`settle outcome could not be parked (${err instanceof Error ? err.message : err})`)
      return false
    }
  }

  /** Owe the settle, then forget the coordinates only once something can replay it. */
  protected async settleAndClear(
    _cp: CodeHostReviewControlPlane,
    attempt: Attempt,
    recordId: string,
    outcome: CodeHostReviewOpOutcome,
    // An ambiguous record stays non-terminal until an upgrade names its object; its coordinates are that upgrade's replay source (§15.1).
    retain = false
  ): Promise<void> {
    const disposition = await this.settleOperation(attempt, recordId, outcome)
    if (disposition === 'safe' && !retain) await this.clearOperation(attempt, recordId)
    if (disposition === 'blocked') attempt.settleBlocked = true
  }

  /** Upgrade a positively identified ambiguous record to settled by naming its object; the CP keeps the lease until exactly this frame arrives. */
  protected async upgradeAmbiguous(
    cp: CodeHostReviewControlPlane,
    attempt: Attempt,
    recordId: string,
    externalId: string,
    status: number
  ): Promise<void> {
    await this.settleAndClear(cp, attempt, recordId, { kind: 'deterministic', status, externalId })
  }

  /** Record the terminal classification, releasing (or locking) the publication lease. */
  protected async settle(
    _cp: CodeHostReviewControlPlane,
    attempt: Attempt,
    state: CodeHostReviewState,
    extras: { publishedEvent?: CodeReviewEvent; note?: string } = {}
  ): Promise<CodeHostReviewOutcome> {
    const externalIds = codeHostReviewPublicEffect(state) === 'absent' ? [] : attempt.externalIds
    // No terminal result while a started operation lacks a replay source: the CP would hold the lease on a record nothing can settle (§15.1).
    if (attempt.settleBlocked) {
      this.outbox.arm()
      throw new ResultWithheld()
    }
    // The durable single-writer gate first (§15.2): only a proven no-effect attempt admits the ordinary reply, and a replay reads the same verdict.
    await this.recordOutcome(attempt.turn, state, externalIds, true)
    const safe = await this.outbox.owe({
      intentId: `${attempt.attemptId}:result`,
      daemonId: this.deps.daemonId() ?? '',
      attemptId: attempt.attemptId,
      ...(attempt.orgId ? { orgId: attempt.orgId } : {}),
      kind: 'result',
      frame: JSON.stringify(
        this.resultFrame(attempt.turn, attempt.attemptId, attempt.req.event, attempt.req.verdict, {
          headSha: attempt.turn.expectedHeadSha,
          state,
          externalIds
        })
      ),
      attempts: 0
    })
    if (safe) await this.clearResultOwed(attempt.turn)
    return {
      provider: this.provider,
      state,
      event: attempt.req.event,
      verdict: attempt.req.verdict,
      message: extras.note ? `${this.outcomeSentence(state)} ${extras.note}` : this.outcomeSentence(state),
      ...(externalIds.length ? { externalIds } : {}),
      ...(extras.publishedEvent ? { publishedEvent: extras.publishedEvent } : {})
    }
  }

  /** A typed CP refusal is an ordinary control outcome the model must read precisely. */
  private async refused(
    turn: Turn,
    req: SubmitCodeReviewReq,
    answer: Extract<CodeHostReviewAuthorized, { authorized: false }>
  ): Promise<CodeHostReviewOutcome> {
    const state: CodeHostReviewState =
      answer.reason === 'reviewer_assignment_required'
        ? 'reviewer_assignment_required'
        : answer.reason === 'ambiguous_locked'
          ? 'ambiguous_locked'
          : 'not_submitted'
    const detail = this.refusalDetail(answer.reason)
    // No lease was granted, so nothing is owed to the CP, but the durable gate still learns whether the ordinary reply may follow.
    await this.recordOutcome(turn, state, [], false)
    return {
      provider: this.provider,
      state,
      event: req.event,
      verdict: req.verdict,
      message: `${this.outcomeSentence(state)}${detail}`
    }
  }

  /** Stamp the durable attempt with its classification; the in-memory copy guards this process. */
  protected async recordOutcome(
    turn: Turn,
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
      this.warn(`outcome persistence deferred (${err instanceof Error ? err.message : err})`)
    }
  }

  /** The result frame is durable or acknowledged, so the attempt no longer owes it. */
  protected async clearResultOwed(turn: Turn): Promise<void> {
    if (!turn.hook.codeReview?.resultOwed) return
    delete turn.hook.codeReview.resultOwed
    await turn.persist().catch(() => undefined)
  }

  protected warn(message: string): void {
    try {
      this.deps.log.warn(`${this.provider} review: ${message}`)
    } catch {
      // A broken logger must not break a settlement path.
    }
  }

  protected async get(session: ReviewSession<Turn>, path: string, query?: string): Promise<unknown> {
    for (let tries = 0; tries < 2; tries += 1) {
      let result: SendResult
      try {
        result = await this.send('GET', path, query, undefined, session.token, session.turn)
      } catch {
        throw new Error(`${this.hostLabel} GET ${path} did not complete`)
      }
      if (result.status < 300) return result.parsed
      if ((result.status !== 401 && result.status !== 403) || tries === 1) {
        throw new Error(`${this.hostLabel} GET ${path} failed with ${result.status}`)
      }
      this.deps.invalidateToken(session.turn, session.token)
      session.token = await this.deps.token(session.turn)
    }
    throw new Error(`${this.hostLabel} GET ${path} failed`)
  }

  protected async send(
    method: 'GET' | CodeHostReviewOpMethod,
    path: string,
    query: string | undefined,
    body: Record<string, unknown> | undefined,
    token: string,
    turn: Turn
  ): Promise<SendResult> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const url = `${this.deps.apiBaseUrl(turn)}${path}${query ? `?${query}` : ''}`
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers: {
          ...this.authHeaders(token),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(DEFAULT_REVIEW_TIMEOUT_MS)
      })
    } catch {
      // Nothing was received, so a mutation's effect is unknown; GETs treat it the same.
      throw new AmbiguousSend(this.hostLabel, 'transport_failed')
    }
    // A 5xx may or may not have applied the effect; only a received 4xx is definite.
    if (response.status >= 500) throw new AmbiguousSend(this.hostLabel, `upstream_${response.status}`)
    const raw = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = raw ? parseCodeHostJson(raw) : undefined
    } catch {
      parsed = undefined
    }
    return { status: response.status, parsed }
  }
}
