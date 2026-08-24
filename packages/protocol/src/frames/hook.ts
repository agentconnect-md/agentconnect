import { z } from 'zod'
import { CodeHostExternalId, CodeHostProviderString, HOOK_KINDS } from '../code-host.js'

/** Decimal wire form for Prisma/GitHub bigint values. */
export const HookBigIntString = z.string().regex(/^(?:0|[1-9]\d*)$/)
export type HookBigIntString = z.infer<typeof HookBigIntString>

/** The highest formal-review event one hook permits. */
export const HookReviewPolicy = z.enum(['off', 'comment', 'request_changes', 'full'])
export type HookReviewPolicy = z.infer<typeof HookReviewPolicy>

/** External run-reporting transport. `status` is reserved for the later R3. */
export const HookReportingMode = z.enum(['off', 'check', 'status'])
export type HookReportingMode = z.infer<typeof HookReportingMode>

/** R2a only admits informational; `required` remains a fail-closed future mode. */
export const HookGateMode = z.enum(['informational', 'required'])
export type HookGateMode = z.infer<typeof HookGateMode>

/**
 * Exact config + dispatch identity captured when the CP compiles a hook fire.
 *
 * The relay-facing frames expose these fields individually at top level so an
 * older CP/relay can omit them without making the whole fire undecodable. A
 * consumer MUST have every field before enabling review/reporting; absence is
 * not filled with a revision and therefore fails closed. Action-time RPCs use
 * this complete object so a partially rolled-out tuple cannot authorize an
 * effect.
 */
export const HookConfigSnapshot = z.object({
  configRevision: HookBigIntString,
  dispatchRevision: HookBigIntString,
  dispatchDaemonId: z.string().uuid(),
  reviewPolicy: HookReviewPolicy,
  reportingMode: HookReportingMode,
  gateMode: HookGateMode
})
export type HookConfigSnapshot = z.infer<typeof HookConfigSnapshot>

/** Optional top-level form used only on rolling-compatible delivery frames. */
export const OptionalHookConfigSnapshot = HookConfigSnapshot.partial()
export type OptionalHookConfigSnapshot = z.infer<typeof OptionalHookConfigSnapshot>

/** Signature-verified, body-free GitHub subject/revision metadata; optional review and comment ids preserve mixed-version decoding. */
export const GithubHookMetadata = z
  .object({
    repoId: HookBigIntString,
    repoFullName: z.string().min(1),
    sourceInstallationId: HookBigIntString,
    subjectKind: z.enum(['issue', 'pull_request']),
    pullNumber: z.number().int().positive().optional(),
    headSha: z.string().min(1).optional(),
    baseSha: z.string().min(1).optional(),
    reportSha: z.string().min(1).optional(),
    headRepoFullName: z.string().min(1).optional(),
    mergeCommitSha: z.string().min(1).optional(),
    isDraft: z.boolean().optional(),
    baseChanged: z.boolean().optional(),
    // Relay-derived from a newly-authored PR conversation comment that
    // explicitly mentions this agent or the App while the accepted rule
    // enables formal reviews. The body stays off the CP wire; only this
    // trusted routing fact reopens the review generation.
    explicitReviewRequest: z.boolean().optional(),
    pullRequestReviewId: HookBigIntString.refine((value) => value !== '0').optional(),
    reviewCommentId: HookBigIntString.optional(),
    reviewThreadRootCommentId: HookBigIntString.optional()
  })
  .superRefine((value, ctx) => {
    if (value.subjectKind === 'pull_request' && value.pullNumber === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['pullNumber'],
        message: 'pullNumber is required for a pull_request subject'
      })
    }
    if (value.reportSha !== undefined && value.headSha === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reportSha'],
        message: 'reportSha requires an authoritative headSha'
      })
    }
    if (value.reportSha !== undefined && value.headSha !== undefined && value.reportSha !== value.headSha) {
      ctx.addIssue({
        code: 'custom',
        path: ['reportSha'],
        message: 'R2a reports only the authoritative pull head SHA'
      })
    }
  })
