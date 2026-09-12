// Gitea formal pull-request reviews (gitea-integration.md §10.3): the GitLab pipeline with one marker-signed POST …/reviews in place of drafts.
import {
  codeHostReviewPublicEffect,
  type CodeHostReviewAuthorized,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewState,
  type CodeHostReviewUnlock
} from '@agentconnect.md/protocol'
import type { CodeReviewOperation, HookDispatchContext } from '../github/hook-coords.js'
import { giteaOpensReviewGeneration } from '../messages/hook-message.js'
import type { CodeReviewEvent, CodeReviewInlineComment, SubmitCodeReviewReq } from '../codehost/review-adapter.js'
import {
  CodeHostReviewAttemptAdapter,
  DEFAULT_AMBIGUOUS_WINDOW_MS,
  DEFAULT_POLL_INTERVAL_MS,
  idOf,
  record,
  text,
  type CodeHostReviewAdapterDeps,
  type CodeHostReviewAttempt,
  type CodeHostReviewOutcome,
  type CodeHostReviewTurn,
  type PreLeaseFacts,
  type ReviewSession
} from '../codehost/review-attempt.js'
import type { CodeHostReviewControlPlane } from '../codehost/review-outbox.js'
import { ReviewMarkerSigner } from '../codehost/review-marker.js'
import { appendGithubMarkdownChrome, githubAttributionFooter, type GithubCommentAttribution } from '../github/poster.js'
import { giteaRepoPath } from './api.js'

/** One authorized pull-request review turn: `repoId` is the numeric repository id, `subjectNumber` the pull index. */
export type GiteaReviewTurn = CodeHostReviewTurn
export type GiteaReviewAdapterDeps = CodeHostReviewAdapterDeps<GiteaReviewTurn>
export type GiteaReviewOutcome = CodeHostReviewOutcome

type GiteaFacts = PreLeaseFacts
type GiteaAttempt = CodeHostReviewAttempt<GiteaReviewTurn>

/** The verdict vocabulary of `POST …/reviews` (§10.3 step 4). */
const GITEA_EVENT: Record<CodeReviewEvent, string> = {
  COMMENT: 'COMMENT',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  APPROVE: 'APPROVED'
}

/** A submitted review's `state` read back as the event it published; pending and reviewer-request rows are neither. */
const EVENT_OF_STATE: Record<string, CodeReviewEvent> = {
  COMMENT: 'COMMENT',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  APPROVED: 'APPROVE'
}

/** Gitea's exact 422 texts for the pull request's own author (§16 probe). */
const SELF_REVIEW_REFUSAL = /\b(?:approve|reject) your own pull is not allowed\b/i

const SELF_REVIEW_NOTE =
  'Gitea refuses the pull request author’s own APPROVE and REQUEST_CHANGES, so the same review was published as a COMMENT (self_review_forbidden).'

const REVIEW_PAGE_SIZE = 50
const MAX_REVIEW_PAGES = 10

/** One English sentence per normalized state; the GitLab-only states keep a truthful sentence in case a shared path ever names one. */
const OUTCOME_SENTENCE: Record<CodeHostReviewState, string> = {
  submitted: 'The formal review was published on the pull request.',
  not_submitted: 'No review was published; nothing was changed on the pull request.',
  ambiguous_locked:
    'Gitea did not confirm the publication and no marked review became visible, so this pull request is locked against further automated review attempts until a later reconciliation finds the marked review submitted; no fallback comment was posted.',
  approval_not_recorded: 'The review was published but the approval was not recorded.',
  review_state_not_recorded: 'The review was published but Gitea did not report the resulting review state.',
  review_state_changed_unexpectedly: 'The review was published but the review state changed unexpectedly.',
  requested_changes_block_observed: 'The review was published and the pull request currently requests changes.',
  requested_changes_state_ambiguous: 'The review was published but Gitea did not confirm the requested-changes state.',
  reviewer_assignment_required: 'REQUEST_CHANGES was refused because the publishing account is not a current reviewer.',
  review_reconciliation_required:
    'A pending review left on this pull request by the bot could not be reconciled, so no review was published and this pull request stays fail-closed.'
}

const REFUSAL_DETAIL: Partial<Record<CodeHostReviewRefusalReason, string>> = {
  lease_held: ' Another review attempt currently owns publication on this pull request.',
  head_changed: ' The pull request head changed while this turn was running.',
  policy_denied: " This hook's review policy does not permit that review event.",
  binding_unavailable: ' This repository has no ready Gitea binding to publish as.',
  ambiguous_locked: ' A previous attempt on this pull request stays locked until its marked review is found submitted.'
}

