import { z } from 'zod'
import { frameSchema } from '../envelope.js'
import { HOOK_KINDS } from '../code-host.js'
import { ErrorFrame } from './error.js'
import { BindMatch, IntegrationChannel } from './integration.js'
import { CronTarget } from './cron.js'
import { Platform } from './route.js'
import { CollabRoutesSnapshot } from './collab.js'
import { GithubHookMetadata, GitlabHookMetadata, HookBigIntString, OptionalHookConfigSnapshot } from './hook.js'
import { WebchatRemoteMcpEntitlement } from './remote-mcp.js'
import { buildEnvelopeRaw, decodeEnvelopeWith, type BuildOpts, type DecodeResultOf } from '../wire.js'

/**
 * relay↔CP control frames (`rc/*`) — shared-bot-relay.md §7.1 / §8.
 *
 * The relay dials OUT to the CP (`/api/v1/relays/ws`) and this wire carries
 * ONLY control signaling: registration, heartbeat, delegated credential
 * verification, and revocation. Message content NEVER crosses it — content
 * flows browser/platform → relay → daemon on the `rd/*` wire.
 *
 * This is a SEPARATE frame union from the daemon↔CP protocol (`frame.ts`) and
 * from the relay↔daemon wire (`relay-daemon.ts`): each socket decodes against
 * its own schema map, so a frame from the wrong family is `UNKNOWN_FRAME`.
 *
 * Milestone A carried the skeleton subset (register / heartbeat / verify /
 * daemon-revoke); milestone B-github adds the hook frames (`rc/hook-assign`,
 * `rc/hook-remove`, `rc/run-report` — webhook-triggers-and-github-events.md).
 * Shared-bot (`rc/bot-assign`…) frames land with milestone B-slack.
 */

/** Subprotocol negotiated on the relay↔CP socket. */
export const RELAY_CP_SUBPROTOCOL = 'agentconnect.rc.v1'

// ── auth (first frame; §8 dual-mode) ─────────────────────────────────────────

// R→C REQ → rc/auth/ok. `token` = deployment-shared secret (`RELAY_TOKEN`, or a
// JWT signed with it — the credential FORM is discriminated by the presence of
// dots, not here); `apikey` = a per-relay ApiKey (kind 'relay', org-less).
// The credential is secret material — NEVER log this frame.
export const RcAuth = z.object({
  method: z.enum(['token', 'apikey']),
  credential: z.string().min(1)
})
export type RcAuth = z.infer<typeof RcAuth>

// C→R REP (corr = rc/auth id). Rejection is a `error` REP + close, not a reply.
// `deploymentConfig` is the immutable startup snapshot for this relay process.
// It is carried on the already-authenticated control connection so the relay
// stays DB-less. A deployment change is deliberately restart-driven: callers
// consume only the first snapshot they receive in one process lifetime.
export const RcDeploymentConfig = z.object({
  revision: z.number().int().nonnegative(),
  githubWebhookSecret: z.string().min(1).optional()
})
export type RcDeploymentConfig = z.infer<typeof RcDeploymentConfig>

export const RcAuthOk = z.object({
  heartbeatSec: z.number().int(), // cadence the relay must emit rc/heartbeat at
  serverTime: z.string().datetime(),
  deploymentConfig: RcDeploymentConfig.optional()
})
export type RcAuthOk = z.infer<typeof RcAuthOk>

// ── registration ─────────────────────────────────────────────────────────────

// R→C REQ → rc/registered. Announces this relay instance and where daemons can
// dial it. Re-sent on every (re)connect; the CP upserts and re-issues the id.
// `daemonUrl` MUST route to THIS instance (per-pod DNS or a relay-id-sticky
// path) — a pool-level random LB breaks the no-cross-pod-forwarding topology
// (design §5). The pool-level public ingress is env-level PUBLIC_RELAY_URL and
// is never registered here.
export const RcRegister = z.object({
  name: z.string().min(1), // deployment-side identity (pod name etc.)
  daemonUrl: z.string().min(1), // per-instance-routable WSS origin daemons dial
  // Relay feature advertisement (e.g. webchat_session_continuation_v1). The
  // default keeps old relays register-compatible; absent ⇒ no features.
  features: z.array(z.string()).default([])
})
export type RcRegister = z.infer<typeof RcRegister>

// C→R REP (corr = rc/register id).
export const RcRegistered = z.object({
  relayId: z.string().uuid()
})
export type RcRegistered = z.infer<typeof RcRegistered>

// R→C EVT — liveness; drives `relay.lastSeenAt` and the failover sweeper.
export const RcHeartbeat = z.object({})
export type RcHeartbeat = z.infer<typeof RcHeartbeat>

// ── delegated verification (§9 / §10) ────────────────────────────────────────

// R→C REQ → rc/verify/ok. The relay holds no database, so it delegates credential
// checks to the CP: a daemon's API key on `rd/hello`, or a browser's CP-minted
// short-lived webchat token. The credential is secret material — NEVER log.
// `conversationBinding` is optional on the wire so a new CP can reject one old
// relay's webchat dial without closing the relay's shared control connection.
export const RcVerify = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daemon-key'),
    credential: z.string().min(1)
  }),
  // An in-cluster daemon's projected ServiceAccount token, reviewed against its cluster.
  z.object({
    kind: z.literal('daemon-token'),
    credential: z.string().min(1),
    // The daemonId claimed on `rd/hello`, forwarded unverified. CP binds a pool member token's
    // reviewed Pod UID to one member record and refuses any different claim.
    daemonId: z.string().uuid().optional()
  }),
  z.object({
    kind: z.literal('webchat-token'),
    credential: z.string().min(1),
    conversationBinding: z.literal('v1').optional()
  })
])
export type RcVerify = z.infer<typeof RcVerify>

// C→R REP (corr = rc/verify id). `ok:false` carries no detail beyond `reason`
// (no existence oracle). On success the identity fields depend on `kind`:
//  - daemon-key     → daemonId + orgId
//  - daemon-token   → daemonId + orgId (same shape; a different credential)
//  - webchat-token  → userId (+ display `user`) + agentId + daemonId + orgId +
//    conversationId, where daemonId is the agent's CURRENT placement and the
//    conversation id is the CP-authorized binding carried by the token.
// One conversation participant, as resolved at verification time. `daemonId` is
// the agent's CURRENT placement; absent when the agent is unplaced or its daemon
// is not READY (the relay then refuses turns targeting it with `no_agent`).
export const RcWebchatParticipant = z.object({
  agentId: z.string().uuid(),
  daemonId: z.string().uuid().optional(),
  primary: z.boolean().optional()
})
export type RcWebchatParticipant = z.infer<typeof RcWebchatParticipant>

export const RcVerifyResult = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  orgId: z.string().optional(),
  daemonId: z.string().uuid().optional(),
  userId: z.string().optional(),
  user: z.string().optional(), // display handle for the transcript author line
  agentId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  // The conversation's full roster (multi-agent webchat). Singular agentId/daemonId
  // above stay the PRIMARY's values for rolling compatibility; `participants`
  // always includes the primary. Absent ⇒ single-agent conversation on an older CP.
  participants: z.array(RcWebchatParticipant).max(16).optional(),
  // Session-targeted continuation (webchat-cross-integration-continuation.md):
  // the CP-selected target session, by its outward id (§1.1). The relay copies it verbatim onto
  // every rd/msg for this conversation; it never originates in the browser and
  // is deliberately the only cross-system coordinate on the wire — every local
  // coordinate comes from the daemon's own session row.
  targetSessionId: z.string().min(1).optional(),
  remoteMcp: WebchatRemoteMcpEntitlement.optional()
})
export type RcVerifyResult = z.infer<typeof RcVerifyResult>