export type GithubHookMetadata = z.infer<typeof GithubHookMetadata>

/** One GitLab hook subject: issue/MR by IID, or a standalone push ref (gitlab-com-integration.md §17.2). */
export const GitlabHookTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), iid: z.number().int().positive() }),
  z.object({
    kind: z.literal('merge_request'),
    iid: z.number().int().positive(),
    // Source-project + revision facts, present when the verified payload carries them.
    sourceProjectId: HookBigIntString.optional(),
    headSha: z.string().min(1).optional(),
    baseSha: z.string().min(1).optional(),
    isDraft: z.boolean().optional(),
    // Relay-derived trusted routing fact (reviewer request / authorized mention);
    // authored text stays off the CP wire, exactly like explicitReviewRequest above.
    explicitReviewRequest: z.boolean().optional()
  }),
  z.object({ kind: z.literal('push'), ref: z.string().min(1) })
])
export type GitlabHookTarget = z.infer<typeof GitlabHookTarget>

/** Signature-verified, body-free GitLab subject metadata — the trusted normalization
 *  discriminator the daemon recomputes session keys from; never inferred from model-visible text. */
export const GitlabHookMetadata = z.object({
  projectId: HookBigIntString,
  projectPath: z.string().min(1), // current namespaced path — display only, never a match key
  webhookId: HookBigIntString.optional(),
  // The instance this delivery came from, copied from the compiled rule and never read
  // off the payload (§24.4). The turn-time fence: a delivery whose host disagrees with the
  // session's spec-carried host is refused, never re-targeted. Absent means GitLab.com.
  host: z.string().optional(),
  target: GitlabHookTarget
})
export type GitlabHookMetadata = z.infer<typeof GitlabHookMetadata>

export const HookReviewEvent = z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE'])
export type HookReviewEvent = z.infer<typeof HookReviewEvent>

export const HookReviewVerdict = z.enum(['pass', 'fail', 'neutral'])
export type HookReviewVerdict = z.infer<typeof HookReviewVerdict>

/** Short machine code only; raw GitHub/runtime exception text never crosses to reporting. */
const HookReviewResultCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_:-]+$/)

/**
 * Body-free outcome of one reserved formal-review attempt.
 *
 * `not_submitted` is only legal after a deterministic no-effect failure and
 * lets the CP release the reservation. An uncertain POST remains `ambiguous`
 * until marker reconciliation proves whether GitHub created it.
 */
export const HookReviewResult = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('submitted'),
    reviewId: z.string().min(1),
    event: HookReviewEvent,
    verdict: HookReviewVerdict,
    commitId: z.string().min(1)
  }),
  z.object({ state: z.literal('not_submitted'), code: HookReviewResultCode }),
  z.object({ state: z.literal('ambiguous'), code: HookReviewResultCode })
])
export type HookReviewResult = z.infer<typeof HookReviewResult>

/** Body-free identity of the daemon's one fallback GitHub comment. */
export const GithubPublishedComment = z.object({
  kind: z.enum(['issue_comment', 'review_comment']),
  commentId: HookBigIntString
})
export type GithubPublishedComment = z.infer<typeof GithubPublishedComment>

/** Provider-neutral counterpart of GithubPublishedComment: the one published output's
 *  identity (e.g. a GitLab note id). `kind` is provider vocabulary, open by design. */
export const PublishedHookOutput = z.object({
  provider: CodeHostProviderString,
  kind: z.string().min(1), // e.g. 'note'
  externalId: CodeHostExternalId
})
export type PublishedHookOutput = z.infer<typeof PublishedHookOutput>

/**
 * Hook (inbound-webhook trigger) frames — webhook-triggers-and-github-events.md.
 *
 * A hook maps an inbound webhook delivery to ONE AGENT turn. The CP owns the
 * definition (`HookDef`) and compiles it into relay-side rules
 * (`rc/hook-assign`, frames/relay-cp.ts); the relay pool is the public ingress
 * that verifies + matches + dispatches the trigger to the target daemon as an
 * `rd/msg` `hook` member (frames/relay-daemon.ts). Event payloads never touch
 * the CP. R1/R2a add only metadata barriers and action-result control frames;
 * the model-visible body remains relay↔daemon.
 */

