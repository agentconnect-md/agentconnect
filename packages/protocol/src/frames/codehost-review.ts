import { z } from 'zod'
import { CodeHostExternalId, CodeHostProviderString } from '../code-host.js'
import { HookConfigSnapshot, HookReviewEvent, HookReviewVerdict } from './hook.js'

/**
 * Provider-neutral formal code-review control frames (gitlab-com-integration.md
 * §15, §15.1, §15.2, §17.2), gated by `codehost-review-v1`.
 *
 * The existing GitHub pair (`github/review-authorize` / `github/review-result`)
 * stays exactly as it is: it is repository/pull-shaped and its GitHub sibling
 * `rc/github-comment-authz` is `.strict()`, which is precisely why neither could
 * be extended in place. Nothing here is `.strict()` for the same reason — an
 * additive field must degrade per-value on both ends, never make a frame
 * undecodable.
 *
 * Review bodies and inline comments never cross this wire. The Control Plane
 * sees the attempt id, provider identities, event, verdict, head SHA, the
 * operation ledger, and one normalized outcome — nothing else.
 */

/**
 * Monotonic decimal fence carried by every lease-bound frame. Same wire form as
 * a provider numeric id; a separate name because it is a counter, not an
 * identity, and it is never presented as a provider-side fence (§15.1).
 */
export const CodeHostReviewFence = CodeHostExternalId
export type CodeHostReviewFence = z.infer<typeof CodeHostReviewFence>

/** Phase of the durable publication lease (§15.1). `ambiguous_locked` is terminal
 *  and has no timeout and no force-unlock. */
export const CodeHostReviewLeasePhase = z.enum(['open', 'publishing', 'classifying', 'settled', 'ambiguous_locked'])
export type CodeHostReviewLeasePhase = z.infer<typeof CodeHostReviewLeasePhase>

/** The lease grant for `(project, merge-request IID, service-account user)`. */
export const CodeHostReviewLeaseGrant = z.object({
  attemptId: z.string().uuid(),
  fence: CodeHostReviewFence,
  leaseUntil: z.string().datetime(),
  // The one publishing identity every agent on the project shares (§15.1).
  serviceAccountUserId: CodeHostExternalId
})
export type CodeHostReviewLeaseGrant = z.infer<typeof CodeHostReviewLeaseGrant>

/**
 * Why the Control Plane declined to authorize an attempt. These are ordinary
 * control outcomes the adapter must classify precisely, not transport failures,
 * so they ride the typed reply; a genuine fault still comes back as `error`.
 */
export const CodeHostReviewRefusalReason = z.enum([
  'policy_denied', // hook/agent/placement fence or the review policy refuses this event
  'head_changed', // the accepted turn's head is not the head the adapter asked for
  'lease_held', // another live attempt owns the publication lease — retryable
  'ambiguous_locked', // §15.1 fail-closed: this merge request admits no new attempt
  'reviewer_assignment_required', // REQUEST_CHANGES without a current service-account reviewer record
  'binding_unavailable' // no ready project binding / service account to publish as
])
export type CodeHostReviewRefusalReason = z.infer<typeof CodeHostReviewRefusalReason>

/**
 * `codehost/review-authz` (D→C REQ) — authorize ONE formal review attempt on one
 * merge request. The adapter names the exact hook delivery, project, IID, event,
 * verdict, configuration/dispatch revisions, and head it holds in daemon-private
 * active-turn state; the Control Plane re-resolves the hook, agent, binding, and
 * current placement live and answers with the publication lease or a refusal.
 */
export const CodeHostReviewAuthorize = z.object({
  hookId: z.string().uuid(),
  deliveryKey: z.string().min(1),
  attemptId: z.string().uuid(),
  provider: CodeHostProviderString,
  projectId: CodeHostExternalId, // numeric project id — the rename-stable match key
  mergeRequestIid: z.number().int().positive(),
  requestedEvent: HookReviewEvent,
  requestedVerdict: HookReviewVerdict,
  snapshot: HookConfigSnapshot,
  headSha: z.string().min(1),
  baseSha: z.string().min(1).optional(),
  // REQUEST_CHANGES needs a current service-account reviewer record; the adapter
  // reports what it read so the CP can refuse before any draft exists (§15 step 7).
  serviceAccountIsReviewer: z.boolean().optional()
})
export type CodeHostReviewAuthorize = z.infer<typeof CodeHostReviewAuthorize>