interface ReviewRow {
  id: string
  userId?: string
  state?: string
  body?: string
  commitId?: string
}

interface SubmittedReview {
  id: string
  event?: CodeReviewEvent
}

type SubmitResult =
  | { kind: 'submitted'; review: SubmittedReview }
  | { kind: 'not_submitted' }
  | { kind: 'ambiguous_locked' }
  | { kind: 'self_review_forbidden' }

function reviewRows(parsed: unknown): ReviewRow[] {
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((row) => {
    const review = record(row)
    const id = idOf(review.id)
    if (!id) return []
    const userId = idOf(record(review.user).id)
    return [
      {
        id,
        ...(userId ? { userId } : {}),
        ...(text(review.state) ? { state: text(review.state)! } : {}),
        ...(text(review.body) ? { body: text(review.body)! } : {}),
        ...(text(review.commit_id) ? { commitId: text(review.commit_id)! } : {})
      }
    ]
  })
}

/** The one pull-request fact this adapter fences on. */
function pullHead(parsed: unknown): string | undefined {
  return text(record(record(parsed).head).sha)
}

export class GiteaReviewAdapter extends CodeHostReviewAttemptAdapter<GiteaReviewTurn, GiteaAttempt, GiteaFacts> {
  readonly provider = 'gitea' as const
  protected readonly hostLabel = 'Gitea'
  protected readonly subjectLabel = 'pull-request'

  constructor(deps: GiteaReviewAdapterDeps) {
    super(deps)
  }

  /** Install the active review turn for one logical session key; undefined for anything but an authorized pull-request review generation. */
  openTurn(
    key: string,
    hook: HookDispatchContext | undefined,
    sessionId: string,
    options: { daemonId?: string; persist: (required?: boolean) => Promise<void> }
  ): GiteaReviewTurn | undefined {
    const gitea = hook?.gitea
    const snapshot = hook?.snapshot
    if (!hook || !gitea || !snapshot) return undefined
    if (gitea.target.kind !== 'pull' || !gitea.target.headSha) return undefined
    // The same trusted predicate the prompt uses: only a delivery that OPENS a review generation for this head may publish one.
    if (!giteaOpensReviewGeneration(hook.event, gitea, snapshot.reviewPolicy)) return undefined
    if (options.daemonId && snapshot.dispatchDaemonId !== options.daemonId) return undefined
    // A durable attempt that already reached a present or unknown effect is terminal for this turn.
    const prior = hook.codeReview
    const terminal = prior?.state !== undefined && codeHostReviewPublicEffect(prior.state) !== 'absent'
    const turn: GiteaReviewTurn = {
      hookId: hook.hookId,
      agentId: hook.agentId,
      deliveryKey: hook.deliveryKey,
      snapshot,
      repoId: gitea.repoId,
      repoPath: gitea.repoPath,
      subjectNumber: gitea.target.index,
      expectedHeadSha: gitea.target.headSha,
      ...(gitea.target.baseSha ? { expectedBaseSha: gitea.target.baseSha } : {}),
      sessionId,
      hook,
      persist: options.persist,
      state: terminal ? 'done' : 'idle'
    }
    this.turns.set(key, turn)
    return turn
  }

