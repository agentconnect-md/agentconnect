// Azure DevOps formal reviews (azure-devops-integration.md §11.6): marker-signed threads, a summary thread, then the shared identity's vote.
import {
  azureDevOpsReviewPublisherId,
  codeHostReviewPublicEffect,
  type CodeHostReviewAuthorized,
  type CodeHostReviewExternalRef,
  type CodeHostReviewOpKind,
  type CodeHostReviewOpMethod,
  type CodeHostReviewOpOutcome,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewState,
  type CodeHostReviewUnlock
} from '@agentconnect.md/protocol'
import type { HookDispatchContext } from '../github/hook-coords.js'
import { azureDevOpsOpensReviewGeneration } from '../messages/hook-message.js'
import type { CodeReviewEvent, CodeReviewInlineComment, SubmitCodeReviewReq } from '../codehost/review-adapter.js'
import {
  CodeHostReviewAttemptAdapter,
  DEFAULT_AMBIGUOUS_WINDOW_MS,
  DEFAULT_POLL_INTERVAL_MS,
  idOf,
  record,
  text,
  type AmbiguousSendResolution,
  type CodeHostReviewAdapterDeps,
  type CodeHostReviewAttempt,
  type CodeHostReviewOutcome,
  type CodeHostReviewTurn,
  type PreLeaseFacts,
  type ReviewSession,
  type SendResult
} from '../codehost/review-attempt.js'
import type { CodeHostReviewControlPlane } from '../codehost/review-outbox.js'
import { ReviewMarkerSigner } from '../codehost/review-marker.js'
import { appendGithubMarkdownChrome, githubAttributionFooter, type GithubCommentAttribution } from '../github/poster.js'
import { AZURE_DEVOPS_API_VERSION, azureDevOpsHeaders, azureDevOpsRepositoryApi } from './api.js'
import { newestIteration } from './pull-read.js'

/** One authorized pull-request review turn; `repoId` is the surrogate id, `subjectNumber` the pull-request id, `apiRoot` the repository's REST root. */
export interface AzureDevOpsReviewTurn extends CodeHostReviewTurn {
  apiRoot: string
}

export interface AzureDevOpsReviewAdapterDeps extends CodeHostReviewAdapterDeps<AzureDevOpsReviewTurn> {
  /** The connection identity's GUID the effect lease speaks as: the lease's user name. */
  identity: (turn: AzureDevOpsReviewTurn) => Promise<string>
}

export type AzureDevOpsReviewOutcome = CodeHostReviewOutcome

interface AzureDevOpsFacts extends PreLeaseFacts {
  identityId: string
}

interface AzureDevOpsAttempt extends CodeHostReviewAttempt<AzureDevOpsReviewTurn> {
  identityId: string
  /** The newest iteration at the head re-read; inline threads are anchored to it. */
  iteration?: number
  changeTracking?: Map<string, number>
}

/** The vote a verdict casts (§11.6); `COMMENT` casts none, so it never clears another agent's verdict. */
const VOTE: Partial<Record<CodeReviewEvent, number>> = { APPROVE: 10, REQUEST_CHANGES: -5 }

/** A text comment, in a thread that opens active. */
const TEXT_COMMENT = 1
const ACTIVE_THREAD = 1

/** A write proven absent after an unknown answer is written once more, then the attempt stops. */
const MAX_ABSENT_REWRITES = 1
const CHANGES_PAGE = 2000
const MAX_CHANGE_PAGES = 5
const MAX_EXTERNAL_IDS = 64

const OUTCOME_SENTENCE: Record<CodeHostReviewState, string> = {
  submitted: 'The formal review was published on the pull request.',
  not_submitted: 'No review was published; nothing was changed on the pull request.',
  ambiguous_locked:
    'Azure DevOps did not confirm a write and no marked thread for it became visible, so this pull request is locked against further automated review attempts until a later attempt finds that thread; no fallback comment was posted.',
  approval_not_recorded: 'The review threads were published, but Azure DevOps did not record the approving vote.',
  review_state_not_recorded:
    'The review was published only in part, or Azure DevOps did not record its vote; nothing published was removed.',
  review_state_changed_unexpectedly: 'The review was published but its vote changed unexpectedly.',
  requested_changes_block_observed: 'The review was published and the pull request currently waits for its author.',
  requested_changes_state_ambiguous: 'The review was published but Azure DevOps did not confirm the waiting vote.',
  reviewer_assignment_required: 'The review was refused because the publishing identity is not a reviewer.',
  review_reconciliation_required:
    'An earlier attempt’s marked threads could not be read back, so no review was published and this pull request stays fail-closed.'
}

