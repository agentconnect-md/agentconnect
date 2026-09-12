// GitLab formal merge-request reviews (gitlab-com-integration.md §15): the thirteen steps over the seam's engine in codehost/review-attempt.ts.
import {
  codeHostReviewPublicEffect,
  type CodeHostReviewOpOutcome,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewState
} from '@agentconnect.md/protocol'
import type { CodeReviewOperation, HookDispatchContext } from '../github/hook-coords.js'
import { gitlabOpensReviewGeneration } from '../messages/hook-message.js'
import type { SubmitCodeReviewReq } from '../codehost/review-adapter.js'
import {
  CodeHostReviewAttemptAdapter,
  idOf,
  record,
  text,
  DEFAULT_AMBIGUOUS_WINDOW_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type CodeHostReviewAdapterDeps,
  type CodeHostReviewAttempt,
  type CodeHostReviewOutcome,
  type CodeHostReviewTurn,
  type PreLeaseFacts,
  type ReviewSession
} from '../codehost/review-attempt.js'
import type { CodeHostReviewControlPlane } from '../codehost/review-outbox.js'
import { appendGithubMarkdownChrome, githubAttributionFooter, type GithubCommentAttribution } from '../github/poster.js'
import { ReviewMarkerSigner } from '../codehost/review-marker.js'

export type { ReviewIntentRow, ReviewIntentStore } from '../codehost/review-outbox.js'

/** One authorized merge-request review turn: `repoId` is the numeric project id, `subjectNumber` the MR IID. */
export type GitlabReviewTurn = CodeHostReviewTurn

/** The narrow Control-Plane surface this adapter needs (§15.1 lease + operation ledger). */
export type GitlabReviewControlPlane = CodeHostReviewControlPlane

export interface GitlabReviewAdapterDeps extends CodeHostReviewAdapterDeps<GitlabReviewTurn> {
  /** §15.2/§15 step 13 bounded wait for `detailed_merge_status` to leave its unstable values. */
  mergeStatusWindowMs?: number
}

export type GitlabReviewOutcome = CodeHostReviewOutcome

const DEFAULT_MERGE_STATUS_WINDOW_MS = 30_000
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