// R→C REQ → rc/github-comment-authz/ok. The relay asks the CP (which owns the
// App installation) for a current repository-permission verdict instead of
// treating webhook `author_association` as authority. This frame is deliberately
// metadata-only: authored content must never cross the relay↔CP control plane.
export const RcGithubHookFence = z
  .object({
    hookId: z.string().uuid(),
    configRevision: HookBigIntString,
    dispatchRevision: HookBigIntString
  })
  .strict()
export type RcGithubHookFence = z.infer<typeof RcGithubHookFence>

export const RcGithubCommentAuthz = z
  .object({
    hookId: z.string().uuid(),
    installationId: z.string().regex(/^[1-9]\d*$/),
    repoId: z.string().regex(/^[1-9]\d*$/),
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    // Legacy field name: comment deliveries carry `comment.user.login`, not
    // the top-level webhook action sender. Maintainer controls carry the actor.
    senderLogin: z.string().min(1),
    // An unmentioned thread comment may continue automatically only when both
    // its commenter and the issue/PR author still have write authority. An
    // explicit maintainer summon omits this second actor.
    subjectAuthorLogin: z.string().min(1).optional(),
    // Fence authorization to the exact compiled rule that accepted the
    // delivery. A stale relay copy cannot authorize after retarget/reassign.
    configRevision: HookBigIntString,
    dispatchRevision: HookBigIntString,
    // Thread-actor authorization is repository-wide, but every matching sibling
    // must still be fenced against current CP state before one allow verdict
    // can authorize the complete fan-out.
    siblingFences: z.array(RcGithubHookFence).min(1).optional()
  })
  .strict()
export type RcGithubCommentAuthz = z.infer<typeof RcGithubCommentAuthz>

// C→R REP (corr = rc/github-comment-authz id). Do not disclose the user's
// effective permission or which validation failed; the relay needs one bit.
export const RcGithubCommentAuthzResult = z.object({ allowed: z.boolean() }).strict()
export type RcGithubCommentAuthzResult = z.infer<typeof RcGithubCommentAuthzResult>

/** Neutral alias: the fence shape was never GitHub-specific. */
export const RcHookFence = RcGithubHookFence
export type RcHookFence = RcGithubHookFence

// R→C REQ → rc/codehost-membership-authz/ok — the provider-neutral successor to
// rc/github-comment-authz for hosts whose actor identity is numeric
// (gitlab-com-integration.md §12.2, §17.2). Same discipline: metadata-only, the
// CP re-resolves live membership and never trusts webhook-carried relationship
// labels; authored content never crosses this wire. Deliberately NOT `.strict()`
// — the GitHub frame's strictness is exactly why it could not be extended in
// place. An older CP answers UNKNOWN_FRAME and the relay fails closed.
export const RcCodeHostMembershipAuthz = z.object({
  hookId: z.string().uuid(),
  provider: z.string().min(1), // 'gitlab' today; open string so a new host degrades per-value
  repoExternalId: z.string().regex(/^[1-9]\d*$/), // numeric project/repository id — the match key
  actorExternalId: z.string().regex(/^[1-9]\d*$/), // sender/actor numeric user id
  // Unmentioned thread continuation also requires the subject author's current
  // membership; an explicit maintainer summon omits this second actor.
  subjectAuthorExternalId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
  // Fence authorization to the exact compiled rule that accepted the delivery.
  configRevision: HookBigIntString,
  dispatchRevision: HookBigIntString,
  siblingFences: z.array(RcHookFence).min(1).optional()
})
export type RcCodeHostMembershipAuthz = z.infer<typeof RcCodeHostMembershipAuthz>

// C→R REP (corr = rc/codehost-membership-authz id). One bit, same as GitHub.
export const RcCodeHostMembershipAuthzResult = z.object({ allowed: z.boolean() })
export type RcCodeHostMembershipAuthzResult = z.infer<typeof RcCodeHostMembershipAuthzResult>

// R→C REQ — signature-verified Check identity, suite identity, or waiting external-PR workflow control.
const GithubNumericId = z.string().regex(/^[1-9]\d*$/)
export const RcGithubRerequest = z.union([
  z
    .object({
      checkRunId: GithubNumericId,
      repoId: GithubNumericId,
      headSha: z.string().min(1),
      deliveryKey: z.string().min(1).max(200),
      // Rolling opt-in: a new CP includes baseSha only when a new relay asks.
      // This keeps replies to older strict-schema relays byte-compatible.
      includeBaseSha: z.literal(true).optional()
    })
    .strict(),
  z
    .object({
      scope: z.literal('suite'),
      appId: GithubNumericId,
      installationId: GithubNumericId,
      repoId: GithubNumericId,
      headSha: z.string().min(1),
      deliveryKey: z.string().min(1).max(200)
    })
    .strict(),
  z
    .object({
      scope: z.literal('workflow'),
      installationId: GithubNumericId,
      repoId: GithubNumericId,
      headSha: z.string().min(1),
      pullNumber: z.number().int().positive().optional(),
      deliveryKey: z.string().min(1).max(200)
    })
    .strict()
])
export type RcGithubRerequest = z.infer<typeof RcGithubRerequest>

// C→R REP — a bare denial or durable run targets that relay re-fences against current compiled rules.
const RcGithubRerequestTarget = z
  .object({
    hookId: z.string().uuid(),
    pullNumber: z.number().int().positive(),
    baseSha: z.string().min(1),
    configRevision: HookBigIntString,
    dispatchRevision: HookBigIntString
  })
  .strict()
export const RcGithubRerequestResult = z.union([
  z.object({ allowed: z.literal(false) }).strict(),
  z
    .object({
      allowed: z.literal(true),
      hookId: z.string().uuid(),
      pullNumber: z.number().int().positive(),
      baseSha: z.string().min(1).optional(),
      configRevision: HookBigIntString,
      dispatchRevision: HookBigIntString
    })
    .strict(),
  z
    .object({
      allowed: z.literal(true),
      targets: z.array(RcGithubRerequestTarget).min(1)
    })
    .strict()
])
export type RcGithubRerequestResult = z.infer<typeof RcGithubRerequestResult>

// ── hooks (webhook-triggers-and-github-events.md; pool-wide broadcast) ──────