/**
 * The trimmed event envelope a fire carries — bounded excerpts only; the full
 * payload lives in relay/daemon memory for the duration of the dispatch and the
 * agent pulls source-of-truth content itself (gh / API) when it needs more.
 * The whole frame rides under the 256 KiB frame cap; these excerpt caps are far
 * below it. Trust differs by kind (design security boundary 1): a webhook `body` IS the
 * caller's message (the URL is a capability credential), while github excerpts
 * (P2) are untrusted third-party content the daemon fences in the prompt.
 */
export const HookContext = z.object({
  source: z.enum(HOOK_KINDS),
  // ── github (P2) ──
  event: z.string().optional(), // 'issues' | 'pull_request' | 'issue_comment'
  action: z.string().optional(), // 'opened' | 'synchronize' | 'created' | …
  repo: z.string().optional(), // 'owner/repo'
  number: z.number().int().optional(), // issue/PR number
  title: z.string().optional(),
  senderLogin: z.string().optional(),
  senderAvatarUrl: z.string().url().optional(),
  authorAssociation: z.string().optional(),
  labels: z.array(z.string()).optional(),
  htmlUrl: z.string().optional(),
  bodyExcerpt: z.string().optional(), // ≤4 KiB
  // ── webhook ──
  body: z.string().optional(), // raw body, truncated to ≤64 KiB
  truncated: z.boolean().optional()
})
export type HookContext = z.infer<typeof HookContext>

/**
 * Normalized quota failure: the operational HookRun remains failed while an
 * informational GitHub Check may intentionally project the outcome as skipped.
 */
export const HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED = 'provider_quota_exhausted' as const

/**
 * Normalized provider sign-in failure: the runtime cannot run until a human
 * refreshes its credentials, so an informational GitHub Check is skipped
 * instead of reported as a code-review failure.
 */
export const HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED = 'provider_auth_required' as const

/** Normalized infrastructure interruption: the daemon stopped serving the agent mid-turn (a duty
 * handover, or a self-fence on an unrenewed lease). Distinct from a user stop because nothing was
 * judged and the same work can simply be run again. */
export const HOOK_REPORT_REASON_AGENT_HANDOVER = 'agent_handover' as const

/**
 * `hook/report` (D→C REQ → generic `ack`) — the dispatched turn ended; closes
 * the `HookRun` row the relay's `rc/run-report` opened. Same discipline as
 * `cron/report`: scoped (the agent must be placed on the reporting daemon),
 * latest-wins, lost reports harvested by the HookRunReaper (late arrivals may
 * still overwrite `orphaned`). The daemon retains a metadata-only outbox entry
 * until ACK. Keyed by `(hookId, deliveryKey)`.
 */
export const HookReport = z
  .object({
    hookId: z.string().uuid(),
    agentId: z.string().uuid(), // the owning agent — scopes the report to its daemon
    deliveryKey: z.string().min(1),
    // Rolling-compatible copy of the exact accepted dispatch tuple. Every field
    // is optional on the delivery frame, but review/report consumers require the
    // complete HookConfigSnapshot before taking an effect.
    ...OptionalHookConfigSnapshot.shape,
    event: z.string().min(1).optional(), // 'pull_request:synchronize', etc.
    github: GithubHookMetadata.optional(),
    gitlab: GitlabHookMetadata.optional(),
    status: z.enum(['success', 'failed']),
    durationMs: z.number().int().nonnegative().optional(), // dispatch → turn end
    sessionId: z.string().optional(), // the session the run prompted, by its outward id (§1.1)
    reason: z.string().optional(), // short failure text (status "failed")
    // A submitted result is repeated here as recovery if the immediate
    // github/review-result request was lost. No review/comment body crosses CP.
    reviewAttemptId: z.string().uuid().optional(),
    reviewResult: HookReviewResult.optional(),
    // Exact public fallback location. The comment body remains daemon-owned.
    publishedComment: GithubPublishedComment.optional(),
    // Provider-neutral counterpart (one of the two, never both).
    publishedOutput: PublishedHookOutput.optional()
  })
  .superRefine((report, ctx) => {
    if ((report.reviewAttemptId === undefined) !== (report.reviewResult === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: report.reviewAttemptId === undefined ? ['reviewAttemptId'] : ['reviewResult'],
        message: 'reviewAttemptId and reviewResult must be reported together'
      })
    }
    if ((report.publishedComment || report.publishedOutput) && report.reviewResult?.state === 'submitted') {
      ctx.addIssue({
        code: 'custom',
        path: [report.publishedComment ? 'publishedComment' : 'publishedOutput'],
        message: 'a submitted formal review and fallback comment are mutually exclusive'
      })
    }
    if (report.publishedComment && report.publishedOutput) {
      ctx.addIssue({
        code: 'custom',
        path: ['publishedOutput'],
        message: 'publishedComment and publishedOutput are mutually exclusive'
      })
    }
    if (report.github && report.gitlab) {
      ctx.addIssue({
        code: 'custom',
        path: ['gitlab'],
        message: 'github and gitlab metadata are mutually exclusive'
      })
    }
  })