const REFUSAL_DETAIL: Partial<Record<CodeHostReviewRefusalReason, string>> = {
  lease_held: ' Another review attempt currently owns publication on this merge request.',
  head_changed: ' The merge request head changed while this turn was running.',
  policy_denied: " This hook's review policy does not permit that review event.",
  binding_unavailable: ' This project has no ready GitLab binding to publish as.'
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

interface GitlabFacts extends PreLeaseFacts {
  reviewerBefore?: ReviewerRecord
}

/** Everything one GitLab attempt carries between steps. */
interface GitlabAttempt extends CodeHostReviewAttempt<GitlabReviewTurn> {
  /** Draft ordinal (0 = summary) → provider draft id, for the exact-set check. */
  drafts: Map<number, string>
  reviewerBefore?: ReviewerRecord
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

export class GitlabReviewAdapter extends CodeHostReviewAttemptAdapter<GitlabReviewTurn, GitlabAttempt, GitlabFacts> {
  readonly provider = 'gitlab' as const
  protected readonly hostLabel = 'GitLab'
  protected readonly subjectLabel = 'merge-request'

  constructor(protected override readonly deps: GitlabReviewAdapterDeps) {
    super(deps)
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
      repoId: gitlab.projectId,
      repoPath: gitlab.projectPath,
      subjectNumber: gitlab.target.iid,
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

  protected outcomeSentence(state: CodeHostReviewState): string {
    return OUTCOME_SENTENCE[state]
  }

  protected refusalDetail(reason: CodeHostReviewRefusalReason): string {
    return REFUSAL_DETAIL[reason] ?? ''
  }

  protected authHeaders(token: string): Record<string, string> {
    return { 'private-token': token }
  }

  /** Read pre-lease so the authz can carry the §15 step 6/7 reviewer fact and prove the leased account is ours. */
  protected async preLeaseFacts(session: ReviewSession<GitlabReviewTurn>): Promise<GitlabFacts> {
    const publisherUserId = idOf(record(await this.get(session, '/user')).id)
    if (!publisherUserId) throw new Error('GitLab did not identify the review publishing account')
    const reviewersBefore = reviewerRecords(await this.get(session, this.mrPath(session.turn, '/reviewers')))
    const reviewerBefore = reviewersBefore.find((row) => row.userId === publisherUserId)
    return {
      publisherUserId,
      serviceAccountIsReviewer: reviewerBefore !== undefined,
      ...(reviewerBefore ? { reviewerBefore } : {})
    }
  }

  protected openAttempt(base: CodeHostReviewAttempt<GitlabReviewTurn>, facts: GitlabFacts): GitlabAttempt {
    return { ...base, drafts: new Map(), ...(facts.reviewerBefore ? { reviewerBefore: facts.reviewerBefore } : {}) }
  }

  protected async publish(cp: CodeHostReviewControlPlane, attempt: GitlabAttempt): Promise<GitlabReviewOutcome> {
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
  protected async reconcileOperations(
    cp: CodeHostReviewControlPlane,
    attempt: GitlabAttempt
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

  /** A draft create is proven by its marker; a draft delete is proven by the absence it asked for. */
  private classifyDraftOperation(
    op: CodeReviewOperation,
    marked: Map<number, string>,
    attempt: GitlabAttempt
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

  /** §15.1 orphan recovery, run while holding the lease and before any create. */
  private async reconcileDrafts(
    cp: CodeHostReviewControlPlane,
    attempt: GitlabAttempt
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
  private async deleteDraft(cp: CodeHostReviewControlPlane, attempt: GitlabAttempt, draftId: string): Promise<boolean> {
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

  private async deleteAttemptDrafts(cp: CodeHostReviewControlPlane, attempt: GitlabAttempt): Promise<void> {
    for (const draftId of [...attempt.drafts.values()]) {
      await this.deleteDraft(cp, attempt, draftId).catch(() => false)
    }
    attempt.drafts.clear()
  }

  /** §15 step 8: one regular summary draft plus one diff draft per inline comment. */
  private async createDrafts(
    cp: CodeHostReviewControlPlane,
    attempt: GitlabAttempt,
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

  private async findDraftByOrdinal(attempt: GitlabAttempt, ordinal: number): Promise<string | undefined> {
    const pending = draftNotes(await this.get(attempt, this.mrPath(attempt.turn, '/draft_notes')).catch(() => []))
    for (const draft of pending) {
      const marker = attempt.signer.read(draft.note, attempt.turn.expectedHeadSha)
      if (marker?.attemptId === attempt.attemptId.toLowerCase() && marker.ordinal === ordinal) return draft.id
    }
    return undefined
  }

  private async listDraftIds(attempt: GitlabAttempt): Promise<Set<string>> {
    const pending = draftNotes(await this.get(attempt, this.mrPath(attempt.turn, '/draft_notes')))
    return new Set(pending.map((draft) => draft.id))
  }

  /** §15 step 9/11: every pending draft carries this attempt's marker and the ordinal set is exact. */
  private async draftSetIsExact(attempt: GitlabAttempt): Promise<boolean> {
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

  private async readReviewer(attempt: GitlabAttempt): Promise<ReviewerRecord | undefined> {
    const rows = reviewerRecords(await this.get(attempt, this.mrPath(attempt.turn, '/reviewers')))
    return rows.find((row) => row.userId === attempt.publisherUserId)
  }

  /** §15 step 11 + §15.2: ONE bulk publish, then marker-first recovery when it is unknown. */
  private async bulkPublish(
    cp: CodeHostReviewControlPlane,
    attempt: GitlabAttempt
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

  private async findSummaryNote(attempt: GitlabAttempt): Promise<string | undefined> {
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
    attempt: GitlabAttempt,
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
  private async stableMergeStatus(attempt: GitlabAttempt, recheck: boolean): Promise<string | undefined> {
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
    cp: CodeHostReviewControlPlane,
    attempt: GitlabAttempt,
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
  private async diffIsReady(attempt: GitlabAttempt): Promise<boolean> {
    const deadline = this.now() + (this.deps.mergeStatusWindowMs ?? DEFAULT_MERGE_STATUS_WINDOW_MS)
    for (;;) {
      const versions = await this.get(attempt, this.mrPath(attempt.turn, '/versions')).catch(() => undefined)
      const latest = Array.isArray(versions) ? record(versions[0]) : {}
      if (text(latest.patch_id_sha)) return true
      if (this.now() >= deadline) return false
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
  }

  private approvalReadback(parsed: unknown, attempt: GitlabAttempt): boolean {
    const body = record(parsed)
    const sha = text(body.sha)
    if (sha !== undefined && sha !== attempt.turn.expectedHeadSha) return false
    const approvers = Array.isArray(body.approved_by) ? body.approved_by : []
    return approvers.some((row) => idOf(record(record(row).user).id) === attempt.publisherUserId)
  }

  private render(body: string, attribution: GithubCommentAttribution | undefined, marker: string): string {
    return appendGithubMarkdownChrome(
      ReviewMarkerSigner.neutralize(body),
      `${githubAttributionFooter(attribution)}\n\n${marker}`
    )
  }

  private mrPath(turn: GitlabReviewTurn, suffix = ''): string {
    return `/projects/${turn.repoId}/merge_requests/${turn.subjectNumber}${suffix}`
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