// C→R EVT — one enabled hook's compiled rule, broadcast to the WHOLE pool
// (webhook-type ingress is pool-served, shared-bot-relay.md §5). Upsert
// semantics: the CP re-sends the full frame on hook create/update/enable, on
// agent placement moves, and (github kind) when the org's installation set
// changes; disable/delete send `rc/hook-remove`. After a relay (re)registers
// the CP replays every enabled hook — the relay's table is a memory copy.
// `hmacSecret` is secret material — NEVER log this frame.
export const RcHookAssign = z
  .object({
    hookId: z.string().uuid(),
    kind: z.enum(HOOK_KINDS),
    agentId: z.string().uuid(),
    daemonId: z.string().uuid(), // the agent's CURRENT placement; re-sent on moves
    // R1/R2a rolling fields. Partial/absent remains decodable, but the relay
    // propagates an incomplete tuple with review/reporting forced off.
    ...OptionalHookConfigSnapshot.shape,
    // No prompt: the agent's description is its standing context; the delivery
    // payload carries the caller's message (design security boundary 1).
    sessionMode: z.enum(['perDelivery', 'perThread', 'shared']),
    target: CronTarget.optional(), // output anchoring; absent ⇒ headless
    // kind=webhook — required for that kind (enforced at the CP compile site)
    webhook: z
      .object({
        urlToken: z.string().min(1), // ingress routing key (capability URL)
        hmacSecret: z.string().optional() // optional X-AC-Signature key
      })
      .optional(),
    // kind=github (P2) — required for that kind
    github: z
      .object({
        repoId: z.string(), // GitHub numeric repo id (BigInt as string) — the match key
        repoFullName: z.string(), // display/logs only; never matched on
        // Immutable per-thread session namespace. Optional for rolling
        // compatibility with a CP that predates rename-stable affinity.
        sessionKeyPrefix: z.string().min(1).optional(),
        events: z.array(z.string()), // 'issues:opened' / 'pull_request:*' / …
        labelFilter: z.array(z.string()),
        // Optional disambiguator for GitHub's shared issue_comment event. Absent
        // or empty preserves the legacy/API repo-wide meaning; a new CP stamps
        // the console-selected thread families so the relay can isolate replies.
        commentFamilies: z.array(z.enum(['issues', 'pull_request'])).optional(),
        // P3 summon mode: every event's authored text must @-mention either
        // this agent or the App. Thread events always pass the live maintainer
        // gate in addition to this flag.
        mentionOnly: z.boolean(),
        // The App slug is the broadcast handle: `@<appSlug>` keeps every
        // matching rule in the repo fan-out. Compiled from the CP's
        // GITHUB_APP_SLUG (per-org Apps would move it per rule, open question 3).
        appSlug: z.string().optional(),
        // The immutable agent slug is the targeted handle: `@<agentName>` keeps
        // only this agent's matching rules. Optional for rolling compatibility
        // with a CP that predates targeted GitHub mentions.
        agentName: z.string().optional(),
        // The org's valid installation ids (BigInt as string) — the runtime
        // attribution gate: an event fires only if payload.installation.id ∈ set.
        installationIds: z.array(z.string())
      })
      .optional(),
    // kind=gitlab (gitlab-com-integration.md §11.3) — required for that kind.
    // The signing token rides inline exactly as the generic webhook's HMAC
    // secret does; the rule is NEVER logged.
    gitlab: z
      .object({
        projectId: z.string().regex(/^[1-9]\d*$/), // numeric project id — the match key
        projectPath: z.string().min(1), // display/logs only; never matched on
        sessionKeyPrefix: z.string().min(1), // rename-stable per-thread namespace: gitlab:<projectId>
        events: z.array(z.string()), // 'issues:*' / 'merge_request:*' / 'push:*' …
        // Removed feature, accepted and ignored for one release: a relay predating
        // this one still REQUIRES the member, so the CP keeps sending an empty array.
        labelFilter: z.array(z.string()).optional(),
        commentFamilies: z.array(z.enum(['issues', 'merge_request'])).optional(),
        mentionOnly: z.boolean(),
        agentName: z.string().optional(),
        // The binding's runtime identity: loop prevention (§12.1) and the
        // mention/reviewer targets.
        serviceAccountUserId: z.string().regex(/^[1-9]\d*$/),
        serviceAccountUsername: z.string().min(1),
        // §12.1 veto set: every managed account bound to the project, including the one above.
        // Additive optional (§17.3) — a rule without it vetoes only the account it names.
        boundServiceAccountUserIds: z.array(z.string().regex(/^[1-9]\d*$/)).optional(),
        // whsec_ Standard Webhooks signing key for §11.2 verification.
        signingToken: z.string().min(1),
        // The instance this rule addresses (§24.4). The relay treats it as opaque data and
        // copies it onto the trusted metadata it forwards, where it is the turn-time fence
        // against the session's spec-carried host. Absent means GitLab.com.
        host: z.string().optional()
      })
      .optional()
  })
  .superRefine((rule, ctx) => {
    if (rule.dispatchDaemonId !== undefined && rule.dispatchDaemonId !== rule.daemonId) {
      ctx.addIssue({
        code: 'custom',
        path: ['dispatchDaemonId'],
        message: 'dispatchDaemonId must equal daemonId on a compiled rule'
      })
    }
  })
export type RcHookAssign = z.infer<typeof RcHookAssign>

// C→R EVT — drop one rule (hook disabled / deleted / agent unplaced).
export const RcHookRemove = z.object({
  hookId: z.string().uuid()
})
export type RcHookRemove = z.infer<typeof RcHookRemove>

/**
 * C→R REQ → `rc/hook-rerun/ok` — re-dispatch ONE gitlab hook turn the Console
 * asked for (gitlab-com-integration.md §16.1 "Run again", §18.2). GitLab has no
 * native Check button, so the Control Plane is the entry point instead of a
 * signed provider callback; the frame carries only the fences and the freshly
 * read subject metadata, and the relay re-checks its own compiled rule before
 * reusing the ordinary hook dispatch path.
 *
 * Correlated, and NEVER retransmitted: a re-sent rerun is a second agent turn,
 * so an unanswered frame is ambiguous rather than retryable on the same relay.
 * Sent to ONE relay at a time (never broadcast) for the same reason; the CP
 * moves to another eligible relay only on a DEFINITIVE refusal below.
 * Gated on `gitlab-rerun-v1`, not `gitlab-com-v1`: the older bit predates this
 * frame and its holder cannot decode it.
 */
export const RcHookRerun = z.object({
  hookId: z.string().uuid(),
  agentId: z.string().uuid(),
  deliveryKey: z.string().min(1), // Control-Plane-minted; the HookRun/dedup identity
  configRevision: HookBigIntString,
  dispatchRevision: HookBigIntString,
  event: z.string().min(1), // normalized 'family:action', e.g. 'merge_request:rerun'
  gitlab: GitlabHookMetadata
})
export type RcHookRerun = z.infer<typeof RcHookRerun>

/**
 * Definitive relay-side non-admission reasons. Each means NO turn started and
 * NO HookRun row opened, so the Control Plane may try another eligible relay
 * and must never report the click as accepted.
 *
 *  - `replay_pending`    — this relay holds no rule for the hook yet (its table
 *    is a memory copy filled by the register replay);
 *  - `rule_mismatch`     — it holds one, but the kind/agent/project/revision
 *    fence differs from the frame;
 *  - `limiter_exhausted` — the hook's shared per-hook run budget is spent.
 */
export const RcHookRerunRefusal = z.enum(['replay_pending', 'rule_mismatch', 'limiter_exhausted'])
export type RcHookRerunRefusal = z.infer<typeof RcHookRerunRefusal>

/** R→C REP (corr = the `rc/hook-rerun` id). `admitted` is the ONLY proof a turn
 *  was queued: reaching a socket is not acceptance. */
export const RcHookRerunResult = z.union([
  z.object({ admitted: z.literal(true), deliveryKey: z.string().min(1) }),
  z.object({ admitted: z.literal(false), code: RcHookRerunRefusal })
])
export type RcHookRerunResult = z.infer<typeof RcHookRerunResult>

/** Definite pre-dispatch unavailability: the relay found no live connection for
 * the assigned daemon, so no agent turn or external review effect could start. */
export const HOOK_DELIVERY_REASON_DAEMON_OFFLINE = 'daemon_offline' as const
/** Ambiguous delivery: the daemon may have admitted the message before the ACK
 * was lost. Record it consistently, but do not automatically redeliver it
 * without cross-daemon idempotency or an end-to-end admission fence. */
export const HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT = 'dispatch_timeout' as const
/** A PR authored outside the repository's write boundary is intentionally not
 * dispatched until a maintainer explicitly requests review. The failed
 * delivery-stage row is a metadata-only durable anchor for the actionable
 * informational Check; it does not represent an attempted agent turn. */
export const HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED = 'review_request_required' as const