/** `codehost/review-authz/result` (C→D REP). */
export const CodeHostReviewAuthorized = z.discriminatedUnion('authorized', [
  z.object({
    authorized: z.literal(true),
    attemptId: z.string().uuid(),
    provider: CodeHostProviderString,
    projectId: CodeHostExternalId,
    mergeRequestIid: z.number().int().positive(),
    projectPath: z.string().min(1).optional(), // display only, never a match key
    expectedHeadSha: z.string().min(1),
    expectedBaseSha: z.string().min(1).optional(),
    lease: CodeHostReviewLeaseGrant
  }),
  z.object({
    authorized: z.literal(false),
    attemptId: z.string().uuid(),
    reason: CodeHostReviewRefusalReason,
    // `ambiguous_locked` is never retryable: recovery needs a definite outcome
    // from the old broker or positive provider evidence, not another try.
    retryable: z.boolean()
  })
])
export type CodeHostReviewAuthorized = z.infer<typeof CodeHostReviewAuthorized>

/** The provider mutations that need a single-use operation record (§15.1). */
export const CodeHostReviewOpKind = z.enum(['draft_create', 'draft_delete', 'bulk_publish', 'approval'])
export type CodeHostReviewOpKind = z.infer<typeof CodeHostReviewOpKind>

/** HTTP method of the one outbound request a record permits. */
export const CodeHostReviewOpMethod = z.enum(['POST', 'PUT', 'PATCH', 'DELETE'])
export type CodeHostReviewOpMethod = z.infer<typeof CodeHostReviewOpMethod>

/**
 * Request path of that one outbound request. A bounded path charset, so the
 * ledger is body-free by construction and no review text can ride it.
 */
export const CodeHostReviewOpTarget = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[A-Za-z0-9/_.:%-]*$/)
export type CodeHostReviewOpTarget = z.infer<typeof CodeHostReviewOpTarget>

/** Short machine code only; provider error text never crosses this wire. */
export const CodeHostReviewOpCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_:-]+$/)
export type CodeHostReviewOpCode = z.infer<typeof CodeHostReviewOpCode>

/** Durable state of one operation record. */
export const CodeHostReviewOpState = z.enum(['issued', 'request_started', 'settled', 'ambiguous', 'unused'])
export type CodeHostReviewOpState = z.infer<typeof CodeHostReviewOpState>

/**
 * What the one permitted outbound request returned. `deterministic` also covers
 * a provider rejection — what makes it deterministic is that the adapter knows
 * whether an effect exists. An `externalId` on a record that was previously
 * `ambiguous` is the positive marker identification of §15.1's fourth transfer
 * condition.
 */
export const CodeHostReviewOpOutcome = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deterministic'),
    status: z.number().int().min(100).max(599),
    externalId: CodeHostExternalId.optional(),
    code: CodeHostReviewOpCode.optional()
  }),
  z.object({ kind: z.literal('ambiguous'), code: CodeHostReviewOpCode })
])
export type CodeHostReviewOpOutcome = z.infer<typeof CodeHostReviewOpOutcome>

/**
 * `codehost/review-op` (D→C REQ) — the single-use operation-record ledger.
 *
 * `issue` mints a record bound to attempt, fence, kind, method, target, and
 * ordinal. `start` moves it `issued` → `request_started` atomically, immediately
 * before the outbound request, and permits exactly one such request:
 * `startToken` is the adapter's id for that one intended request, so a lost
 * reply can be retransmitted while a second, different start is refused.
 * `settle` records the deterministic response or `response_ambiguous`, and
 * `return-unused` durably returns a record no request ever started.
 */
export const CodeHostReviewOpRequest = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('issue'),
    attemptId: z.string().uuid(),
    fence: CodeHostReviewFence,
    kind: CodeHostReviewOpKind,
    method: CodeHostReviewOpMethod,
    target: CodeHostReviewOpTarget,
    ordinal: z.number().int().nonnegative()
  }),
  z.object({
    op: z.literal('start'),
    attemptId: z.string().uuid(),
    fence: CodeHostReviewFence,
    recordId: z.string().uuid(),
    startToken: z.string().uuid()
  }),
  z.object({
    op: z.literal('settle'),
    attemptId: z.string().uuid(),
    fence: CodeHostReviewFence,
    recordId: z.string().uuid(),
    outcome: CodeHostReviewOpOutcome
  }),
  z.object({
    op: z.literal('return-unused'),
    attemptId: z.string().uuid(),
    fence: CodeHostReviewFence,
    recordId: z.string().uuid()
  })
])
export type CodeHostReviewOpRequest = z.infer<typeof CodeHostReviewOpRequest>

/** `codehost/review-op/ok` (C→D REP) — the record's durable state after the op. */
export const CodeHostReviewOpAccepted = z.object({
  op: z.enum(['issue', 'start', 'settle', 'return-unused']),
  recordId: z.string().uuid(),
  attemptId: z.string().uuid(),
  fence: CodeHostReviewFence,
  kind: CodeHostReviewOpKind,
  ordinal: z.number().int().nonnegative(),
  state: CodeHostReviewOpState,
  phase: CodeHostReviewLeasePhase
})
export type CodeHostReviewOpAccepted = z.infer<typeof CodeHostReviewOpAccepted>