  /** Markers are keyed per attempt so the seed of one attempt can travel to the daemon a lock later refuses (§10.3). */
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
    return { authorization: `token ${token}`, accept: 'application/json' }
  }

  /** Gitea's request-changes needs no reviewer record (§2), so the only pre-lease fact is who the token speaks as. */
  protected async preLeaseFacts(session: ReviewSession<GiteaReviewTurn>): Promise<GiteaFacts> {
    const publisherUserId = idOf(record(await this.get(session, '/user')).id)
    if (!publisherUserId) throw new Error('Gitea did not identify the review publishing account')
    return { publisherUserId }
  }

  protected openAttempt(base: CodeHostReviewAttempt<GiteaReviewTurn>): GiteaAttempt {
    return base
  }

  /** The lock's one exit (§10.3): from the CP's durable coordinates, look for the locked attempt's marked review, then ask again naming it. */
  protected override async onRefused(
    _cp: CodeHostReviewControlPlane,
    turn: GiteaReviewTurn,
    _req: SubmitCodeReviewReq,
    answer: Extract<CodeHostReviewAuthorized, { authorized: false }>
  ): Promise<{ unlock: CodeHostReviewUnlock } | undefined> {
    const lock = answer.reason === 'ambiguous_locked' ? answer.lock : undefined
    if (!lock) return undefined
    try {
      const session: ReviewSession<GiteaReviewTurn> = { turn, token: await this.deps.token(turn) }
      const signer = ReviewMarkerSigner.forSeed(lock.attemptId, Buffer.from(lock.markerSeed, 'hex'))
      const found = await this.findSubmittedReview(session, lock.attemptId, lock.headSha, signer)
      if (!found) return undefined
      return {
        unlock: {
          attemptId: lock.attemptId,
          fence: lock.fence,
          recordId: lock.recordId,
          externalRef: { kind: 'review', externalId: found.id }
        }
      }
    } catch (err) {
      this.warn(`lock reconciliation deferred (${err instanceof Error ? err.message : err})`)
      return undefined
    }
  }

  protected async publish(cp: CodeHostReviewControlPlane, attempt: GiteaAttempt): Promise<GiteaReviewOutcome> {
    const { turn, req } = attempt

    // §15.1: a request this attempt already permitted must be classified against the ledger before another is issued.
    const recovered = await this.reconcileOperations(cp, attempt)
    if (recovered) return recovered

    // §10.3 step 2: the bot's orphan pending review would be absorbed by the submit, so it goes first.
    const reconciled = await this.reconcilePendingReviews(cp, attempt)
    if (reconciled) return reconciled

    // Renew immediately before the one request, then re-fetch the head it is fenced on (step 3).
    const renewed = await cp.renew({ attemptId: attempt.attemptId, fence: attempt.fence }, attempt.orgId)
    if (renewed.phase === 'ambiguous_locked') return this.settle(cp, attempt, 'ambiguous_locked')
    attempt.fence = renewed.fence
    const head = pullHead(await this.get(attempt, this.pullPath(turn)))
    if (!head) throw new Error('Gitea did not return the pull request revision')
    if (head !== turn.expectedHeadSha) return this.settle(cp, attempt, 'not_submitted')

    // Step 4-5: ONE submission, and the self-review downgrade when Gitea refuses the author's own verdict.
    const first = await this.submitReview(cp, attempt, req.event)
    if (first.kind !== 'self_review_forbidden') return this.settleSubmit(cp, attempt, first)
    if (req.event === 'COMMENT') return this.settle(cp, attempt, 'not_submitted')
    const second = await this.submitReview(cp, attempt, 'COMMENT')
    if (second.kind === 'submitted') {
      return this.settle(cp, attempt, 'submitted', { publishedEvent: 'COMMENT', note: SELF_REVIEW_NOTE })
    }
    return this.settleSubmit(cp, attempt, second)
  }

  private settleSubmit(
    cp: CodeHostReviewControlPlane,
    attempt: GiteaAttempt,
    result: SubmitResult
  ): Promise<GiteaReviewOutcome> {
    if (result.kind === 'submitted') {
      const downgraded = result.review.event !== undefined && result.review.event !== attempt.req.event
      return this.settle(
        cp,
        attempt,
        'submitted',
        downgraded ? { publishedEvent: result.review.event!, note: SELF_REVIEW_NOTE } : {}
      )
    }
    if (result.kind === 'ambiguous_locked') return this.settle(cp, attempt, 'ambiguous_locked')
    return this.settle(cp, attempt, 'not_submitted')
  }

  /** §15.1 ledger recovery: a delete is proven by the absence it asked for, a submission by its summary marker alone — found, or locked. */
  protected async reconcileOperations(
    cp: CodeHostReviewControlPlane,
    attempt: GiteaAttempt
  ): Promise<GiteaReviewOutcome | undefined> {
    const pending = [...(attempt.turn.hook.codeReview?.operations ?? [])]
    if (pending.length === 0) return undefined
    const outstanding: CodeReviewOperation[] = []
    let reviews: ReviewRow[] | undefined
    for (const op of pending) {
      // A permit whose start was never acknowledged had no request: return it unused.
      if (op.phase === 'issued' && (await this.returnUnused(cp, attempt, op)) !== 'started') continue
      if (op.kind === 'bulk_publish') {
        outstanding.push(op)
        continue
      }
      reviews ??= await this.listReviews(attempt).catch(() => [])
      const reviewId = op.target.split('/').at(-1) ?? ''
      const present = reviews.some((review) => review.id === reviewId && review.state === 'PENDING')
      await this.settleAndClear(
        cp,
        attempt,
        op.recordId,
        present
          ? { kind: 'deterministic', status: 422, code: 'draft_present' }
          : { kind: 'deterministic', status: 204, ...(idOf(reviewId) ? { externalId: reviewId } : {}) }
      )
    }
    if (outstanding.length === 0) return undefined
    // Only positive provider evidence can classify a permitted submission.
    const found = await this.findSubmittedReview(attempt, attempt.attemptId, attempt.turn.expectedHeadSha).catch(
      () => undefined
    )
    for (const op of outstanding) {
      if (found) {
        await this.settleAndClear(cp, attempt, op.recordId, {
          kind: 'deterministic',
          status: 200,
          externalId: found.id
        })
      } else {
        await this.settleAndClear(cp, attempt, op.recordId, { kind: 'ambiguous', code: 'publish_unreconciled' }, true)
      }
    }
    if (!found) return await this.settle(cp, attempt, 'ambiguous_locked')
    attempt.externalIds.push({ kind: 'review', externalId: found.id })
    return await this.settleSubmit(cp, attempt, { kind: 'submitted', review: found })
  }

  /** §10.3 step 2: delete the bot's pending reviews or refuse; every staged comment must carry another attempt's verified marker. */
  private async reconcilePendingReviews(
    cp: CodeHostReviewControlPlane,
    attempt: GiteaAttempt
  ): Promise<GiteaReviewOutcome | undefined> {
    const { turn } = attempt
    const orphans = (await this.listReviews(attempt)).filter(
      (review) => review.userId === attempt.publisherUserId && review.state === 'PENDING'
    )
    for (const orphan of orphans) {
      const comments = await this.get(attempt, `${this.pullPath(turn)}/reviews/${orphan.id}/comments`)
      // A pending review records the head it was staged against; its markers verify under that head.
      const stagedHead = orphan.commitId ?? turn.expectedHeadSha
      for (const raw of Array.isArray(comments) ? comments : []) {
        const marker = attempt.signer.read(text(record(raw).body), stagedHead)
        if (!marker || marker.attemptId === attempt.attemptId.toLowerCase()) {
          return this.settle(cp, attempt, 'review_reconciliation_required')
        }
      }
      if (!(await this.deletePendingReview(cp, attempt, orphan.id))) {
        return this.settle(cp, attempt, 'review_reconciliation_required')
      }
    }
    return undefined
  }

  /** `DELETE …/reviews/:id` also removes a submitted review, so the state guard is re-read right before it (§16). */
  private async deletePendingReview(
    cp: CodeHostReviewControlPlane,
    attempt: GiteaAttempt,
    reviewId: string
  ): Promise<boolean> {
    const path = `${this.pullPath(attempt.turn)}/reviews/${reviewId}`
    const current = record(await this.get(attempt, path).catch(() => undefined))
    if (idOf(current.id) !== reviewId || current.state !== 'PENDING') return false
    const outcome = await this.mutate(cp, attempt, 'draft_delete', 'DELETE', path, undefined)
    if (outcome.kind === 'sent') return true
    // A 404 is the same proven absence the delete was asking for.
    if (outcome.kind === 'rejected') return outcome.status === 404
    const remaining = await this.listReviews(attempt).catch(() => undefined)
    if (remaining === undefined || remaining.some((review) => review.id === reviewId)) return false
    // Read-after-ambiguous-delete proved the absence, so the record is upgraded, not left ambiguous.
    await this.upgradeAmbiguous(cp, attempt, outcome.recordId, reviewId, 204)
    return true
  }

  /** §10.3 steps 4-5: ONE `POST …/reviews` under one record, then marker-first recovery when it is unknown. */
  private async submitReview(
    cp: CodeHostReviewControlPlane,
    attempt: GiteaAttempt,
    event: CodeReviewEvent
  ): Promise<SubmitResult> {
    const { turn, req } = attempt
    const attribution = await this.deps.attribution?.(turn)
    const body = {
      commit_id: turn.expectedHeadSha,
      event: GITEA_EVENT[event],
      body: this.render(req.body, attribution, attempt.signer.mint(attempt.attemptId, 0, turn.expectedHeadSha)),
      comments: (req.comments ?? []).map((comment, index) => this.inlineComment(attempt, comment, index + 1))
    }
    const outcome = await this.mutate(cp, attempt, 'bulk_publish', 'POST', `${this.pullPath(turn)}/reviews`, body)
    if (outcome.kind === 'rejected') {
      const message = text(record(outcome.parsed).message) ?? ''
      return outcome.status === 422 && SELF_REVIEW_REFUSAL.test(message)
        ? { kind: 'self_review_forbidden' }
        : { kind: 'not_submitted' }
    }
    if (outcome.kind === 'sent') {
      const review = record(outcome.parsed)
      const id = idOf(review.id)
      const published = text(review.state)
      if (id) attempt.externalIds.push({ kind: 'review', externalId: id })
      return {
        kind: 'submitted',
        review: {
          id: id ?? '',
          ...(published && EVENT_OF_STATE[published] ? { event: EVENT_OF_STATE[published] } : {})
        }
      }
    }
    // §15.2: retain ownership and search the pull request for THIS attempt's summary marker.
    const deadline = this.now() + (this.deps.ambiguousWindowMs ?? DEFAULT_AMBIGUOUS_WINDOW_MS)
    for (;;) {
      const found = await this.findSubmittedReview(attempt, attempt.attemptId, turn.expectedHeadSha).catch(
        () => undefined
      )
      if (found) {
        attempt.externalIds.push({ kind: 'review', externalId: found.id })
        await this.upgradeAmbiguous(cp, attempt, outcome.recordId, found.id, 200)
        return { kind: 'submitted', review: found }
      }
      if (this.now() >= deadline) break
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
    // A pending review carrying this attempt's inline markers proves staging, not submission: still locked.
    return { kind: 'ambiguous_locked' }
  }

  /** A submitted (never pending, never reviewer-request) review by the bot carrying the attempt's summary marker. */
  private async findSubmittedReview(
    session: ReviewSession<GiteaReviewTurn>,
    attemptId: string,
    headSha: string,
    by?: ReviewMarkerSigner
  ): Promise<SubmittedReview | undefined> {
    const signer = by ?? (await this.markerSigner())
    for (const review of await this.listReviews(session)) {
      if (review.state === undefined || review.state === 'PENDING' || review.state === 'REQUEST_REVIEW') continue
      const marker = signer.read(review.body, headSha)
      if (marker?.attemptId !== attemptId.toLowerCase() || marker.ordinal !== 0) continue
      const event = EVENT_OF_STATE[review.state]
      return { id: review.id, ...(event ? { event } : {}) }
    }
    return undefined
  }

  /** Every review of the pull request, bounded; the list is unfiltered and shows the bot its own pending row (§16). */
  private async listReviews(session: ReviewSession<GiteaReviewTurn>): Promise<ReviewRow[]> {
    const rows: ReviewRow[] = []
    for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
      const parsed = await this.get(
        session,
        `${this.pullPath(session.turn)}/reviews`,
        `page=${page}&limit=${REVIEW_PAGE_SIZE}`
      )
      const batch = reviewRows(parsed)
      rows.push(...batch)
      if (!Array.isArray(parsed) || parsed.length < REVIEW_PAGE_SIZE) break
    }
    return rows
  }

  /** Single-line inline comments (§10.3): `RIGHT` → `new_position`, `LEFT` → `old_position`; a range collapses to its end line and names its start first. */
  private inlineComment(
    attempt: GiteaAttempt,
    comment: CodeReviewInlineComment,
    ordinal: number
  ): Record<string, unknown> {
    const range = comment.startLine !== undefined && comment.startLine !== comment.line
    const lead = range ? `Lines ${comment.startLine}-${comment.line}:\n\n` : ''
    const body = `${lead}${ReviewMarkerSigner.neutralize(comment.body)}\n\n${attempt.signer.mint(attempt.attemptId, ordinal, attempt.turn.expectedHeadSha)}`
    return {
      path: comment.path,
      body,
      ...(comment.side === 'LEFT' ? { old_position: comment.line } : { new_position: comment.line })
    }
  }

  private render(body: string, attribution: GithubCommentAttribution | undefined, marker: string): string {
    return appendGithubMarkdownChrome(
      ReviewMarkerSigner.neutralize(body),
      `${githubAttributionFooter(attribution)}\n\n${marker}`
    )
  }

  private pullPath(turn: GiteaReviewTurn): string {
    return `${giteaRepoPath(turn.repoPath)}/pulls/${turn.subjectNumber}`
  }
}