/** Identifier returned by GitHub when a maintainer clicks the Check action that
 * opens the first review generation for an external PR. */
export const GITHUB_REQUEST_REVIEW_ACTION = 'request_review' as const

/** Delivery-stage failures that are safe to redeliver automatically. Keep this
 * list closed: unknown failures and agent/business rejections require an
 * explicit decision before they can cause another turn or external effect. */
export const RETRYABLE_HOOK_DELIVERY_REASONS = [HOOK_DELIVERY_REASON_DAEMON_OFFLINE] as const
export type RetryableHookDeliveryReason = (typeof RETRYABLE_HOOK_DELIVERY_REASONS)[number]

const retryableHookDeliveryReasons = new Set<string>(RETRYABLE_HOOK_DELIVERY_REASONS)

export function isRetryableHookDeliveryReason(reason: unknown): reason is RetryableHookDeliveryReason {
  return typeof reason === 'string' && retryableHookDeliveryReasons.has(reason)
}

// R→C EVT (fire-and-forget) — delivery-stage bookkeeping, pure metadata (no
// payload ever). `accepted` opens the HookRun row (running); `failed` records a
// failed row outright. The daemon's `hook/report` completion EVT (frames/hook.ts,
// the control WS) later closes accepted rows; the HookRunReaper harvests the
// rest. Duplicate reports collapse on the CP's (hookId, deliveryKey) unique key.
export const RcRunReport = z
  .object({
    hookId: z.string().uuid(),
    deliveryKey: z.string().min(1),
    firedAt: z.string().datetime(), // relay ingest time == HookRun.startedAt
    agentId: z.string().uuid(),
    daemonId: z.string().uuid().optional(),
    ...OptionalHookConfigSnapshot.shape,
    event: z.string().min(1).optional(), // 'issues:opened' etc (github); absent for webhook kind
    github: GithubHookMetadata.optional(),
    gitlab: GitlabHookMetadata.optional(),
    status: z.enum(['accepted', 'failed']),
    reason: z.string().optional() // delivery-stage reason; use isRetryableHookDeliveryReason before redelivery
  })
  .superRefine((report, ctx) => {
    if (
      report.daemonId !== undefined &&
      report.dispatchDaemonId !== undefined &&
      report.daemonId !== report.dispatchDaemonId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['dispatchDaemonId'],
        message: 'dispatchDaemonId must equal daemonId on a delivery report'
      })
    }
  })
export type RcRunReport = z.infer<typeof RcRunReport>

// R→C EVT (fire-and-forget) — installation doorbell (webhook-triggers decision 11):
// the relay forwards a verified `installation`/`installation_repositories`
// event as a minimal poke; the CP re-pulls `GET /app/installations/{id}` as the
// source of truth (`action` is observational — the CP never writes from it).
// Emitted ONLY after X-Hub-Signature-256 verification. A dropped doorbell is
// safe for a durable claim: the setup callback / scoped manual Sync /
// mint-failure refresh paths converge eventually.
export const RcGithubInstallation = z.object({
  installationId: z.string().min(1), // GitHub numeric id (BigInt as string)
  action: z.string().min(1) // created|deleted|suspend|…|added|removed
})
export type RcGithubInstallation = z.infer<typeof RcGithubInstallation>

// ── revocation (§9 revocation loop) ─────────────────────────────────────────

// C→R EVT — the daemon's credential was revoked / membership removed: the relay
// must immediately drop that daemon's connection and stop routing to it.
export const RcDaemonRevoke = z.object({
  daemonId: z.string().uuid()
})
export type RcDaemonRevoke = z.infer<typeof RcDaemonRevoke>

// The Block Kit `action_id` on a shared bot's 👤 switch-agent button (§10.1; older
// posted messages may still carry the same action on their footer). The DAEMON renders
// the button (send-only) and the RELAY receives the click over HTTP interactivity — they're
// different processes, so the id is pinned here as the single source. The `callback_id`
// on the relay-owned default-agent modal shares the same string. Session configuration
// uses `SLACK_STATUS_ACTION.manage` (⚙️) instead.
export const SHARED_CONFIG_ACTION_ID = 'ac_shared_channel_config'

/** The Block Kit `action_id` on a shared status bar's inline agent selector.
 *  The relay owns the shared app's HTTP interaction edge and answers both the
 *  external-select suggestions and the resulting channel-default selection. Keep
 *  this separate from {@link SHARED_CONFIG_ACTION_ID}: older posted messages still
 *  use that id for the legacy 👤 button + modal flow. */
export const SHARED_AGENT_SELECT_ACTION_ID = 'ac_shared_agent_select'

// `SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID` is declared in the app manifest, so
// it lives in `../slack-app-manifest.ts` and is re-exported from the package root
// alongside the ids below. See that file for why it cannot import back into here.

/** Slack action ids shared by the daemon-owned status modal and the relay-owned
 *  HTTP interaction edge. Dedicated bots handle them in the daemon directly; shared bots
 *  forward them from the relay to the target daemon. */
export const SLACK_STATUS_ACTION = {
  more: 'ac_more',
  manage: 'ac_manage',
  setModel: 'ac_set_model',
  setEffort: 'ac_set_effort',
  setPermissionMode: 'ac_set_permission_mode',
  setFast: 'ac_set_fast',
  setOutput: 'ac_set_output',
  cancel: 'ac_cancel',
  view: 'ac_view'
} as const

/** Slack action ids/codecs shared by the daemon-rendered human-input cards and
 * the relay-owned HTTP interaction edge. Keeping them on the wire package prevents
 * direct Socket Mode and HTTP relay mode from interpreting the same card differently. */
export const PERMISSION_ACTION_PREFIX = 'ac_perm'
export const ELICIT_ACTION_PREFIX = 'ac_elicit'
export const ELICIT_DISMISS_ACTION = 'ac_elicit_dismiss'

/** Encode/decode the choice carried by permission and elicitation buttons. The
 * daemon-generated request id is `|`-free; runtime-owned option values may contain it. */
export function encodePermValue(requestId: string, optionId: string): string {
  return `${requestId}|${optionId}`
}

export function decodePermValue(value: string): { requestId: string; optionId: string } | null {
  const i = value.indexOf('|')
  return i < 0 ? null : { requestId: value.slice(0, i), optionId: value.slice(i + 1) }
}

/** One short choice from the compact Slack status overflow. Slack caps option
 *  values at 150 characters; the longer session target rides in `block_id`. */
export const SlackStatusOverflowAction = z.enum(['switch-agent', 'manage', 'cancel'])
export type SlackStatusOverflowAction = z.infer<typeof SlackStatusOverflowAction>

const LegacySlackStatusOverflowValue = z
  .object({
    v: z.literal(1),
    action: SlackStatusOverflowAction,
    target: z.string().min(1)
  })
  .strict()

export type SlackStatusOverflowValue = {
  action: SlackStatusOverflowAction
  target?: string
}

export function encodeSlackStatusOverflowValue(action: SlackStatusOverflowAction): string {
  return action
}

export function decodeSlackStatusOverflowValue(value: string): SlackStatusOverflowValue | null {
  const compact = SlackStatusOverflowAction.safeParse(value)
  if (compact.success) return { action: compact.data }
  try {
    const legacy = LegacySlackStatusOverflowValue.safeParse(JSON.parse(value))
    return legacy.success ? { action: legacy.data.action, target: legacy.data.target } : null
  } catch {
    return null
  }
}

/** Opaque routing target carried by a shared bot's session-config button and modal.
 *  Slack returns it unchanged in `action.value` / `view.private_metadata`; the relay
 *  validates the agent against its current bot assignment before forwarding. */