/** `codehost/review-lease-renew` (D→C REQ) — owner-only lease extension (§15.1). */
export const CodeHostReviewLeaseRenew = z.object({
  attemptId: z.string().uuid(),
  fence: CodeHostReviewFence
})
export type CodeHostReviewLeaseRenew = z.infer<typeof CodeHostReviewLeaseRenew>

/** `codehost/review-lease-renew/ok` (C→D REP). The phase is CP-derived: an adapter
 *  never asserts it, it is a consequence of the operation ledger and the result. */
export const CodeHostReviewLeaseRenewed = z.object({
  attemptId: z.string().uuid(),
  fence: CodeHostReviewFence,
  leaseUntil: z.string().datetime(),
  phase: CodeHostReviewLeasePhase
})
export type CodeHostReviewLeaseRenewed = z.infer<typeof CodeHostReviewLeaseRenewed>

/**
 * Normalized outcome vocabulary (§15.2). `submitted` is the clean terminal; every
 * other value records exactly what remained unproven, and none of them carries a
 * body, a reason string, or provider prose.
 */
export const CodeHostReviewState = z.enum([
  'submitted',
  'not_submitted',
  'ambiguous_locked',
  'approval_not_recorded',
  'review_state_not_recorded',
  'review_state_changed_unexpectedly',
  'requested_changes_block_observed',
  'requested_changes_state_ambiguous',
  'reviewer_assignment_required',
  'review_reconciliation_required'
])
export type CodeHostReviewState = z.infer<typeof CodeHostReviewState>

/** Whether a public provider effect exists for a normalized outcome. */
export type CodeHostReviewPublicEffect = 'present' | 'absent' | 'unknown'

const PUBLIC_EFFECT: Record<CodeHostReviewState, CodeHostReviewPublicEffect> = {
  submitted: 'present',
  approval_not_recorded: 'present',
  review_state_not_recorded: 'present',
  review_state_changed_unexpectedly: 'present',
  requested_changes_block_observed: 'present',
  requested_changes_state_ambiguous: 'present',
  not_submitted: 'absent',
  reviewer_assignment_required: 'absent',
  ambiguous_locked: 'unknown',
  review_reconciliation_required: 'unknown'
}

/**
 * §15.2's public-effect rule as data: once an effect exists the adapter must not
 * republish and must not fall back to an ordinary comment, and once it is
 * unknown the merge request stays fail-closed. Shared so the CP and the adapter
 * cannot disagree about which outcomes those are.
 */
export function codeHostReviewPublicEffect(state: CodeHostReviewState): CodeHostReviewPublicEffect {
  return PUBLIC_EFFECT[state]
}

/** One published provider object, by kind and numeric id. No URLs, no text. */
export const CodeHostReviewExternalRef = z.object({
  kind: z.enum(['note', 'draft_note', 'discussion', 'approval']),
  externalId: CodeHostExternalId
})
export type CodeHostReviewExternalRef = z.infer<typeof CodeHostReviewExternalRef>

/**
 * `codehost/review-result` (D→C REQ) — the body-free terminal classification of
 * one attempt. It is the moment publication, reviewer state, and any approval
 * outcome become durably classified, so it is also the moment the lease is
 * released (or locked, for the two outcomes that prove nothing).
 */
export const CodeHostReviewResultReport = z
  .object({
    hookId: z.string().uuid(),
    deliveryKey: z.string().min(1),
    attemptId: z.string().uuid(),
    snapshot: HookConfigSnapshot,
    provider: CodeHostProviderString,
    projectId: CodeHostExternalId,
    mergeRequestIid: z.number().int().positive(),
    event: HookReviewEvent,
    verdict: HookReviewVerdict,
    headSha: z.string().min(1),
    state: CodeHostReviewState,
    externalIds: z.array(CodeHostReviewExternalRef).max(64).optional()
  })
  .superRefine((report, ctx) => {
    if (codeHostReviewPublicEffect(report.state) === 'absent' && (report.externalIds?.length ?? 0) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalIds'],
        message: `${report.state} is a proven no-effect outcome and cannot name a published object`
      })
    }
  })
export type CodeHostReviewResultReport = z.infer<typeof CodeHostReviewResultReport>

/** `codehost/review-result/ok` (C→D REP). */
export const CodeHostReviewResultOk = z.object({
  accepted: z.literal(true),
  phase: CodeHostReviewLeasePhase
})
export type CodeHostReviewResultOk = z.infer<typeof CodeHostReviewResultOk>