export type HookReport = z.infer<typeof HookReport>

/**
 * `hook/start` (D→C REQ) — metadata barrier immediately before an accepted
 * GitHub hook enters the model prompt. A successful reply means the CP durably
 * attached the authoritative revision to the accepted HookRun and, for R2a,
 * advanced its informational projection to in_progress.
 */
export const HookStart = z
  .object({
    hookId: z.string().uuid(),
    agentId: z.string().uuid(),
    deliveryKey: z.string().min(1),
    sessionId: z.string().min(1).optional(), // the turn's session by its outward id (§1.1); rolling-compatible
    event: z.string().min(1).optional(),
    // Provider one-of: exactly one member carries the trusted subject metadata.
    // `github` was required pre-GitLab, so every existing sender stays valid.
    github: GithubHookMetadata.optional(),
    gitlab: GitlabHookMetadata.optional(),
    ...HookConfigSnapshot.shape
  })
  .superRefine((start, ctx) => {
    if ((start.github === undefined) === (start.gitlab === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['github'],
        message: 'exactly one provider metadata member is required'
      })
    }
  })
export type HookStart = z.infer<typeof HookStart>

export const HookStartOk = z.object({ accepted: z.literal(true) })
export type HookStartOk = z.infer<typeof HookStartOk>

/** D→C action-time authorization for one formal GitHub review attempt. */
export const GithubReviewAuthorize = z.object({
  hookId: z.string().uuid(),
  deliveryKey: z.string().min(1),
  attemptId: z.string().uuid(),
  requestedEvent: HookReviewEvent,
  requestedVerdict: HookReviewVerdict,
  snapshot: HookConfigSnapshot
})
export type GithubReviewAuthorize = z.infer<typeof GithubReviewAuthorize>

/** Trusted target echoed with a broker-only purpose token. Secret: never log. */
export const GithubReviewAuthorized = z.object({
  attemptId: z.string().uuid(),
  token: z.string().min(1),
  ttlSec: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  repoId: HookBigIntString,
  repoFullName: z.string().min(1),
  pullNumber: z.number().int().positive(),
  expectedHeadSha: z.string().min(1),
  expectedBaseSha: z.string().min(1)
})
export type GithubReviewAuthorized = z.infer<typeof GithubReviewAuthorized>

/**
 * Immediate metadata-only convergence after the daemon's GitHub review POST.
 * Submitted metadata is also repeated on HookReport for lost-REP recovery.
 */
export const GithubReviewResultReport = z.object({
  hookId: z.string().uuid(),
  deliveryKey: z.string().min(1),
  attemptId: z.string().uuid(),
  snapshot: HookConfigSnapshot,
  result: HookReviewResult
})
export type GithubReviewResultReport = z.infer<typeof GithubReviewResultReport>

export const GithubReviewResultOk = z.object({ accepted: z.literal(true) })
export type GithubReviewResultOk = z.infer<typeof GithubReviewResultOk>