export const SharedSlackStatusTarget = z
  .object({
    v: z.literal(1),
    agentId: z.string().min(1),
    integrationId: z.string().min(1),
    sessionKey: z.string().min(1)
  })
  .strict()
export type SharedSlackStatusTarget = z.infer<typeof SharedSlackStatusTarget>

export function encodeSharedSlackStatusTarget(target: Omit<SharedSlackStatusTarget, 'v'>): string {
  return JSON.stringify({ v: 1, ...target })
}

export function decodeSharedSlackStatusTarget(value: string): SharedSlackStatusTarget | null {
  try {
    const parsed = SharedSlackStatusTarget.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// ── shared-bot assignment + routing (§7.1 / §10) ─────────────────────────────

// One attributed routing rule the relay arbitrates inbound against. Unlike the
// daemon's local BindRule this ALREADY carries its target (agentId + the daemon
// to forward to + the integration id to send the reply back through) — the
// CP→relay protocol is new, so the v1 "owner side can't express attribution"
// blocker is fixed by attaching attribution here (§3). `scope` narrows the rule
// to a channel/thread (channel ownership → per-channel default agent, §10).
export const AttributedRoute = z.object({
  agentId: z.string().uuid(),
  daemonId: z.string().uuid(),
  integrationId: z.string().uuid(),
  scope: z.object({ channel: z.string().optional(), thread: z.string().optional() }).optional(),
  match: BindMatch
})
export type AttributedRoute = z.infer<typeof AttributedRoute>

// Ingress-only credentials handed to the relay. Slack currently keeps its bot
// token here for the existing HTTP interaction/channel APIs. Feishu deliberately
// sends only callback verification material: its app secret and all provider API
// egress stay on the daemon. Secret — NEVER log this frame.
export const RcBotSecrets = z.union([
  // The typed variants keep full validation for today's platforms AND pass unknown
  // keys through (`catchall`): a bag that satisfies a typed prefix may still carry
  // additional credential fields a newer platform module needs — stripping them
  // here would hand the §6.7 platform-module boundary less than what was on the
  // wire. Ordered first so validation still applies during the window.
  z
    .object({
      botToken: z.string(),
      signingSecret: z.string()
    })
    .catchall(z.unknown()),
  z
    .object({
      verificationToken: z.string(),
      encryptKey: z.string().optional()
    })
    .catchall(z.unknown()),
  // §6.7 open reader: a platform this build predates ships an opaque secret bag;
  // the relay's platform module (S3) validates its shape.
  z.record(z.string(), z.unknown())
])
export type RcBotSecrets = z.infer<typeof RcBotSecrets>

// One member agent's display info — the relay holds no DB, so it can't resolve a
// name from an id. Carried so the relay can label the per-channel "default agent"
// picker modal (§10.1 config button). Ids alone aren't enough for a human list.
export const RcAgentDirEntry = z.object({
  agentId: z.string().uuid(),
  name: z.string(), // the slug; the modal shows it (displayName folded in by the CP if set)
  daemonId: z.string().uuid(),
  // Rolling optional: new CPs include the install id so a receive-only relay can
  // hand an unroutable gated callback to the daemon that owns provider egress.
  integrationId: z.string().uuid().optional()
})
export type RcAgentDirEntry = z.infer<typeof RcAgentDirEntry>

// C→R EVT — load a shared bot's INBOUND routing + credentials onto this relay:
// inbound arrives over the shared HTTP Events API endpoints (`/slack/events`,
// `/slack/interactions`) and is arbitrated against `routes`. Whole-pool: the CP
// BROADCASTS this to EVERY connected relay (any pod may receive an event via the
// stable `PUBLIC_RELAY_URL` LB); there is no per-bot relay placement. `members`
// lists which daemons/agents this bot serves (drives which daemon connections the
// relay expects). NEVER log.
export const RcBotAssign = z.object({
  botId: z.string().uuid(),
  // S1a open reader (route.ts Platform policy). The CP only emits ids the
  // relay build supports; the relay's assign handler already refuses an
  // unsupported platform gracefully ("not yet supported"), never the socket.
  platform: Platform,
  // §6.1: the platform's origin kind, so an older relay can classify an id a
  // newer CP introduces (always 'chat' for a bot assignment today). Overlaid on
  // the relay's built-in seed; absent (older CP) ⇒ the seed answers, and an id
  // neither classifies defaults to 'chat' (fail-closed in coordsDecision).
  originKind: z.string().min(1).optional(),
  // Install GENERATION of the credentials below — advanced by the CP every time a
  // fresh credential lands on this bot. The relay echoes it back in
  // `rc/bot-revoked` so the CP can refuse a revocation observed under a credential
  // that has since been replaced (Slack does not order lifecycle events). Absent
  // ⇒ the CP applies revocations without the revision arm of the fence.
  credentialRevision: z.number().int().nonnegative().optional(),
  secrets: RcBotSecrets,
  // §6.7 opaque INGRESS bag — the ONE carrier of the per-platform demux identity
  // (Slack: apiAppId "A…" + the distributed-install teamId "T…" + botUserId;
  // Feishu: appId "cli_…"). Shape validation belongs to the platform module on
  // both ends (S3): the CP provider's `projectBotAssign` produces it, the
  // relay's `toBotAssignment` / platform ingress plugin consume it. The legacy
  // named top-level twins (`apiAppId`/`teamId`/`botUserId`) left the schema with
  // the S3 protocol cleanup — emission stopped when the bag landed (#556) and
  // the bag-preferring reader shipped before that (#545), so nothing deployed
  // reads or writes them.
  ingress: z.unknown().optional(),
  members: z.array(z.object({ daemonId: z.string().uuid(), agentIds: z.array(z.string().uuid()) })),
  agents: z.array(RcAgentDirEntry).default([]), // member directory (id→name) for the config modal
  routes: z.array(AttributedRoute),
  defaultAgentId: z.string().uuid().optional(), // bare @bot / DM fallback within the group (§10.3)
  defaultDaemonId: z.string().uuid().optional(),
  // Conversation gating (resource-visibility.md §14): member agents whose ingress is
  // fail-closed. The relay's thread-affinity rung honours a binding to a gated agent
  // only while that agent still has a channel-scoped route in the conversation —
  // otherwise a thread bound before the gate was applied would keep routing forever.
  gatedAgentIds: z.array(z.string().uuid()).default([]),
  // Channels switched OFF for this bot. The relay's ladder has rungs no
  // channel-scoped route can suppress — unscoped keyword, the group's
  // `defaultAgentId`, thread continuity — so an Off channel needs a subtractive
  // fence rather than the mere absence of a route. A muted channel resolves to no
  // target at all. Bot-scoped, matching how an HTTP bot's channels converge on one
  // owner, and how the trigger is replicated across its membership rows. Defaults empty.
  mutedChannels: z.array(z.string()).default([]),
  // The muted channels whose owner is a GATED agent. Their Off is §14's fail-closed
  // default for a conversation nobody has enabled yet, so they keep the one-time
  // notice; a channel an OPERATOR switched off is silent instead. The two share a
  // trigger value and are indistinguishable at the relay without this — hence a
  // second list rather than a flag the relay could derive. Subset of
  // `mutedChannels`. Defaults empty.
  gatedOffChannels: z.array(z.string()).default([]),
  // §14.3 one-time gating notice, CHANNEL conversations: the relayId
  // DETERMINISTICALLY responsible for posting it for this bot. A channel mention
  // arrives as two event copies that may land on different pods — only the
  // authority posts (local per-conversation latch). Stamped from the connected
  // roster at (re)assign/replay time and re-converged on relay join/leave/sweep.
  // Absent ⇒ no relay posts.
  noticeAuthority: z.string().uuid().optional(),
  // §14.3 one-time gating notice, DM conversations: the ids whose notice was
  // ACTUALLY DELIVERED (reported via `rc/notice-posted`, pool-converged by the
  // CP re-stamp). A DM has a SINGLE event copy, so the RECEIVING pod posts —
  // but only for a conversation not in this set. Deliberately NOT derived from
  // conversation rows: a row can exist from mere discovery (a mixed bot's DM
  // routed to its public default) with no notice ever posted, and the
  // conversation must still get one if it later becomes unroutable.
  noticedDmConversations: z.array(z.string()).default([])
})
export type RcBotAssign = z.infer<typeof RcBotAssign>

// C→R EVT — release a shared bot from this relay (bot un-shared, uninstalled, or
// re-placed onto another relay): close the ingest, drop the routing table.
export const RcBotUnassign = z.object({
  botId: z.string().uuid(),
  // The install GENERATION this release describes. A revocation decides and
  // commits, then broadcasts — and a re-install can land in that gap, commit
  // N+1, and broadcast its own assign FIRST. An unfenced unassign arriving after
  // it would tear down the live ingest of a credential it never described. The
  // relay therefore ignores an unassign whose revision is older than the
  // assignment it currently holds. Absent ⇒ unconditional release (a transport
  // flip, an un-share, the last install removed — none of which race a
  // credential).
  credentialRevision: z.number().int().nonnegative().optional()
})
export type RcBotUnassign = z.infer<typeof RcBotUnassign>

// C→R EVT — hot-update the routing table for an already-assigned bot (channel
// ownership / membership / default-agent change) WITHOUT re-opening the ingest.
export const RcRoutes = z.object({
  botId: z.string().uuid(),
  members: z.array(z.object({ daemonId: z.string().uuid(), agentIds: z.array(z.string().uuid()) })),
  agents: z.array(RcAgentDirEntry).default([]),
  routes: z.array(AttributedRoute),
  defaultAgentId: z.string().uuid().optional(),
  defaultDaemonId: z.string().uuid().optional(),
  gatedAgentIds: z.array(z.string().uuid()).default([]), // §14 — see RcBotAssign.gatedAgentIds
  mutedChannels: z.array(z.string()).default([]), // Off channels — see RcBotAssign.mutedChannels
  gatedOffChannels: z.array(z.string()).default([]), // notice-keeping subset — see RcBotAssign.gatedOffChannels
  noticeAuthority: z.string().uuid().optional(), // §14.3 — see RcBotAssign.noticeAuthority
  noticedDmConversations: z.array(z.string()).default([]) // §14.3 — see RcBotAssign.noticedDmConversations
})
export type RcRoutes = z.infer<typeof RcRoutes>

// C→R EVT — durable per-sessionKey thread affinity BROADCAST leg (§10 step 3): the
// CP persists a (botId, sessionKey)→{agentId, daemonId} binding reported by a relay
// via `rc/thread-assign` and broadcasts it to EVERY connected relay, so any pool pod
// that later receives an un-mentioned follow-up routes it to the same agent. A relay
// also learns affinity live from its own routing; this is the authoritative sync +
// the answer to a `rc/thread-lookup` miss.
export const RcAssign = z.object({
  botId: z.string().uuid(),
  sessionKey: z.string().min(1),
  agentId: z.string().uuid(),
  daemonId: z.string().uuid()
})
export type RcAssign = z.infer<typeof RcAssign>

// C→R EVT — one durable conversation member. Kept as a distinct frame from
// `rc/assign` so an older relay can never strip a discriminator and accidentally
// replace legacy single-owner affinity with an arbitrary participant.
export const RcParticipantAssign = z.object({
  botId: z.string().uuid(),
  sessionKey: z.string().min(1),
  agentId: z.string().uuid(),
  daemonId: z.string().uuid()
})
export type RcParticipantAssign = z.infer<typeof RcParticipantAssign>

// R→C EVT (fire-and-forget) — the operator picked a channel's default agent in the
// in-Slack config modal (§10.1). The CP persists it as the channel's owner
// (IntegrationChannel.agentId on the chosen agent's install for this bot, clearing
// any other install's row for the same channel) and re-compiles the bot's routes
// (rc/routes). A shared channel always has one owner. The relay acks the modal
// immediately; this rides best-effort like other rc EVTs.
export const RcSetChannelAgent = z.object({
  botId: z.string().uuid(),
  channelId: z.string().min(1),
  agentId: z.string().uuid()
})
export type RcSetChannelAgent = z.infer<typeof RcSetChannelAgent>

// R→C EVT (fire-and-forget) — the relay received an HTTP-mode Slack membership
// event for the bot itself, re-listed the bot's complete channel membership via
// users.conversations, and reports that authoritative snapshot to the CP. The CP
// fans it across every active integration of this bot and recompiles channel routes.
// Channel names are control metadata; no message content crosses this wire.
export const RcBotChannels = z.object({
  botId: z.string().uuid(),
  channels: z.array(IntegrationChannel)
})
export type RcBotChannels = z.infer<typeof RcBotChannels>

// R→C EVT (fire-and-forget) — a relay POSTED the one-time §14.3 gating notice in
// a DM conversation. The CP records delivery and re-stamps the pool's
// `noticedDmConversations` so every pod latches. Loss (link down) costs at most
// one duplicate notice later — never a lost enablement path.
export const RcNoticePosted = z.object({
  botId: z.string().uuid(),
  channel: z.string().min(1)
})
export type RcNoticePosted = z.infer<typeof RcNoticePosted>

// R→C REQ → rc/bot-revoked/ok — the workspace uninstalled the Slack app
// (`app_uninstalled`) or revoked its tokens (`tokens_revoked`). The relay cannot serve the bot any longer (its
// token is dead); the CP marks the Bot revoked, flips its integrations to
// `revoked`, and unassigns the bot from the pool.
//
// NOT droppable, and the ONLY rc/* report that is acknowledged: Slack acks the
// HTTP event before the relay's async handler runs, so it is never redelivered,
// and a dead token gives the CP nothing to observe — assignment reconciliation
// would just republish the stale active state forever. A send that the socket
// accepted is not evidence the CP COMMITTED (its handler can fail on the DB), so
// the relay keeps the report queued until `rc/bot-revoked/ok` comes back, and
// replays it across reconnects. Applying the same report twice is a no-op.
//
// The two fence fields answer Slack's unordered lifecycle delivery: a delayed
// event from a PRIOR install must not revoke the credential that replaced it.
// The CP applies the revocation only if BOTH still hold (each arm is skipped when
// its field is absent — fail-open, an uninstall must eventually take effect).
export const RcBotRevoked = z.object({
  botId: z.string().uuid(),
  reason: z.enum(['app_uninstalled', 'tokens_revoked']),
  // The `credentialRevision` this relay held for the bot when it observed the
  // event (from `rc/bot-assign`). Catches a relay that had not yet received the
  // re-install's assignment.
  credentialRevision: z.number().int().nonnegative().optional(),
  // Slack's envelope `event_time` in MILLISECONDS — when the uninstall actually
  // HAPPENED. The load-bearing arm: a relay that already applied the newer
  // assignment would echo the NEW revision, so only the event's own timestamp can
  // reveal that it predates the current credential.
  eventAtMs: z.number().int().nonnegative().optional()
})
export type RcBotRevoked = z.infer<typeof RcBotRevoked>

// C→R REP (corr = rc/bot-revoked id) — the CP COMMITTED its decision for this
// report: `applied: true` ⇒ the bot + its installs are now revoked; `false` ⇒ the
// generation fence refused it (a re-install replaced that credential). Both are
// terminal — the relay stops retrying either way. A missing reply means the CP
// never committed, so the relay retries.
export const RcBotRevokedOk = z.object({
  botId: z.string().uuid(),
  applied: z.boolean()
})
export type RcBotRevokedOk = z.infer<typeof RcBotRevokedOk>

// R→C EVT (fire-and-forget) — INCREMENTAL conversation report (resource-visibility
// §14.3): the relay saw an inbound direct conversation to a shared bot. The CP fans
// a per-install row across every member, using each agent's visibility-appropriate
// default. Incremental on purpose — unlike `rc/bot-channels` this must never
// carry full-set semantics (DM rows are never dropped by snapshots). Conversation
// id/name are control metadata; no message content crosses this wire. Loss is
// self-healing: the counterpart's next DM re-reports.
export const RcBotConversation = z.object({
  botId: z.string().uuid(),
  conversation: IntegrationChannel
})
export type RcBotConversation = z.infer<typeof RcBotConversation>

// R→C EVT (fire-and-forget) — durable thread-affinity REPORT leg (§10 step 3, the
// 3-leg affinity dance). The relay tells the CP which agent now owns a (channel,
// thread) `sessionKey` the first time it routes that thread, and again on a
// Switch-agent. The CP is the single writer: it persists the (botId, sessionKey)→
// {agentId, daemonId} binding and BROADCASTS it back to every relay via `rc/assign`.
// Sibling of `rc/set-channel-agent`; rides best-effort like other rc EVTs.
export const RcThreadAssign = z.object({
  botId: z.string().uuid(),
  sessionKey: z.string().min(1),
  agentId: z.string().uuid(),
  daemonId: z.string().uuid()
})
export type RcThreadAssign = z.infer<typeof RcThreadAssign>

// R→C EVT — add one durable participant without changing affinity. A distinct
// frame fails closed against an older CP instead of being decoded as owner assignment.
export const RcThreadParticipant = z.object({
  botId: z.string().uuid(),
  sessionKey: z.string().min(1),
  agentId: z.string().uuid(),
  daemonId: z.string().uuid()
})
export type RcThreadParticipant = z.infer<typeof RcThreadParticipant>

// R→C REQ → rc/thread-lookup/ok — pull-on-miss BACKSTOP leg. When an un-mentioned
// follow-up arrives for a (channel, thread) the relay has no cached affinity for
// (missed the broadcast, or (re)started before it), the relay asks the CP for the
// persisted owner rather than dropping the message. The relay caches the result.
export const RcThreadLookup = z.object({
  botId: z.string().uuid(),
  sessionKey: z.string().min(1)
})
export type RcThreadLookup = z.infer<typeof RcThreadLookup>

// C→R REP (corr = rc/thread-lookup id). `target: null` ⇒ the CP holds no binding
// for this (botId, sessionKey) — the relay falls back to normal arbitration.
export const RcThreadLookupOk = z.object({
  botId: z.string().uuid(),
  sessionKey: z.string().min(1),
  target: z.object({ agentId: z.string().uuid(), daemonId: z.string().uuid() }).nullable(),
  // Durable room membership is independent of the compatibility owner. Default
  // keeps new relays able to read replies from an older CP during rollout.
  participants: z.array(z.object({ agentId: z.string().uuid(), daemonId: z.string().uuid() })).default([])
})
export type RcThreadLookupOk = z.infer<typeof RcThreadLookupOk>

// C→R EVT — the bot-AGNOSTIC agent-collaboration routing snapshot (agent-collaboration
// §2.3 / §6.2 / §6.5). FULL-REPLACE: the relay swaps its whole `(orgId,platform,channel)
// → agents` table. Unlike `rc/bot-assign` (keyed by botId, can't address cross-bot), this
// lets the relay resolve a cross-daemon `rd/agentmsg` `toAgentId` → owning daemonId and
// authorize caller/target call policy. Bodiless routing/policy metadata only.
export const RcCollabRoutes = CollabRoutesSnapshot
export type RcCollabRoutes = z.infer<typeof RcCollabRoutes>

// C→R EVT — load an MCP provider's proxy binding onto this relay (centralized-tool-management.md
// §5.2). The relay reverse-proxies `/mcp/:providerId`, authenticates the agent-side bearer
// against `grantKeyHashes`, and injects the real upstream `headers` on forward. Whole-pool
// BROADCAST like rc/bot-assign (any relay may receive the agent's HTTPS request). `headers`
// carry the UPSTREAM credential — NEVER log this frame. Mirrors rc/bot-assign + RcBotSecrets.
export const RcMcpAssign = z.object({
  providerId: z.string().uuid(),
  upstreamUrl: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  // sha256 of the active grant keys; REQUIRED, ≥1 non-empty — a binding is the proxy's bearer-key
  // allowlist, so an empty set is rejected (never "unrestricted"). Retire a single key via rc/mcp-unassign.
  grantKeyHashes: z.array(z.string().min(1)).min(1)
})
export type RcMcpAssign = z.infer<typeof RcMcpAssign>

// C→R EVT — drop an MCP proxy binding: whole provider (`{providerId}`, deleted/revoked)
// or a single grant hash (`{providerId, grantKeyHash}`, rotation — old key retired).
export const RcMcpUnassign = z.object({
  providerId: z.string().uuid(),
  grantKeyHash: z.string().optional()
})
export type RcMcpUnassign = z.infer<typeof RcMcpUnassign>

// C→R EVT — purpose-separated external-memory proxy binding. It deliberately
// does not reuse rc/mcp-assign: memory plugin traffic is daemon-private and must
// never enter an agent/model MCP enable-list. Secret header values are relay-only.
export const RcMemoryConnectionAssign = z.object({
  orgId: z.string().min(1).max(64).optional(),
  connectionId: z.string().uuid(),
  // Monotonic durable connection revision. Relays ignore stale assignments so
  // concurrent HTTP mutations cannot roll credentials/config back out of order.
  revision: z.number().int().positive(),
  upstreamUrl: z.string().url().max(2_048),
  headers: z
    .array(z.object({ name: z.string().min(1).max(128), value: z.string().max(16 * 1024) }))
    .max(64)
    .default([]),
  grantKeyHashes: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(64)
})
export type RcMemoryConnectionAssign = z.infer<typeof RcMemoryConnectionAssign>

export const RcMemoryConnectionUnassign = z.object({
  connectionId: z.string().uuid(),
  // Whole-connection delete uses the next revision as a tombstone; a
  // grant-specific retirement uses the revision of the preceding assign.
  revision: z.number().int().positive(),
  grantKeyHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
})
export type RcMemoryConnectionUnassign = z.infer<typeof RcMemoryConnectionUnassign>

// ── the wire union ───────────────────────────────────────────────────────────

/** `type` string → payload schema for the relay↔CP wire. */
export const RELAY_CP_SCHEMAS = {
  'rc/auth': RcAuth,
  'rc/auth/ok': RcAuthOk,
  'rc/register': RcRegister,
  'rc/registered': RcRegistered,
  'rc/heartbeat': RcHeartbeat,
  'rc/verify': RcVerify,
  'rc/verify/ok': RcVerifyResult,
  'rc/github-comment-authz': RcGithubCommentAuthz,
  'rc/github-comment-authz/ok': RcGithubCommentAuthzResult,
  'rc/codehost-membership-authz': RcCodeHostMembershipAuthz,
  'rc/codehost-membership-authz/ok': RcCodeHostMembershipAuthzResult,
  'rc/github-rerequest': RcGithubRerequest,
  'rc/github-rerequest/ok': RcGithubRerequestResult,
  'rc/hook-assign': RcHookAssign,
  'rc/hook-remove': RcHookRemove,
  'rc/hook-rerun': RcHookRerun,
  'rc/hook-rerun/ok': RcHookRerunResult,
  'rc/run-report': RcRunReport,
  'rc/github-installation': RcGithubInstallation,
  'rc/daemon-revoke': RcDaemonRevoke,
  'rc/bot-assign': RcBotAssign,
  'rc/bot-unassign': RcBotUnassign,
  'rc/routes': RcRoutes,
  'rc/assign': RcAssign,
  'rc/participant-assign': RcParticipantAssign,
  'rc/set-channel-agent': RcSetChannelAgent,
  'rc/bot-channels': RcBotChannels,
  'rc/bot-conversation': RcBotConversation,
  'rc/bot-revoked': RcBotRevoked,
  'rc/bot-revoked/ok': RcBotRevokedOk,
  'rc/notice-posted': RcNoticePosted,
  'rc/thread-assign': RcThreadAssign,
  'rc/thread-participant': RcThreadParticipant,
  'rc/thread-lookup': RcThreadLookup,
  'rc/thread-lookup/ok': RcThreadLookupOk,
  'rc/collab-routes': RcCollabRoutes,
  'rc/mcp-assign': RcMcpAssign,
  'rc/mcp-unassign': RcMcpUnassign,
  'rc/memoryconnection-assign': RcMemoryConnectionAssign,
  'rc/memoryconnection-unassign': RcMemoryConnectionUnassign,
  error: ErrorFrame
} as const

/** Union of every legal `type` discriminator on the relay↔CP wire. */
export type RelayCpFrameType = keyof typeof RELAY_CP_SCHEMAS

/** All relay↔CP frame `type` strings, as a runtime array (guards / tests). */
export const RELAY_CP_FRAME_TYPES = Object.keys(RELAY_CP_SCHEMAS) as RelayCpFrameType[]

/** The discriminated union of every fully-validated relay↔CP frame. */
export const RelayCpFrame = z.discriminatedUnion('type', [
  frameSchema('rc/auth', RELAY_CP_SCHEMAS['rc/auth']),
  frameSchema('rc/auth/ok', RELAY_CP_SCHEMAS['rc/auth/ok']),
  frameSchema('rc/register', RELAY_CP_SCHEMAS['rc/register']),
  frameSchema('rc/registered', RELAY_CP_SCHEMAS['rc/registered']),
  frameSchema('rc/heartbeat', RELAY_CP_SCHEMAS['rc/heartbeat']),
  frameSchema('rc/verify', RELAY_CP_SCHEMAS['rc/verify']),
  frameSchema('rc/verify/ok', RELAY_CP_SCHEMAS['rc/verify/ok']),
  frameSchema('rc/github-comment-authz', RELAY_CP_SCHEMAS['rc/github-comment-authz']),
  frameSchema('rc/github-comment-authz/ok', RELAY_CP_SCHEMAS['rc/github-comment-authz/ok']),
  frameSchema('rc/codehost-membership-authz', RELAY_CP_SCHEMAS['rc/codehost-membership-authz']),
  frameSchema('rc/codehost-membership-authz/ok', RELAY_CP_SCHEMAS['rc/codehost-membership-authz/ok']),
  frameSchema('rc/github-rerequest', RELAY_CP_SCHEMAS['rc/github-rerequest']),
  frameSchema('rc/github-rerequest/ok', RELAY_CP_SCHEMAS['rc/github-rerequest/ok']),
  frameSchema('rc/hook-assign', RELAY_CP_SCHEMAS['rc/hook-assign']),
  frameSchema('rc/hook-remove', RELAY_CP_SCHEMAS['rc/hook-remove']),
  frameSchema('rc/hook-rerun', RELAY_CP_SCHEMAS['rc/hook-rerun']),
  frameSchema('rc/hook-rerun/ok', RELAY_CP_SCHEMAS['rc/hook-rerun/ok']),
  frameSchema('rc/run-report', RELAY_CP_SCHEMAS['rc/run-report']),
  frameSchema('rc/github-installation', RELAY_CP_SCHEMAS['rc/github-installation']),
  frameSchema('rc/daemon-revoke', RELAY_CP_SCHEMAS['rc/daemon-revoke']),
  frameSchema('rc/bot-assign', RELAY_CP_SCHEMAS['rc/bot-assign']),
  frameSchema('rc/bot-unassign', RELAY_CP_SCHEMAS['rc/bot-unassign']),
  frameSchema('rc/routes', RELAY_CP_SCHEMAS['rc/routes']),
  frameSchema('rc/assign', RELAY_CP_SCHEMAS['rc/assign']),
  frameSchema('rc/participant-assign', RELAY_CP_SCHEMAS['rc/participant-assign']),
  frameSchema('rc/set-channel-agent', RELAY_CP_SCHEMAS['rc/set-channel-agent']),
  frameSchema('rc/bot-channels', RELAY_CP_SCHEMAS['rc/bot-channels']),
  frameSchema('rc/bot-conversation', RELAY_CP_SCHEMAS['rc/bot-conversation']),
  frameSchema('rc/bot-revoked', RELAY_CP_SCHEMAS['rc/bot-revoked']),
  frameSchema('rc/bot-revoked/ok', RELAY_CP_SCHEMAS['rc/bot-revoked/ok']),
  frameSchema('rc/notice-posted', RELAY_CP_SCHEMAS['rc/notice-posted']),
  frameSchema('rc/thread-assign', RELAY_CP_SCHEMAS['rc/thread-assign']),
  frameSchema('rc/thread-participant', RELAY_CP_SCHEMAS['rc/thread-participant']),
  frameSchema('rc/thread-lookup', RELAY_CP_SCHEMAS['rc/thread-lookup']),
  frameSchema('rc/thread-lookup/ok', RELAY_CP_SCHEMAS['rc/thread-lookup/ok']),
  frameSchema('rc/collab-routes', RELAY_CP_SCHEMAS['rc/collab-routes']),
  frameSchema('rc/mcp-assign', RELAY_CP_SCHEMAS['rc/mcp-assign']),
  frameSchema('rc/mcp-unassign', RELAY_CP_SCHEMAS['rc/mcp-unassign']),
  frameSchema('rc/memoryconnection-assign', RELAY_CP_SCHEMAS['rc/memoryconnection-assign']),
  frameSchema('rc/memoryconnection-unassign', RELAY_CP_SCHEMAS['rc/memoryconnection-unassign']),
  frameSchema('error', RELAY_CP_SCHEMAS['error'])
])
export type RelayCpFrame = z.infer<typeof RelayCpFrame>

/** Runtime guard: is `t` a known relay↔CP frame `type`? */
export function isRelayCpFrameType(t: string): t is RelayCpFrameType {
  return Object.prototype.hasOwnProperty.call(RELAY_CP_SCHEMAS, t)
}

/** Decode one relay↔CP wire frame (envelope + typed payload). */
export function decodeRelayCpFrame(text: string): DecodeResultOf<RelayCpFrame> {
  return decodeEnvelopeWith<RelayCpFrame>(RELAY_CP_SCHEMAS, text)
}

/** Build a relay↔CP frame with a compile-time-typed payload. */
export function buildRelayCpFrame<T extends RelayCpFrameType>(
  type: T,
  payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>,
  opts: BuildOpts = {}
): RelayCpFrame {
  return buildEnvelopeRaw(type, payload, opts) as RelayCpFrame
}