const REFUSAL_DETAIL: Partial<Record<CodeHostReviewRefusalReason, string>> = {
  lease_held: ' Another review attempt currently owns publication on this pull request.',
  head_changed: ' The pull request head changed while this turn was running.',
  policy_denied: " This hook's review policy does not permit that review event.",
  binding_unavailable: ' This repository has no ready Azure DevOps connection to publish as.',
  ambiguous_locked: ' A previous attempt on this pull request stays locked until its marked summary thread is found.'
}

type WriteResult =
  { kind: 'written'; threadId?: string } | { kind: 'anchor_refused' } | { kind: 'failed' } | { kind: 'ambiguous' }

/** One inline comment's anchor: a range on one side, or its end line alone once a range was refused. */
function anchor(comment: CodeReviewInlineComment, single: boolean): { start: number; end: number; collapsed: boolean } {
  const ranged =
    comment.startLine !== undefined &&
    comment.startLine !== comment.line &&
    (comment.startSide ?? comment.side) === comment.side
  if (ranged && !single) return { start: comment.startLine!, end: comment.line, collapsed: false }
  return {
    start: comment.line,
    end: comment.line,
    collapsed: comment.startLine !== undefined && comment.startLine !== comment.line
  }
}

/** Azure DevOps names a changed file from the repository root with a leading slash. */
function filePath(path: string): string {
  return `/${path.replace(/^\/+/, '')}`
}

export class AzureDevOpsReviewAdapter extends CodeHostReviewAttemptAdapter<
  AzureDevOpsReviewTurn,
  AzureDevOpsAttempt,
  AzureDevOpsFacts
