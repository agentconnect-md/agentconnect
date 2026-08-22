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
import {
  validateCodeReviewInput,
  type CodeHostReviewAdapter,
  type CodeReviewEvent,
  type CodeReviewVerdict,
  type SubmitCodeReviewReq
} from '../codehost/review-adapter.js'
import { reviewPolicyAllows, type HookDispatchContext } from '../github/hook-coords.js'
import { appendGithubMarkdownChrome, githubAttributionFooter, type GithubCommentAttribution } from '../github/poster.js'
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
  /** §15 step 1: one review attempt per turn, reserved synchronously. */
  state: 'idle' | 'submitting' | 'done'
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
  /** §14.1 effect lease: the binding's effect PAT; it never enters the agent environment. */
  token: (turn: GitlabReviewTurn) => Promise<string>
  invalidateToken: (turn: GitlabReviewTurn, token: string) => void
  attribution?: (turn: GitlabReviewTurn) => Promise<GithubCommentAttribution | undefined>
  log: { warn: (message: string) => void }
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Daemon-local marker key; see the trust model on {@link ReviewMarkerSigner}. */
  markerKey?: Buffer
  newAttemptId?: () => string
  newStartToken?: () => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** §15.2 bounded observation window for an ambiguous bulk publish. */
  ambiguousWindowMs?: number
  /** §15.2/§15 step 13 bounded wait for `detailed_merge_status` to leave its unstable values. */
  mergeStatusWindowMs?: number
  pollIntervalMs?: number
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

const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_AMBIGUOUS_WINDOW_MS = 30_000
const DEFAULT_MERGE_STATUS_WINDOW_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
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