> {
  readonly provider = 'azure-devops' as const
  protected readonly hostLabel = 'Azure DevOps'
  protected readonly subjectLabel = 'pull-request'

  constructor(protected override readonly deps: AzureDevOpsReviewAdapterDeps) {
    super(deps)
  }

  /** Install the active review turn for one logical session key; undefined for anything but an authorized pull-request review generation. */
  openTurn(
    key: string,
    hook: HookDispatchContext | undefined,
    sessionId: string,
    options: { daemonId?: string; persist: (required?: boolean) => Promise<void> }
  ): AzureDevOpsReviewTurn | undefined {
    const azure = hook?.azureDevOps
    const snapshot = hook?.snapshot
    if (!hook || !azure || !snapshot) return undefined
    if (azure.target.kind !== 'pull' || !azure.target.headSha) return undefined
    // The same trusted predicate the prompt uses: only a delivery that OPENS a review generation for this head may publish one.
    if (!azureDevOpsOpensReviewGeneration(hook.event, azure, snapshot.reviewPolicy)) return undefined
    if (options.daemonId && snapshot.dispatchDaemonId !== options.daemonId) return undefined
    // A durable attempt that already reached a present or unknown effect is terminal for this turn.
    const prior = hook.codeReview
    const terminal = prior?.state !== undefined && codeHostReviewPublicEffect(prior.state) !== 'absent'
    const turn: AzureDevOpsReviewTurn = {
      hookId: hook.hookId,
      agentId: hook.agentId,
      deliveryKey: hook.deliveryKey,
      snapshot,
      repoId: azure.repoId,
      repoPath: azure.repoPath,
      subjectNumber: azure.target.pullRequestId,
      expectedHeadSha: azure.target.headSha,
      apiRoot: azureDevOpsRepositoryApi(azure),
      sessionId,
      hook,
      persist: options.persist,
      state: terminal ? 'done' : 'idle'
    }
    this.turns.set(key, turn)
    return turn
  }

  /** Markers are keyed per attempt so a locked attempt's seed can travel to the daemon a lock later refuses. */
  protected override buildSigner(key: Buffer): ReviewMarkerSigner {
    return ReviewMarkerSigner.derived(key)
  }

  protected override async markerSeed(attemptId: string): Promise<string> {
    return ReviewMarkerSigner.seed(await this.deps.markerKey(), attemptId).toString('hex')
  }

  protected outcomeSentence(state: CodeHostReviewState): string {
    return OUTCOME_SENTENCE[state]
  }

  protected refusalDetail(reason: CodeHostReviewRefusalReason): string {
    return REFUSAL_DETAIL[reason] ?? ''
  }

  protected authHeaders(token: string): Record<string, string> {
    return azureDevOpsHeaders(token, false)
  }

  /** Every request carries the pinned API version; the ledger target stays the bare path. */
  protected override send(
    method: 'GET' | CodeHostReviewOpMethod,
    path: string,
    query: string | undefined,
    body: Record<string, unknown> | undefined,
    token: string,
    turn: AzureDevOpsReviewTurn
  ): Promise<SendResult> {
    const version = `api-version=${AZURE_DEVOPS_API_VERSION}`
    return super.send(method, path, query ? `${query}&${version}` : version, body, token, turn)
  }

  /** The lease's user name is the identity; its GUID's numeric key is what the lease must name. */
  protected async preLeaseFacts(session: ReviewSession<AzureDevOpsReviewTurn>): Promise<AzureDevOpsFacts> {
    const identityId = (await this.deps.identity(session.turn)).toLowerCase()
    return { identityId, publisherUserId: azureDevOpsReviewPublisherId(identityId) }
  }

  protected openAttempt(
    base: CodeHostReviewAttempt<AzureDevOpsReviewTurn>,
    facts: AzureDevOpsFacts
  ): AzureDevOpsAttempt {
    return { ...base, identityId: facts.identityId }
  }

  /** The lock's one exit: the locked attempt's summary thread, found from the CP's durable coordinates. */
  protected override async onRefused(
    _cp: CodeHostReviewControlPlane,
    turn: AzureDevOpsReviewTurn,
    _req: SubmitCodeReviewReq,
    answer: Extract<CodeHostReviewAuthorized, { authorized: false }>
  ): Promise<{ unlock: CodeHostReviewUnlock } | undefined> {
    const lock = answer.reason === 'ambiguous_locked' ? answer.lock : undefined
    if (!lock) return undefined
    try {
      const session: ReviewSession<AzureDevOpsReviewTurn> = { turn, token: await this.deps.token(turn) }
      const signer = ReviewMarkerSigner.forSeed(lock.attemptId, Buffer.from(lock.markerSeed, 'hex'))
      const summary = (await this.markedThreads(session, signer, lock.attemptId, lock.headSha)).get(0)
      if (!summary) return undefined
      return {
        unlock: {
          attemptId: lock.attemptId,
          fence: lock.fence,
          recordId: lock.recordId,
          externalRef: { kind: 'discussion', externalId: summary }
        }
      }
    } catch (err) {
      this.warn(`lock reconciliation deferred (${err instanceof Error ? err.message : err})`)
      return undefined
    }
  }

  protected async publish(
    cp: CodeHostReviewControlPlane,
    attempt: AzureDevOpsAttempt
  ): Promise<AzureDevOpsReviewOutcome> {
    const { turn, req } = attempt
    // A request a previous incarnation permitted is classified before another is issued.
    const recovered = await this.reconcileOperations(cp, attempt)
    if (recovered) return recovered

    // Step 1: renew, then re-read the head on the newest iteration and refuse a moved one.
    const renewed = await cp.renew({ attemptId: attempt.attemptId, fence: attempt.fence }, attempt.orgId)
    if (renewed.phase === 'ambiguous_locked') return this.settle(cp, attempt, 'ambiguous_locked')
    attempt.fence = renewed.fence
    const newest = newestIteration(await this.get(attempt, `${this.pullPath(turn)}/iterations`))
    const existing = await this.markedThreads(attempt, attempt.signer, attempt.attemptId, turn.expectedHeadSha)
    this.noteThreads(attempt, existing)
    if (!newest?.headSha || newest.headSha !== turn.expectedHeadSha) {
      return this.settle(cp, attempt, existing.size > 0 ? 'review_state_not_recorded' : 'not_submitted')
    }
    attempt.iteration = newest.id
    let written = existing.size > 0

    // Step 2: one thread per inline comment not already there; an anchor Azure DevOps refuses folds into the summary.
    const folded: CodeReviewInlineComment[] = []
    for (const [index, comment] of (req.comments ?? []).entries()) {
      const ordinal = index + 1
      if (existing.has(ordinal)) continue
      let result = await this.writeInline(cp, attempt, comment, ordinal, false)
      if (result.kind === 'anchor_refused' && anchor(comment, false).start !== anchor(comment, true).start) {
        result = await this.writeInline(cp, attempt, comment, ordinal, true)
      }
      if (result.kind === 'anchor_refused') {
        folded.push(comment)
        continue
      }
      if (result.kind !== 'written') return this.halt(cp, attempt, result, written)
      written = true
    }

    // Step 3: the summary thread, carrying whatever could not be anchored.
    if (!existing.has(0)) {
      const result = await this.writeThread(cp, attempt, 0, await this.summary(attempt, folded))
      if (result.kind !== 'written') return this.halt(cp, attempt, result, written)
    }

    // Step 4: the vote, idempotent, and never for COMMENT.
    const vote = VOTE[req.event]
    if (vote === undefined) return this.settle(cp, attempt, 'submitted')
    return this.settle(cp, attempt, await this.castVote(cp, attempt, vote))
  }

  /** A write that neither landed nor was cleanly refused ends the attempt; what already landed decides between absent and partial. */
  private halt(
    cp: CodeHostReviewControlPlane,
    attempt: AzureDevOpsAttempt,
    result: WriteResult,
    written: boolean
  ): Promise<AzureDevOpsReviewOutcome> {
    if (result.kind === 'ambiguous') return this.settle(cp, attempt, 'ambiguous_locked')
    return this.settle(cp, attempt, written ? 'review_state_not_recorded' : 'not_submitted')
  }

  /** §15.1 ledger recovery: a thread is proven by its marker, a vote by reading it back; whatever is missing is written again after. */
  protected async reconcileOperations(
    cp: CodeHostReviewControlPlane,
    attempt: AzureDevOpsAttempt
  ): Promise<AzureDevOpsReviewOutcome | undefined> {
    const pending = [...(attempt.turn.hook.codeReview?.operations ?? [])]
    if (pending.length === 0) return undefined
    let marked: Map<number, string> | undefined
    for (const op of pending) {
      // A permit whose start was never acknowledged had no request: return it unused.
      if (op.phase === 'issued' && (await this.returnUnused(cp, attempt, op)) !== 'started') continue
      let outcome: CodeHostReviewOpOutcome | undefined
      if (op.kind === 'approval') {
        outcome = (await this.voteMatches(attempt, VOTE[attempt.req.event]))
          ? { kind: 'deterministic', status: 200 }
          : { kind: 'deterministic', status: 422, code: 'vote_absent' }
      } else {
        marked ??= await this.markedThreads(attempt, attempt.signer, attempt.attemptId, attempt.turn.expectedHeadSha)
        const threadId = op.draftOrdinal === undefined ? undefined : marked.get(op.draftOrdinal)
        // An ambiguous record settles only by naming its object; absent, it keeps the pull request locked.
        if (!threadId && op.outcome?.kind === 'ambiguous') return await this.settle(cp, attempt, 'ambiguous_locked')
        outcome = threadId
          ? { kind: 'deterministic', status: 200, externalId: threadId }
          : { kind: 'deterministic', status: 422, code: 'thread_absent' }
      }
      await this.settleAndClear(cp, attempt, op.recordId, outcome)
    }
    return undefined
  }

  /** An unknown answer is read back: a thread by its marker within the window, a vote by its value; a read that never answers keeps it ambiguous. */
  protected override async resolveAmbiguousSend(
    attempt: AzureDevOpsAttempt,
    kind: CodeHostReviewOpKind,
    draftOrdinal: number | undefined
  ): Promise<AmbiguousSendResolution | undefined> {
    if (kind === 'approval') {
      const reviewer = await this.readReviewer(attempt)
      return reviewer.vote === VOTE[attempt.req.event]
        ? { present: true, status: 200, parsed: reviewer }
        : { present: false, code: 'vote_absent' }
    }
    if (draftOrdinal === undefined) return undefined
    const deadline = this.now() + (this.deps.ambiguousWindowMs ?? DEFAULT_AMBIGUOUS_WINDOW_MS)
    let observed = false
    for (;;) {
      const marked = await this.markedThreads(
        attempt,
        attempt.signer,
        attempt.attemptId,
        attempt.turn.expectedHeadSha
      ).catch(() => undefined)
      if (marked) observed = true
      const threadId = marked?.get(draftOrdinal)
      if (threadId) return { present: true, status: 200, parsed: { id: threadId }, externalId: threadId }
      if (this.now() >= deadline) break
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
    return observed ? { present: false, code: 'thread_absent' } : undefined
  }

  /** One inline thread, anchored to the newest iteration and the file's change. */
  private async writeInline(
    cp: CodeHostReviewControlPlane,
    attempt: AzureDevOpsAttempt,
    comment: CodeReviewInlineComment,
    ordinal: number,
    single: boolean
  ): Promise<WriteResult> {
    const span = anchor(comment, single)
    const path = filePath(comment.path)
    const position = (line: number) => ({ line, offset: 1 })
    const sides =
      comment.side === 'LEFT'
        ? { leftFileStart: position(span.start), leftFileEnd: position(span.end) }
        : { rightFileStart: position(span.start), rightFileEnd: position(span.end) }
    const changeTrackingId = (await this.changeTracking(attempt)).get(path.toLowerCase())
    const lead = span.collapsed ? `Lines ${comment.startLine}-${comment.line}:\n\n` : ''
    return this.writeThread(cp, attempt, ordinal, `${lead}${ReviewMarkerSigner.neutralize(comment.body)}`, {
      threadContext: { filePath: path, ...sides },
      pullRequestThreadContext: {
        ...(changeTrackingId !== undefined ? { changeTrackingId } : {}),
        // Equal iterations put the common commit on the left: the full pull-request diff the comment was written against.
        iterationContext: { firstComparingIteration: attempt.iteration, secondComparingIteration: attempt.iteration }
      }
    })
  }

  /** One marked thread under one record; a write proven absent after an unknown answer is written once more. */
  private async writeThread(
    cp: CodeHostReviewControlPlane,
    attempt: AzureDevOpsAttempt,
    ordinal: number,
    content: string,
    context: Record<string, unknown> = {}
  ): Promise<WriteResult> {
    const marked = `${content}\n\n${attempt.signer.mint(attempt.attemptId, ordinal, attempt.turn.expectedHeadSha)}`
    const body = {
      comments: [{ parentCommentId: 0, content: marked, commentType: TEXT_COMMENT }],
      status: ACTIVE_THREAD,
      ...context
    }
    const kind: CodeHostReviewOpKind = ordinal === 0 ? 'bulk_publish' : 'draft_create'
    for (let rewrites = 0; ; rewrites += 1) {
      const outcome = await this.mutate(
        cp,
        attempt,
        kind,
        'POST',
        `${this.pullPath(attempt.turn)}/threads`,
        body,
        ordinal
      )
      if (outcome.kind === 'ambiguous') return { kind: 'ambiguous' }
      if (outcome.kind === 'sent') {
        const threadId = idOf(record(outcome.parsed).id)
        if (threadId) this.noteThreads(attempt, new Map([[ordinal, threadId]]))
        return { kind: 'written', ...(threadId ? { threadId } : {}) }
      }
      if (outcome.absent && rewrites < MAX_ABSENT_REWRITES) continue
      // A refused anchor is the one rejection with a fallback; it is never the summary's.
      return outcome.status === 400 && ordinal !== 0 ? { kind: 'anchor_refused' } : { kind: 'failed' }
    }
  }

  /** The vote on the identity's own reviewer entry; a write proven absent is cast once more. */
  private async castVote(
    cp: CodeHostReviewControlPlane,
    attempt: AzureDevOpsAttempt,
    vote: number
  ): Promise<CodeHostReviewState> {
    const notRecorded: CodeHostReviewState =
      attempt.req.event === 'APPROVE' ? 'approval_not_recorded' : 'review_state_not_recorded'
    for (let rewrites = 0; ; rewrites += 1) {
      const outcome = await this.mutate(cp, attempt, 'approval', 'PUT', this.reviewerPath(attempt), { vote })
      if (outcome.kind === 'ambiguous') return 'ambiguous_locked'
      if (outcome.kind === 'sent') {
        const recorded = record(outcome.parsed).vote
        return recorded === undefined || recorded === vote ? 'submitted' : notRecorded
      }
      if (outcome.absent && rewrites < MAX_ABSENT_REWRITES) continue
      return notRecorded
    }
  }

  private async voteMatches(attempt: AzureDevOpsAttempt, vote: number | undefined): Promise<boolean> {
    if (vote === undefined) return false
    return (await this.readReviewer(attempt).catch(() => ({ vote: undefined }))).vote === vote
  }

  private async readReviewer(attempt: AzureDevOpsAttempt): Promise<{ vote?: number }> {
    try {
      const reviewer = record(await this.get(attempt, this.reviewerPath(attempt)))
      return typeof reviewer.vote === 'number' ? { vote: reviewer.vote } : {}
    } catch (err) {
      // An identity that never voted is not among the reviewers.
      if (err instanceof Error && / failed with 404$/.test(err.message)) return {}
      throw err
    }
  }

  /** The summary: the model's body, the unanchored comments listed under it, the footer, and the marker. */
  private async summary(attempt: AzureDevOpsAttempt, folded: CodeReviewInlineComment[]): Promise<string> {
    const attribution = await this.deps.attribution?.(attempt.turn)
    const unplaced = folded.length
      ? [
          '',
          'Comments that could not be placed on the diff:',
          ...folded.map(
            (comment) =>
              `- \`${comment.path.replace(/`/g, '')}\` ${comment.side === 'LEFT' ? 'target' : 'source'} line ${comment.line}: ${ReviewMarkerSigner.neutralize(comment.body)}`
          )
        ].join('\n')
      : ''
    return this.render(`${attempt.req.body}${unplaced ? `\n${unplaced}` : ''}`, attribution)
  }

  private render(body: string, attribution: GithubCommentAttribution | undefined): string {
    return appendGithubMarkdownChrome(ReviewMarkerSigner.neutralize(body), githubAttributionFooter(attribution))
  }

  /** Every comment this attempt's marker signs, by ordinal: the thread it opened. */
  private async markedThreads(
    session: ReviewSession<AzureDevOpsReviewTurn>,
    signer: ReviewMarkerSigner,
    attemptId: string,
    headSha: string
  ): Promise<Map<number, string>> {
    const found = new Map<number, string>()
    const threads = record(await this.get(session, `${this.pullPath(session.turn)}/threads`)).value
    for (const raw of Array.isArray(threads) ? threads : []) {
      const thread = record(raw)
      const threadId = idOf(thread.id)
      if (!threadId) continue
      for (const comment of Array.isArray(thread.comments) ? thread.comments : []) {
        const marker = signer.read(text(record(comment).content), headSha)
        if (marker?.attemptId === attemptId.toLowerCase() && !found.has(marker.ordinal)) {
          found.set(marker.ordinal, threadId)
        }
      }
    }
    return found
  }

  /** The newest iteration's changed files by path, for the anchor's `changeTrackingId`; read once per attempt. */
  private async changeTracking(attempt: AzureDevOpsAttempt): Promise<Map<string, number>> {
    if (attempt.changeTracking) return attempt.changeTracking
    const tracking = new Map<string, number>()
    try {
      let skip = 0
      for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
        const parsed = record(
          await this.get(
            attempt,
            `${this.pullPath(attempt.turn)}/iterations/${attempt.iteration}/changes`,
            `$top=${CHANGES_PAGE}&$skip=${skip}`
          )
        )
        for (const raw of Array.isArray(parsed.changeEntries) ? parsed.changeEntries : []) {
          const entry = record(raw)
          const path = text(record(entry.item).path)
          if (path && typeof entry.changeTrackingId === 'number')
            tracking.set(path.toLowerCase(), entry.changeTrackingId)
        }
        const next = parsed.nextSkip
        if (typeof next !== 'number' || next <= skip) break
        skip = next
      }
    } catch (err) {
      // A thread without the change id still anchors to its path and lines.
      this.warn(`changes read failed (${err instanceof Error ? err.message : err})`)
    }
    attempt.changeTracking = tracking
    return tracking
  }

  /** Record what landed, summary first, within the result frame's bound. */
  private noteThreads(attempt: AzureDevOpsAttempt, threads: Map<number, string>): void {
    for (const [ordinal, externalId] of [...threads].sort(([a], [b]) => a - b)) {
      if (attempt.externalIds.some((ref) => ref.externalId === externalId)) continue
      const ref: CodeHostReviewExternalRef = { kind: 'discussion', externalId }
      if (ordinal === 0) attempt.externalIds.unshift(ref)
      else attempt.externalIds.push(ref)
    }
    if (attempt.externalIds.length > MAX_EXTERNAL_IDS) attempt.externalIds.length = MAX_EXTERNAL_IDS
  }

  private pullPath(turn: AzureDevOpsReviewTurn): string {
    return `/pullRequests/${turn.subjectNumber}`
  }

  private reviewerPath(attempt: AzureDevOpsAttempt): string {
    return `${this.pullPath(attempt.turn)}/reviewers/${attempt.identityId}`
  }
}