/** Everything one attempt carries between steps. */
interface Attempt extends Session {
  req: SubmitCodeReviewReq
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
  private readonly signer: ReviewMarkerSigner
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: GitlabReviewAdapterDeps) {
    this.signer = new ReviewMarkerSigner(deps.markerKey)
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Install the active review turn for one logical session key. Returns undefined
   * for every delivery that is not an authorized merge-request review generation.
   */
  openTurn(
    key: string,
    hook: HookDispatchContext | undefined,
    sessionId: string,
    daemonId?: string
  ): GitlabReviewTurn | undefined {
    const gitlab = hook?.gitlab
    const snapshot = hook?.snapshot
    if (!hook || !gitlab || !snapshot || snapshot.reviewPolicy === 'off') return undefined
    if (gitlab.target.kind !== 'merge_request' || !gitlab.target.headSha) return undefined
    if (daemonId && snapshot.dispatchDaemonId !== daemonId) return undefined
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
      state: 'idle'
    }
    this.turns.set(key, turn)
    return turn
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
      turn.state = 'done'
      throw err
    }
  }

  private async run(
    turn: GitlabReviewTurn,
    req: SubmitCodeReviewReq,
    cp: GitlabReviewControlPlane
  ): Promise<GitlabReviewOutcome> {
    const orgId = this.deps.orgForAgent(turn.agentId)
    const attemptId = (this.deps.newAttemptId ?? randomUUID)()
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
    if (!authorized.authorized) return this.refused(req, authorized)
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
      ...(orgId ? { orgId } : {}),
      attemptId,
      fence: authorized.lease.fence,
      token: session.token,
      serviceAccountUserId,
      ordinals: new Map(),
      drafts: new Map(),
      externalIds: [],
      ...(reviewerBefore ? { reviewerBefore } : {})
    }
    // The leased publishing identity must be the account this effect token speaks as.
    if (authorized.lease.serviceAccountUserId !== serviceAccountUserId) {
      return this.settle(cp, attempt, 'not_submitted')
    }
    return await this.publish(cp, attempt)
  }

  private async publish(cp: GitlabReviewControlPlane, attempt: Attempt): Promise<GitlabReviewOutcome> {
    const { turn, req } = attempt

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

  /** §15.1 orphan recovery, run while holding the lease and before any create. */
  private async reconcileDrafts(
    cp: GitlabReviewControlPlane,
    attempt: Attempt
  ): Promise<GitlabReviewOutcome | undefined> {
    const { turn } = attempt
    const pending = draftNotes(await this.get(attempt, this.mrPath(turn, '/draft_notes')))
    const stale: string[] = []
    for (const draft of pending) {
      const marker = this.signer.read(draft.note, turn.expectedHeadSha)
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
    return remaining !== undefined && !remaining.has(draftId)
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
        note: this.render(req.body, attribution, this.signer.mint(attempt.attemptId, 0, turn.expectedHeadSha))
      })
    }
    ;(req.comments ?? []).forEach((comment, index) => {
      const ordinal = index + 1
      if (attempt.drafts.has(ordinal)) return
      bodies.push({
        ordinal,
        note: `${ReviewMarkerSigner.neutralize(comment.body)}\n\n${this.signer.mint(attempt.attemptId, ordinal, turn.expectedHeadSha)}`,
        position: diffPosition(comment, facts)
      })
    })
    for (const draft of bodies) {
      const outcome = await this.mutate(cp, attempt, 'draft_create', 'POST', this.mrPath(turn, '/draft_notes'), {
        note: draft.note,
        ...(draft.position ? { position: draft.position } : {})
      })
      if (outcome.kind === 'rejected') {
        await this.deleteAttemptDrafts(cp, attempt)
        return this.settle(cp, attempt, 'not_submitted')
      }
      if (outcome.kind === 'ambiguous') {
        // A draft is not a public effect: re-read by marker instead of retrying the POST.
        const recovered = await this.findDraftByOrdinal(attempt, draft.ordinal)
        if (!recovered) return this.settle(cp, attempt, 'review_reconciliation_required')
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
      const marker = this.signer.read(draft.note, attempt.turn.expectedHeadSha)
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
      const marker = this.signer.read(draft.note, attempt.turn.expectedHeadSha)
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
        await this.settleOperation(cp, attempt, outcome.recordId, {
          kind: 'deterministic',
          status: 201,
          externalId: note
        })
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
        const marker = this.signer.read(text(note.body), attempt.turn.expectedHeadSha)
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
    const approvalId = facts.numericId
    if (outcome.kind === 'sent' && this.approvalReadback(outcome.parsed, attempt)) {
      if (approvalId) attempt.externalIds.push({ kind: 'approval', externalId: approvalId })
      return 'submitted'
    }
    // Ambiguous or unconvincing: one read-only readback decides, and nothing retries.
    const readback = await this.get(attempt, this.mrPath(attempt.turn, '/approvals')).catch(() => undefined)
    if (!this.approvalReadback(readback, attempt)) return 'approval_not_recorded'
    if (approvalId) attempt.externalIds.push({ kind: 'approval', externalId: approvalId })
    if (outcome.kind === 'ambiguous') {
      // Positive identification of an ambiguous request, per §15.1's fourth condition.
      await this.settleOperation(cp, attempt, outcome.recordId, {
        kind: 'deterministic',
        status: 201,
        ...(approvalId ? { externalId: approvalId } : {})
      })
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
    body: Record<string, unknown> | undefined
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
      await this.startOperation(cp, attempt, issued.recordId, startToken)
      let result: SendResult
      try {
        result = await this.send(method, target, undefined, body, attempt.token)
      } catch (err) {
        if (err instanceof AmbiguousSend) {
          await this.settleOperation(cp, attempt, issued.recordId, { kind: 'ambiguous', code: err.code })
          return { kind: 'ambiguous', recordId: issued.recordId }
        }
        throw err
      }
      const authRejected = result.status === 401 || result.status === 403
      const externalId = idOf(record(result.parsed).id)
      await this.settleOperation(cp, attempt, issued.recordId, {
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

  private async settleOperation(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    recordId: string,
    outcome: CodeHostReviewOpOutcome
  ): Promise<void> {
    try {
      await cp.operate(
        { op: 'settle', attemptId: attempt.attemptId, fence: attempt.fence, recordId, outcome },
        attempt.orgId
      )
    } catch (err) {
      this.deps.log.warn(`gitlab review: operation settle deferred (${err instanceof Error ? err.message : err})`)
    }
  }

  /** Record the terminal classification, releasing (or locking) the publication lease. */
  private async settle(
    cp: GitlabReviewControlPlane,
    attempt: Attempt,
    state: CodeHostReviewState
  ): Promise<GitlabReviewOutcome> {
    const externalIds = codeHostReviewPublicEffect(state) === 'absent' ? [] : attempt.externalIds
    try {
      await cp.report(
        {
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
        },
        attempt.orgId
      )
    } catch (err) {
      this.deps.log.warn(`gitlab review: result report deferred (${err instanceof Error ? err.message : err})`)
    }
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
  private refused(
    req: SubmitCodeReviewReq,
    answer: Extract<CodeHostReviewAuthorized, { authorized: false }>
  ): GitlabReviewOutcome {
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
    return {
      provider: 'gitlab',
      state,
      event: req.event,
      verdict: req.verdict,
      message: `${OUTCOME_SENTENCE[state]}${detail}`
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
        result = await this.send('GET', path, query, undefined, session.token)
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
    token: string
  ): Promise<SendResult> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const url = `${this.deps.baseUrl ?? DEFAULT_BASE_URL}${path}${query ? `?${query}` : ''}`
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
