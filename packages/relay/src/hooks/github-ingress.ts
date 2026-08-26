/**
 * GitHub ingress — `POST /webhooks/github`, the relay's App-level GitHub
 * webhook endpoint (webhook-triggers-and-github-events.md P2, decisions 1/6/10/11).
 * The second of the two bearer-less writable public entrypoints; unlike the
 * generic ingress the signature check is MANDATORY:
 *
 *  - the route is always mounted, but answers 404 before the immutable startup
 *    deployment snapshot supplies a secret (design decision 13);
 *  - `X-Hub-Signature-256` over the raw bytes, timing-safe; failure ⇒ 401;
 *  - verified but unmatched deliveries still answer 202 (no subscription-
 *    topology oracle); `ping` answers 204 after verification;
 *  - `application/json` only, 1 MiB body cap, payload NEVER logged.
 *
 * `installation` / `installation_repositories` events are not matched — they
 * become an `rc/github-installation` doorbell poke and the CP re-pulls the
 * facts from GitHub (decision 11). Subscription events (`issues`,
 * `pull_request`, `issue_comment`) match against the CP-compiled rules by
 * NUMERIC repo id, gated per rule by the org's installation set (decision 6),
 * with a bot-sender veto except for PR revisions authored by this App (decision
 * 10). Same-repository revisions enter the internal CI lane; fork revisions
 * remain behind workflow approval. Every matching hook fires its own `rd/msg`
 * (msgId is hookId-prefixed, so fan-out of one delivery to several hooks never
 * self-dedups at the daemon).
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  GITHUB_REQUEST_REVIEW_ACTION,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  isGithubPullRequestRevisionEvent,
  type RcGithubCommentAuthz,
  type RcGithubRerequest,
  type RcGithubRerequestResult,
  type RcPullRequestFeedback,
  type GithubHookMetadata,
  type HookContext,
  type RcGithubInstallation,
  type RcHookAssign,
  type RcRunReport,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../relay-daemon-server.js'
import type { HookTable } from './hook-table.js'
import type { HookRateLimiter } from './rate-limit.js'
import { dispatchHookFire } from './ingress.js'
import { hookSnapshotForDelivery } from './hook-snapshot.js'
import { verifySha256Header } from './signature.js'
import type { Logger } from '../log.js'

/** Raw-body cap for the GitHub endpoint (design: 1 MiB — GitHub's own payload cap). */
export const GITHUB_BODY_LIMIT = 1024 * 1024
/** `HookContext.bodyExcerpt` cap (design: 4 KiB) — the agent pulls the full thread itself. */
export const GITHUB_BODY_EXCERPT_MAX = 4 * 1024

/** The event families that are matched against hook rules (everything else: 202 no-op). */
const SUBSCRIPTION_EVENTS = new Set(['issues', 'pull_request', 'issue_comment', 'pull_request_review_comment', 'push'])
/** The events that ring the installation doorbell instead of matching. */
const INSTALLATION_EVENTS = new Set(['installation', 'installation_repositories'])

export interface GithubIngressDeps {
  table: HookTable
  /** Late-bound: the rd/* server exists only after `listen()` (routes register before). */
  daemons: () => Pick<RelayDaemonServer, 'get'> | undefined
  /** Emit one delivery-stage `rc/run-report` EVT to the CP (fire-and-forget). */
  report: (report: RcRunReport) => void
  /** Emit one `rc/github-installation` doorbell EVT to the CP (fire-and-forget). */
  doorbell: (poke: RcGithubInstallation) => void
  /** Persist body-free PR feedback before the signed webhook is acknowledged. */
  reportPullRequestFeedback?: (signal: RcPullRequestFeedback) => Promise<boolean>
  /** Resolve the current write authority of every issue/PR actor. This is
   *  metadata-only; the implementation delegates to the CP's GitHub App. */
  authorizeComment: (request: RcGithubCommentAuthz) => Promise<boolean>
  /** Resolve a signed review control through CP-owned durable metadata. */
  authorizeRerequest: (request: RcGithubRerequest) => Promise<RcGithubRerequestResult>
  /** Dedicated upstream-call budget, shared by every hook on one repository. */
  authzLimiter: HookRateLimiter
  limiter: HookRateLimiter
  clock: Clock
  log: Logger
  /** The App webhook secret from this process's immutable startup snapshot. */
  webhookSecret: () => string | undefined
}

/** The slice of a GitHub webhook payload the matcher/envelope reads. Everything
 *  here is UNTRUSTED except as a filter input; authorization is the CP-compiled
 *  `installationIds` set (security boundary 3). */
interface GithubPayload {
  action?: string
  changes?: { base?: unknown }
  installation?: { id?: number }
  repository?: GithubRepositoryRef
  sender?: { login?: string; type?: string; avatar_url?: string }
  requested_reviewer?: { login?: string; type?: string }
  requested_action?: { identifier?: string }
  issue?: GithubSubject
  pull_request?: GithubSubject
  comment?: {
    id?: number
    pull_request_review_id?: number
    in_reply_to_id?: number | null
    body?: string
    html_url?: string
    user?: { login?: string }
    author_association?: string
  }
  review?: { body?: string | null; state?: string; user?: { login?: string } }
  // push ("commits") deliveries — no subject, no action.
  ref?: string // 'refs/heads/main'
  compare?: string // diff URL for the pushed range
  head_commit?: { message?: string | null } | null
  commits?: Array<{ message?: string | null }> // ≤20 in the payload (GitHub truncates)
  check_run?: {
    id?: number
    head_sha?: string
    pull_requests?: Array<{
      number?: number
      head?: { sha?: string; repo?: { id?: number } | null }
      base?: { sha?: string; repo?: { id?: number } | null }
    }>
  }
  check_suite?: {
    id?: number
    head_sha?: string
    app?: { id?: number }
    conclusion?: string | null
    pull_requests?: Array<{ number?: number }>
  }
  workflow_run?: {
    event?: string
    head_sha?: string
    triggering_actor?: { login?: string }
    pull_requests?: Array<{ number?: number; head?: { sha?: string } }>
  }
}

/** The delivery's own repository. `owner.type` is GitHub's signed owner kind. */
interface GithubRepositoryRef {
  id?: number
  full_name?: string
  owner?: { login?: string; type?: string }
}

interface GithubSubject {
  number?: number
  title?: string
  body?: string | null
  html_url?: string
  user?: { login?: string; type?: string }
  author_association?: string
  labels?: Array<{ name?: string }>
  head?: { sha?: string; repo?: { full_name?: string } | null }
  base?: { sha?: string; repo?: { full_name?: string } | null }
  merge_commit_sha?: string | null
  merged?: boolean
  draft?: boolean
  /** Present on the `issue` object when an `issue_comment` belongs to a PR. */
  pull_request?: unknown
}

/** The per-delivery facts the match predicate consumes (extracted once). */
export interface GithubMatchCtx {
  event: string // 'issues'
  eventAction: string // 'issues:opened'; action-less events (push) carry just 'push' —
  // never equal to a stored `family:action` pattern, so they match via `family:*` only
  installationId: string | undefined // String(payload.installation.id); absent ⇒ never matches
  labels: string[] // the subject's CURRENT labels (not payload.label)
  senderType: string | undefined // 'User' | 'Bot' | …
  // P3 gating inputs: content/thread authors and the event's authored text —
  // comment body, else issue/PR body, else the head commit message. Handles are
  // matched locally, but actor permission is always resolved live by the CP.
  subjectAuthorLogin?: string
  subjectAuthorType?: string
  headRepoFullName?: string
  baseRepoFullName?: string
  commentAuthorLogin?: string
  /** The organization login that scopes `@<owner>/<agent>` team mentions.
   *  Absent for a personal repository, which has no teams to mention. */
  teamOwnerLogin?: string
  mentionText: string | undefined
  /** GitHub's native reviewer request target. Only this App's `[bot]` login
   * turns `pull_request:review_requested` into a manual review request. */
  requestedReviewerLogin?: string
  /** Signed `pull_request:edited` proof that the target branch changed. */
  baseChanged?: boolean
  /** The derived family of the comment's subject/thread. `issue_comment` uses
   *  the issue object's `pull_request` marker; review comments are always PR. */
  commentSubjectFamily: 'issues' | 'pull_request' | undefined
}

function isGithubPullRequestRevision(ctx: Pick<GithubMatchCtx, 'eventAction' | 'baseChanged'>): boolean {
  return isGithubPullRequestRevisionEvent(ctx.eventAction, ctx)
}

function githubPullRequestBaseChanged(event: string, payload: GithubPayload): boolean {
  return event === 'pull_request' && payload.action === 'edited' && payload.changes?.base !== undefined
}

/** Lifecycle deliveries that close a GitHub thread's daemon-owned workspace.
 * PR `closed` is cleanup only when GitHub also proves it was merged; an
 * unmerged PR may still be reopened and keeps its session worktree. */
function githubThreadWorktreeCleanupEvent(event: string, payload: GithubPayload): string | undefined {
  if (event === 'issues' && (payload.action === 'closed' || payload.action === 'deleted')) {
    return `issues:${payload.action}`
  }
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true) {
    return 'pull_request:merged'
  }
  return undefined
}

/** A no-match failed a static rule gate; trusted is immediately dispatchable;
 *  needs-authz passed every static gate but needs live maintainer authorization. */
export type GithubRuleVerdict = 'no-match' | 'trusted' | 'needs-authz'

/** `@<handle>` as a whole token, case-insensitive (GitHub logins are), bounded
 *  on BOTH sides: a slug prefix must not match (`@example-review` ≠
 *  `@example-review-app`) and a word-char before the `@` must not either —
 *  GitHub never renders `team@slug.dev` as a mention. A trailing `/<slug>` is
 *  GitHub's TEAM form, so it never reads as a bare mention of the owner. */
export function mentionsGithubHandle(body: string | undefined, handle: string | undefined): boolean {
  if (!body || !handle) return false
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w-])@${escaped}(?![\\w-]|/[\\w-])`, 'i').test(body)
}

/** `@<owner>/<agent-slug>` — GitHub's team-mention form. An org team named after
 *  the agent slug makes the targeted handle autocomplete in GitHub's composer;
 *  the team only has to exist and be visible, and matching stays pure text. */
export function mentionsGithubTeam(
  body: string | undefined,
  owner: string | undefined,
  slug: string | undefined
): boolean {
  return !!owner && !!slug && mentionsGithubHandle(body, `${owner}/${slug}`)
}

/** The organization whose teams a team mention can name. A personal repository
 *  has no teams, so an owner GitHub does not sign as `Organization` yields none
 *  and `@<owner>/<agent>` stays inert there — including a payload too old or too
 *  partial to carry the owner kind. */
export function githubTeamOwner(repository: GithubRepositoryRef | undefined): string | undefined {
  if (repository?.owner?.type !== 'Organization') return undefined
  return repository.owner.login || repository.full_name?.split('/')[0] || undefined
}

function requestsGithubAppReviewer(login: string | undefined, appSlug: string | undefined): boolean {
  return !!login && !!appSlug && login.toLowerCase() === `${appSlug}[bot]`.toLowerCase()
}

function githubRuleSupportsPullRequests(rule: RcHookAssign): boolean {
  if (!rule.github) return false
  const commentFamilies = rule.github.commentFamilies
  return rule.github.events.some(
    (event) =>
      event.startsWith('pull_request:') ||
      event.startsWith('pull_request_review_comment:') ||
      (event.startsWith('issue_comment:') &&
        (!commentFamilies || commentFamilies.length === 0 || commentFamilies.includes('pull_request')))
  )
}

function isConfiguredAppPullRequest(rule: RcHookAssign, ctx: GithubMatchCtx): boolean {
  if (
    ctx.event !== 'pull_request' ||
    !isGithubPullRequestRevision(ctx) ||
    !rule.github?.appSlug ||
    ctx.subjectAuthorType !== 'Bot' ||
    !ctx.subjectAuthorLogin
  )
    return false
  return ctx.subjectAuthorLogin.toLowerCase() === `${rule.github.appSlug}[bot]`.toLowerCase()
}

/** A same-repository App-authored revision is the internal CI lane. It may
 * trigger review without treating the App bot as a human maintainer. */
function isInternalAppPullRequest(rule: RcHookAssign, ctx: GithubMatchCtx): boolean {
  return Boolean(
    isConfiguredAppPullRequest(rule, ctx) &&
    ctx.headRepoFullName &&
    ctx.baseRepoFullName &&
    ctx.headRepoFullName.toLowerCase() === ctx.baseRepoFullName.toLowerCase()
  )
}

function isGithubThreadComment(ctx: GithubMatchCtx): boolean {
  return ctx.event === 'issue_comment' || ctx.event === 'pull_request_review_comment'
}

/** The targeted agent handle in either accepted form: the bare slug, or the
 *  `@<owner>/<slug>` team an org creates so the same handle autocompletes. */
function githubMentionsAgent(body: string | undefined, rule: RcHookAssign, owner: string | undefined): boolean {
  return mentionsGithubHandle(body, rule.github?.agentName) || mentionsGithubTeam(body, owner, rule.github?.agentName)
}

function githubRuleIsSummoned(rule: RcHookAssign, ctx: GithubMatchCtx): boolean {
  return (
    mentionsGithubHandle(ctx.mentionText, rule.github?.appSlug) ||
    githubMentionsAgent(ctx.mentionText, rule, ctx.teamOwnerLogin)
  )
}

/** Explicit agent handles narrow a repo fan-out; the App handle deliberately
 *  wins as the broadcast form. A non-AgentConnect @mention changes nothing. */
export function githubMentionCandidates(
  rules: RcHookAssign[],
  body: string | undefined,
  owner?: string
): RcHookAssign[] {
  if (rules.some((rule) => mentionsGithubHandle(body, rule.github?.appSlug))) return rules
  const targetedAgentIds = new Set(
    rules.filter((rule) => githubMentionsAgent(body, rule, owner)).map((rule) => rule.agentId)
  )
  return targetedAgentIds.size === 0 ? rules : rules.filter((rule) => targetedAgentIds.has(rule.agentId))
}

/**
 * One rule's verdict for one delivery (pure; exported for unit tests).
 * Order: lifecycle-noise veto → bot veto → attribution gate → cadence/additive
 * summon match → comment scope → mention-only gate → labels → live-authz gate.
 */
export function githubRuleVerdict(rule: RcHookAssign, ctx: GithubMatchCtx): GithubRuleVerdict {
  if (rule.kind !== 'github' || !rule.github) return 'no-match'
  // Deletion payloads describe removed content, never new work. Issue deletion
  // is handled separately as maintenance cleanup; comment/review-comment
  // deletion remains a silent no-op even for explicit legacy wildcards.
  if (ctx.eventAction === `${ctx.event}:deleted`) return 'no-match'
  // Lifecycle/content edits are silent; a signed target-branch change is revision-bearing despite action `edited`.
  if (
    (ctx.event === 'issues' &&
      (ctx.eventAction === 'issues:closed' ||
        ctx.eventAction === 'issues:reopened' ||
        ctx.eventAction === 'issues:edited')) ||
    (ctx.event === 'pull_request' &&
      (ctx.eventAction === 'pull_request:closed' ||
        ctx.eventAction === 'pull_request:reopened' ||
        (ctx.eventAction === 'pull_request:edited' && !isGithubPullRequestRevision(ctx)) ||
        ctx.eventAction === 'pull_request:ready_for_review' ||
        ctx.eventAction === 'pull_request:converted_to_draft'))
  )
    return 'no-match'
  // Decision 10: bot-authored comments/review-comments and unrelated bot PRs
  // remain vetoed; only this App's same-repository PR revisions enter review.
  if (ctx.senderType === 'Bot' && !isConfiguredAppPullRequest(rule, ctx)) return 'no-match'
  // Decision 6(a): the org-attribution gate. An event that cannot prove its
  // installation does not fire.
  if (!ctx.installationId || !rule.github.installationIds.includes(ctx.installationId)) return 'no-match'
  // GitHub's native reviewer control bypasses cadence, label, and mention filters, but only for
  // this App bot as the requested reviewer and only after live repository-role authorization.
  if (ctx.eventAction === 'pull_request:review_requested') {
    return requestsGithubAppReviewer(ctx.requestedReviewerLogin, rule.github.appSlug) &&
      githubRuleSupportsPullRequests(rule)
      ? 'needs-authz'
      : 'no-match'
  }
  // Diff-line review comments are comments: an `issue_comment` subscription
  // covers them (alias), so mention mode picks up a handle on a diff line
  // without a new console family. Explicit patterns still work via the API.
  const action = ctx.eventAction.includes(':') ? ctx.eventAction.slice(ctx.eventAction.indexOf(':')) : ''
  const matchesPattern = (event: string): boolean =>
    (action !== '' && rule.github!.events.includes(`${event}${action}`)) || rule.github!.events.includes(`${event}:*`)
  const nativeEventMatched = matchesPattern(ctx.event)
  // Diff-line review comments may ride the shared issue_comment subscription;
  // an explicit review-comment API subscription remains authoritative.
  const sharedCommentAliasMatched = ctx.event === 'pull_request_review_comment' && matchesPattern('issue_comment')
  const summoned = githubRuleIsSummoned(rule, ctx)
  // "created" is an additive cadence: opening events fire normally, while a
  // later explicit summon in the same selected issue/PR family may fire too.
  // Keep the fallback to the same event universe as mention-only mode: thread
  // lifecycle events plus newly-created conversation/review comments.
  const createdCadenceSummonFamily =
    ctx.event === 'issues' || ctx.event === 'pull_request'
      ? ctx.event
      : (ctx.event === 'issue_comment' || ctx.event === 'pull_request_review_comment') && action === ':created'
        ? ctx.commentSubjectFamily
        : undefined
  const createdCadenceSummonMatched =
    summoned &&
    createdCadenceSummonFamily !== undefined &&
    rule.github.events.includes(`${createdCadenceSummonFamily}:opened`)
  const eventMatched = nativeEventMatched || sharedCommentAliasMatched || createdCadenceSummonMatched
  if (!eventMatched) return 'no-match'
  // `issue_comment` is one repo-wide GitHub event for BOTH issue and PR
  // conversations. A new CP explicitly supplies the console-selected thread
  // families; absent/empty preserves every legacy/API rule's repo-wide event
  // union. An explicit pull_request_review_comment subscription bypasses this
  // shared-comment scope; alias and created-cadence summon matches do not.
  const matchedViaSharedComment =
    ctx.event === 'issue_comment' || (!nativeEventMatched && (sharedCommentAliasMatched || createdCadenceSummonMatched))
  const commentFamilies = rule.github.commentFamilies
  if (
    matchedViaSharedComment &&
    ctx.commentSubjectFamily &&
    commentFamilies &&
    commentFamilies.length > 0 &&
    !commentFamilies.includes(ctx.commentSubjectFamily)
  )
    return 'no-match'
  // P3 mention-only mode: the agent reacts only when SUMMONED — the event's authored
  // text (issue/PR body, comment, commit message) must @-mention the App or this
  // agent. An issue whose body contains either handle keeps firing its later non-terminal
  // events (for example, labeled): the thread summoned the agent, so its
  // updates keep flowing.
  if (rule.github.mentionOnly && !summoned) return 'no-match'
  if (rule.github.labelFilter.length > 0 && !ctx.labels.some((l) => rule.github!.labelFilter.includes(l)))
    return 'no-match'

  // GitHub's relationship labels are descriptive, not an authorization proof: MEMBER and
  // COLLABORATOR may still hold read only. Every numbered-thread event resolves the live role.
  return ctx.event === 'push' || isInternalAppPullRequest(rule, ctx) ? 'trusted' : 'needs-authz'
}

/** Truncate on a UTF-8 BYTE budget, cutting at a code-point boundary — the
 *  design's excerpt cap is a byte unit, and `String#slice` counts UTF-16 code
 *  units (a CJK body would ride the wire at up to 3× the cap). */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const buf = Buffer.from(text, 'utf8')
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end-- // never split a code point
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

/** The daemon renders the title on its TRUSTED header line — flatten whitespace
 *  and cap it so attacker-authored framing stays one short line (security boundary 1;
 *  the body goes inside the untrusted fence, the title merely gets defanged). */
function sanitizeTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

/** Build the trimmed envelope shared by every hook this delivery fans out to
 *  (exported for unit tests). Comment fields win over the subject's for
 *  `issue_comment` deliveries — the comment is what fired. Push deliveries have
 *  no subject: the head commit message is the excerpt, the compare URL the link. */
export function buildGithubContext(event: string, payload: GithubPayload): HookContext {
  const subject = payload.issue ?? payload.pull_request
  const bodySource = payload.comment?.body ?? subject?.body ?? payload.head_commit?.message ?? ''
  const excerpt = truncateUtf8(bodySource, GITHUB_BODY_EXCERPT_MAX)
  return {
    source: 'github',
    event,
    ...(payload.action ? { action: payload.action } : {}),
    ...(payload.repository?.full_name ? { repo: payload.repository.full_name } : {}),
    ...(subject?.number !== undefined ? { number: subject.number } : {}),
    ...(subject?.title ? { title: sanitizeTitle(subject.title) } : {}),
    ...(payload.sender?.login ? { senderLogin: payload.sender.login } : {}),
    ...(payload.sender?.avatar_url ? { senderAvatarUrl: payload.sender.avatar_url } : {}),
    ...((payload.comment?.author_association ?? subject?.author_association)
      ? { authorAssociation: payload.comment?.author_association ?? subject?.author_association }
      : {}),
    ...(subject?.labels ? { labels: subject.labels.map((l) => l.name ?? '').filter(Boolean) } : {}),
    ...((payload.comment?.html_url ?? subject?.html_url ?? payload.compare)
      ? { htmlUrl: payload.comment?.html_url ?? subject?.html_url ?? payload.compare }
      : {}),
    ...(excerpt.text ? { bodyExcerpt: excerpt.text } : {}),
    truncated: excerpt.truncated
  }
}

/**
 * Cut the body-free, trusted subject/revision envelope for one matched rule.
 * Push has no issue/PR subject and therefore returns undefined: review/check
 * settings are PR-only. A PR issue_comment has no revision in GitHub's payload;
 * it still carries repo/pull identity and the daemon resolves the SHA before
 * the hook/start barrier.
 */
export function buildTrustedGithubMetadata(
  event: string,
  payload: GithubPayload,
  rule: RcHookAssign
): GithubHookMetadata | undefined {
  if (!rule.github || event === 'push') return undefined
  const installationId = payload.installation?.id
  const repoId = payload.repository?.id
  if (installationId === undefined || repoId === undefined || String(repoId) !== rule.github.repoId) return undefined

  const subject = payload.issue ?? payload.pull_request
  if (subject?.number === undefined) return undefined
  const isPullRequest =
    payload.pull_request !== undefined ||
    event === 'pull_request' ||
    event === 'pull_request_review_comment' ||
    (event === 'issue_comment' && payload.issue?.pull_request !== undefined)
  const explicitReviewRequest =
    rule.reviewPolicy !== undefined &&
    rule.reviewPolicy !== 'off' &&
    isPullRequest &&
    event === 'issue_comment' &&
    payload.action === 'created' &&
    (mentionsGithubHandle(payload.comment?.body, rule.github.appSlug) ||
      githubMentionsAgent(payload.comment?.body, rule, githubTeamOwner(payload.repository)))
  const pr = payload.pull_request
  const headSha = pr?.head?.sha
  const baseChanged = githubPullRequestBaseChanged(event, payload)
  const rawReviewCommentId = event === 'pull_request_review_comment' ? payload.comment?.id : undefined
  const rawPullRequestReviewId =
    event === 'pull_request_review_comment' ? payload.comment?.pull_request_review_id : undefined
  const pullRequestReviewId =
    rawPullRequestReviewId !== undefined && Number.isSafeInteger(rawPullRequestReviewId) && rawPullRequestReviewId > 0
      ? rawPullRequestReviewId
      : undefined
  const reviewCommentId =
    rawReviewCommentId !== undefined && Number.isSafeInteger(rawReviewCommentId) && rawReviewCommentId > 0
      ? rawReviewCommentId
      : undefined
  // The comment that fired an `issue_comment` delivery; its inline-review twin is
  // `reviewCommentId` above. Trusted because it comes off the signature-verified payload.
  const rawIssueCommentId = event === 'issue_comment' ? payload.comment?.id : undefined
  const issueCommentId = positiveSafeInteger(rawIssueCommentId) ? rawIssueCommentId : undefined
  const rawReplyToId = event === 'pull_request_review_comment' ? payload.comment?.in_reply_to_id : undefined
  // GitHub sends a null/absent in_reply_to_id for a thread root. A present but
  // invalid parent must fail closed instead of silently redirecting the reply
  // to the triggering child comment.
  const rawReviewThreadRootCommentId = rawReplyToId == null ? reviewCommentId : rawReplyToId
  const reviewThreadRootCommentId =
    rawReviewThreadRootCommentId !== undefined &&
    Number.isSafeInteger(rawReviewThreadRootCommentId) &&
    rawReviewThreadRootCommentId > 0
      ? rawReviewThreadRootCommentId
      : undefined

  return {
    repoId: String(repoId),
    repoFullName: payload.repository?.full_name ?? rule.github.repoFullName,
    sourceInstallationId: String(installationId),
    subjectKind: isPullRequest ? 'pull_request' : 'issue',
    ...(isPullRequest ? { pullNumber: subject.number } : {}),
    ...(headSha ? { headSha, reportSha: headSha } : {}),
    ...(pr?.base?.sha ? { baseSha: pr.base.sha } : {}),
    ...(pr?.head?.repo?.full_name ? { headRepoFullName: pr.head.repo.full_name } : {}),
    ...(pr?.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
    ...(pr?.draft !== undefined ? { isDraft: pr.draft } : {}),
    ...(event === 'pull_request' && payload.action === 'edited' ? { baseChanged } : {}),
    ...(explicitReviewRequest ? { explicitReviewRequest: true } : {}),
    ...(pullRequestReviewId !== undefined ? { pullRequestReviewId: String(pullRequestReviewId) } : {}),
    ...(reviewCommentId !== undefined ? { reviewCommentId: String(reviewCommentId) } : {}),
    ...(reviewThreadRootCommentId !== undefined
      ? { reviewThreadRootCommentId: String(reviewThreadRootCommentId) }
      : {}),
    ...(issueCommentId !== undefined ? { issueCommentId: String(issueCommentId) } : {})
  }
}

function headerString(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

const FAILED_CHECK_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure'
])

function pullRequestFeedbackSignals(
  event: string,
  payload: GithubPayload,
  deliveryKey: string
): RcPullRequestFeedback[] {
  const installationId = payload.installation?.id
  const repoId = payload.repository?.id
  const repoFullName = payload.repository?.full_name?.trim()
  if (!positiveSafeInteger(installationId) || !positiveSafeInteger(repoId) || !repoFullName) return []
  const build = (pullNumber: number): RcPullRequestFeedback => ({
    deliveryKey: `${deliveryKey.slice(0, 150)}:${event}:${pullNumber}`,
    installationId: String(installationId),
    repoId: String(repoId),
    repoFullName,
    pullNumber
  })

  if (event === 'pull_request_review' && payload.action === 'submitted') {
    const pullNumber = payload.pull_request?.number
    const state = payload.review?.state?.toLowerCase()
    const hasBody = Boolean(payload.review?.body?.trim())
    return positiveSafeInteger(pullNumber) && (state === 'changes_requested' || hasBody) ? [build(pullNumber)] : []
  }
  if (event === 'pull_request_review_comment' && (payload.action === 'created' || payload.action === 'edited')) {
    const pullNumber = payload.pull_request?.number
    return positiveSafeInteger(pullNumber) ? [build(pullNumber)] : []
  }
  if (
    event === 'issue_comment' &&
    (payload.action === 'created' || payload.action === 'edited') &&
    payload.issue?.pull_request !== undefined
  ) {
    const pullNumber = payload.issue.number
    return positiveSafeInteger(pullNumber) ? [build(pullNumber)] : []
  }
  if (event === 'check_suite' && payload.action === 'completed') {
    const conclusion = payload.check_suite?.conclusion?.toLowerCase()
    if (!conclusion || !FAILED_CHECK_CONCLUSIONS.has(conclusion)) return []
    const pulls = new Set(
      (payload.check_suite?.pull_requests ?? [])
        .map((pull) => pull.number)
        .filter((pull): pull is number => positiveSafeInteger(pull))
    )
    return [...pulls].map((pullNumber) => build(pullNumber))
  }
  return []
}

type GithubRerequestTarget = {
  hookId: string
  pullNumber: number
  baseSha: string
  configRevision: string
  dispatchRevision: string
}

type GithubRerequestRule = RcHookAssign & { github: NonNullable<RcHookAssign['github']> }

function currentGithubRerequestRule(
  table: HookTable,
  target: GithubRerequestTarget,
  repoId: number,
  installationId: number,
  source: 'check' | 'workflow',
  expected?: Pick<RcHookAssign, 'agentId' | 'daemonId' | 'dispatchDaemonId'>
): GithubRerequestRule | undefined {
  const rule = table.getByHookId(target.hookId)
  if (
    !rule ||
    rule.kind !== 'github' ||
    !rule.github ||
    rule.github.repoId !== String(repoId) ||
    !rule.github.installationIds.includes(String(installationId)) ||
    rule.configRevision !== target.configRevision ||
    rule.dispatchRevision !== target.dispatchRevision ||
    (source === 'check'
      ? rule.reportingMode !== 'check' || rule.gateMode !== 'informational'
      : rule.reviewPolicy === undefined || rule.reviewPolicy === 'off') ||
    (expected !== undefined &&
      (rule.agentId !== expected.agentId ||
        rule.daemonId !== expected.daemonId ||
        rule.dispatchDaemonId !== expected.dispatchDaemonId))
  ) {
    return undefined
  }
  return rule as GithubRerequestRule
}

async function dispatchGithubRerequest(
  deps: GithubIngressDeps,
  payload: GithubPayload,
  deliveryKey: string,
  event: 'check_run' | 'check_suite' | 'workflow_run',
  action: 'rerequested' | 'requested_action' | 'in_progress'
): Promise<void> {
  const checkRunId = payload.check_run?.id
  const checkSuiteId = payload.check_suite?.id
  const appId = payload.check_suite?.app?.id
  const repoId = payload.repository?.id
  const repoFullName = payload.repository?.full_name
  const installationId = payload.installation?.id
  const headSha =
    event === 'check_run'
      ? payload.check_run?.head_sha
      : event === 'check_suite'
        ? payload.check_suite?.head_sha
        : payload.workflow_run?.head_sha
  if (
    !positiveSafeInteger(repoId) ||
    !positiveSafeInteger(installationId) ||
    !repoFullName ||
    !headSha ||
    (event === 'check_run' && !positiveSafeInteger(checkRunId)) ||
    (event === 'check_suite' && (!positiveSafeInteger(checkSuiteId) || !positiveSafeInteger(appId))) ||
    (event === 'workflow_run' && payload.workflow_run?.event !== 'pull_request')
  ) {
    deps.log.info(`github ingress: ignored malformed ${event} rerequest ${deliveryKey}`)
    return
  }
  // Projection reverse-lookups have the same dedicated upstream budget as
  // comment authorization. Unknown Check identities must not buy unbounded CP/DB work.
  if (!deps.authzLimiter.allow(`${installationId}:${repoId}`)) {
    deps.log.info(`github ingress: rerequest authz rate-limited ${deliveryKey}`)
    return
  }

  const workflowPulls =
    event === 'workflow_run'
      ? (payload.workflow_run?.pull_requests ?? []).filter(
          (pull) => positiveSafeInteger(pull.number) && pull.head?.sha === headSha
        )
      : []
  const workflowPullNumber = workflowPulls.length === 1 ? workflowPulls[0]?.number : undefined

  let result: RcGithubRerequestResult
  try {
    const request: RcGithubRerequest =
      event === 'check_run'
        ? {
            checkRunId: String(checkRunId),
            repoId: String(repoId),
            headSha,
            deliveryKey,
            ...(action === 'requested_action' ? { includeBaseSha: true as const } : {})
          }
        : event === 'check_suite'
          ? {
              scope: 'suite',
              appId: String(appId),
              installationId: String(installationId),
              repoId: String(repoId),
              headSha,
              deliveryKey
            }
          : {
              scope: 'workflow',
              installationId: String(installationId),
              repoId: String(repoId),
              headSha,
              ...(workflowPullNumber !== undefined ? { pullNumber: workflowPullNumber } : {}),
              deliveryKey
            }
    result = await deps.authorizeRerequest(request)
  } catch {
    // This explicit control action requires the CP. The ordinary GitHub event
    // data path remains available from the relay's local rule table.
    deps.log.warn(`github ingress: rerequest authorization unavailable ${deliveryKey}`)
    return
  }
  if (!result.allowed) {
    deps.log.info(`github ingress: ignored unowned ${event} rerequest ${deliveryKey}`)
    return
  }

  let targets: GithubRerequestTarget[]
  if (event === 'check_suite' || event === 'workflow_run') {
    if (!('targets' in result)) {
      deps.log.info(`github ingress: ignored mismatched ${event} rerequest result ${deliveryKey}`)
      return
    }
    targets = result.targets
  } else {
    if ('targets' in result) {
      deps.log.info(`github ingress: ignored mismatched check_run rerequest result ${deliveryKey}`)
      return
    }
    const pull = payload.check_run?.pull_requests?.find(
      (candidate) => candidate.number === result.pullNumber && candidate.head?.sha === headSha
    )
    const payloadBaseSha =
      pull?.head?.repo?.id === repoId && pull.base?.repo?.id === repoId ? pull.base?.sha : undefined
    const baseSha = result.baseSha ?? payloadBaseSha
    if (!baseSha) {
      deps.log.info(`github ingress: ignored check_run request without an authoritative base ${deliveryKey}`)
      return
    }
    targets = [{ ...result, baseSha }]
  }
  if (new Set(targets.map((target) => target.hookId)).size !== targets.length) {
    deps.log.info(`github ingress: ignored duplicate ${event} rerequest targets ${deliveryKey}`)
    return
  }

  // Re-read after the CP boundary and fence its verdict to this relay's current
  // compiled rules. A disable, retarget, reassign, or mode transition fails the
  // complete suite fan-out closed.
  const candidates = targets.map((target) => {
    const rule = currentGithubRerequestRule(
      deps.table,
      target,
      repoId,
      installationId,
      event === 'workflow_run' ? 'workflow' : 'check'
    )
    return { rule, target }
  })
  if (candidates.some(({ rule }) => rule === undefined)) {
    deps.log.info(`github ingress: ignored stale ${event} rerequest ${deliveryKey}`)
    return
  }
  const resolved = candidates as Array<{ rule: GithubRerequestRule; target: GithubRerequestTarget }>
  const representative = resolved[0]
  if (!representative) return

  const senderLogin = event === 'workflow_run' ? payload.workflow_run?.triggering_actor?.login : payload.sender?.login
  if (!senderLogin) {
    deps.log.info(`github ingress: rerequest authz metadata incomplete ${deliveryKey}`)
    return
  }
  const authzRequest: RcGithubCommentAuthz = {
    hookId: representative.rule.hookId,
    installationId: String(installationId),
    repoId: String(repoId),
    repoFullName,
    senderLogin,
    configRevision: representative.target.configRevision,
    dispatchRevision: representative.target.dispatchRevision,
    ...(resolved.length > 1
      ? {
          siblingFences: resolved.slice(1).map(({ target }) => ({
            hookId: target.hookId,
            configRevision: target.configRevision,
            dispatchRevision: target.dispatchRevision
          }))
        }
      : {})
  }
  try {
    const allowed = await deps.authorizeComment(authzRequest)
    if (!allowed) return
  } catch {
    deps.log.warn(`github ingress: rerequest actor authorization unavailable ${deliveryKey}`)
    return
  }

  const current = resolved.map(({ rule, target }) => {
    const refreshed = currentGithubRerequestRule(
      deps.table,
      target,
      repoId,
      installationId,
      event === 'workflow_run' ? 'workflow' : 'check',
      rule
    )
    return { rule: refreshed, target }
  })
  if (current.some(({ rule }) => rule === undefined)) {
    deps.log.info(`github ingress: ${event} rerequest rule changed ${deliveryKey}`)
    return
  }
  const refreshed = current as Array<{ rule: GithubRerequestRule; target: GithubRerequestTarget }>

  const firedAt = new Date(deps.clock.now()).toISOString()
  const dispatches: Promise<void>[] = []
  for (const { rule, target } of refreshed) {
    const targetDeliveryKey =
      event === 'workflow_run' ? `workflow-approval:${repoId}:${target.pullNumber}:${headSha}` : deliveryKey
    if (!deps.limiter.allow(rule.hookId)) {
      deps.log.info(`github ingress: rate-limited ${rule.hookId}:${targetDeliveryKey} (${event}:${action})`)
      continue
    }
    const github: GithubHookMetadata = {
      repoId: String(repoId),
      repoFullName,
      sourceInstallationId: String(installationId),
      subjectKind: 'pull_request',
      pullNumber: target.pullNumber,
      headSha,
      baseSha: target.baseSha,
      reportSha: headSha,
      ...(event === 'workflow_run' ? { explicitReviewRequest: true } : {})
    }
    const msg: RdMsgHook = {
      source: 'hook',
      agentId: rule.agentId,
      sessionKey: `${rule.github.sessionKeyPrefix ?? repoFullName}#${target.pullNumber}`,
      msgId: `${rule.hookId}:${targetDeliveryKey}`,
      hookId: rule.hookId,
      deliveryKey: targetDeliveryKey,
      firedAt,
      ...hookSnapshotForDelivery(rule),
      event: `${event}:${action}`,
      github,
      context: {
        source: 'github',
        event,
        action,
        repo: repoFullName,
        number: target.pullNumber,
        senderLogin,
        truncated: false
      },
      ...(rule.target ? { target: rule.target } : {})
    }

    dispatches.push(
      dispatchHookFire(
        { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
        rule,
        msg
      )
    )
    deps.log.info(`github ingress: queued ${rule.hookId}:${targetDeliveryKey} (${event}:${action})`)
  }
  await Promise.all(dispatches)
}

function pullRequestNeedsMaintainer(ctx: GithubMatchCtx, prAuthorAuthorized: boolean): boolean {
  return ctx.event === 'pull_request' && ctx.eventAction !== 'pull_request:review_requested' && !prAuthorAuthorized
}

function reportReviewRequestRequired(deps: GithubIngressDeps, rule: RcHookAssign, msg: RdMsgHook): void {
  deps.report({
    hookId: rule.hookId,
    deliveryKey: msg.deliveryKey,
    firedAt: msg.firedAt,
    agentId: rule.agentId,
    daemonId: rule.daemonId,
    ...hookSnapshotForDelivery(rule),
    ...(msg.event ? { event: msg.event } : {}),
    ...(msg.github ? { github: msg.github } : {}),
    status: 'failed',
    reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
  })
}

export function registerGithubIngress(app: FastifyInstance, deps: GithubIngressDeps): void {
  // Own plugin scope: the buffer content parser (raw bytes for the signature)
  // must not leak onto the relay's other JSON surfaces.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: GITHUB_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/webhooks/github', { bodyLimit: GITHUB_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const webhookSecret = deps.webhookSecret()
      if (!webhookSecret) return reply.code(404).send({ error: 'Not Found', statusCode: 404 })
      // MANDATORY signature — only GitHub (or a secret holder) may spend work here.
      if (!verifySha256Header(webhookSecret, raw, headerString(req.headers['x-hub-signature-256']))) {
        return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      }

      const event = headerString(req.headers['x-github-event']) ?? ''
      if (event === 'ping') return reply.code(204).send()

      const deliveryKey = headerString(req.headers['x-github-delivery'])?.slice(0, 200) ?? randomUUID()

      let payload: GithubPayload
      try {
        payload = JSON.parse(raw.toString('utf8')) as GithubPayload
      } catch {
        // Cannot happen from GitHub (it signed valid JSON) — defensive only.
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      }

      const feedbackSignals = pullRequestFeedbackSignals(event, payload, deliveryKey)
      try {
        if (deps.reportPullRequestFeedback) {
          await Promise.all(feedbackSignals.map((signal) => deps.reportPullRequestFeedback!(signal)))
        }
      } catch {
        deps.log.warn(`github ingress: PR feedback persistence unavailable ${deliveryKey}`)
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      }

      if (event === 'check_run' && payload.action === 'rerequested') {
        void dispatchGithubRerequest(deps, payload, deliveryKey, 'check_run', 'rerequested')
        return reply.code(202).send({ deliveryKey })
      }
      if (event === 'check_suite' && payload.action === 'rerequested') {
        void dispatchGithubRerequest(deps, payload, deliveryKey, 'check_suite', 'rerequested')
        return reply.code(202).send({ deliveryKey })
      }
      if (
        event === 'check_run' &&
        payload.action === 'requested_action' &&
        payload.requested_action?.identifier === GITHUB_REQUEST_REVIEW_ACTION
      ) {
        void dispatchGithubRerequest(deps, payload, deliveryKey, 'check_run', 'requested_action')
        return reply.code(202).send({ deliveryKey })
      }
      if (
        event === 'workflow_run' &&
        payload.action === 'in_progress' &&
        payload.workflow_run?.event === 'pull_request'
      ) {
        void dispatchGithubRerequest(deps, payload, deliveryKey, 'workflow_run', 'in_progress')
        return reply.code(202).send({ deliveryKey })
      }

      // Decision 11: installation events are a doorbell, never a run.
      if (INSTALLATION_EVENTS.has(event)) {
        const id = payload.installation?.id
        if (id !== undefined) {
          deps.doorbell({ installationId: String(id), action: payload.action ?? 'unknown' })
          deps.log.info(`github ingress: doorbell ${deliveryKey} installation ${id} (${payload.action ?? 'unknown'})`)
        }
        return reply.code(202).send({ deliveryKey })
      }

      if (!SUBSCRIPTION_EVENTS.has(event)) return reply.code(202).send({ deliveryKey })

      const repoId = payload.repository?.id
      const subject = payload.issue ?? payload.pull_request
      const rules = repoId === undefined ? [] : deps.table.getByRepoId(String(repoId))
      // Thread events need a subject number; push ("commits") events need a ref.
      const thread = subject?.number !== undefined ? String(subject.number) : event === 'push' ? payload.ref : undefined
      if (rules.length === 0 || thread === undefined) return reply.code(202).send({ deliveryKey })

      const cleanupEvent = githubThreadWorktreeCleanupEvent(event, payload)
      const ctx: GithubMatchCtx = {
        event,
        // Action-less events (push) stay bare — they only ever match `family:*`.
        eventAction: cleanupEvent ?? (payload.action ? `${event}:${payload.action}` : event),
        installationId: payload.installation?.id !== undefined ? String(payload.installation.id) : undefined,
        labels: (subject?.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
        senderType: payload.sender?.type,
        subjectAuthorLogin: subject?.user?.login,
        subjectAuthorType: subject?.user?.type,
        headRepoFullName: subject?.head?.repo?.full_name,
        baseRepoFullName: subject?.base?.repo?.full_name,
        commentAuthorLogin: payload.comment?.user?.login,
        teamOwnerLogin: githubTeamOwner(payload.repository),
        requestedReviewerLogin: payload.requested_reviewer?.login,
        baseChanged: githubPullRequestBaseChanged(event, payload),
        commentSubjectFamily:
          event === 'pull_request_review_comment'
            ? 'pull_request'
            : event === 'issue_comment'
              ? payload.issue?.pull_request !== undefined
                ? 'pull_request'
                : 'issues'
              : undefined,
        // push: a summon may sit in ANY pushed commit's message, not just the
        // head (GitHub ships ≤20 in the payload — enough for the mention gate).
        mentionText:
          payload.comment?.body ??
          subject?.body ??
          (event === 'push'
            ? [payload.head_commit?.message, ...(payload.commits ?? []).map((c) => c.message)]
                .filter(Boolean)
                .join('\n') || undefined
            : undefined)
      }
      const context = buildGithubContext(event, payload)
      // Session affinity: issue/PR thread (`prefix#42`) or the pushed branch
      // (`prefix#refs/heads/main`) — the daemon splits on the LAST '#'.
      // The compiled prefix is immutable across GitHub repository renames.
      const fallbackSessionKeyPrefix = payload.repository?.full_name ?? String(repoId)
      const firedAt = new Date(deps.clock.now()).toISOString()

      const dispatchRule = (rule: RcHookAssign, prAuthorAuthorized = false): void => {
        // Post-match per-hook budget: a drop is a skip + metadata log, never a 429
        // (GitHub treats non-2xx as a dead delivery) and never a run row (a storm
        // must not flood hook_run).
        if (!cleanupEvent && !deps.limiter.allow(rule.hookId)) {
          deps.log.info(`github ingress: rate-limited ${rule.hookId}:${deliveryKey} (${ctx.eventAction})`)
          return
        }
        const github = buildTrustedGithubMetadata(event, payload, rule)
        const msg: RdMsgHook = {
          source: 'hook',
          agentId: rule.agentId,
          sessionKey: `${rule.github?.sessionKeyPrefix ?? fallbackSessionKeyPrefix}#${thread}`,
          msgId: `${rule.hookId}:${deliveryKey}`,
          hookId: rule.hookId,
          deliveryKey,
          firedAt,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          ...(github ? { github } : {}),
          context,
          ...(rule.target ? { target: rule.target } : {})
        }
        if (!cleanupEvent && pullRequestNeedsMaintainer(ctx, prAuthorAuthorized)) {
          // No third-party-authored PR lifecycle payload reaches the daemon.
          // Revision events still create a durable, actionable informational
          // Check so a maintainer can request the first review explicitly.
          if (isGithubPullRequestRevision(ctx)) {
            reportReviewRequestRequired(deps, rule, msg)
            deps.log.info(
              `github ingress: waiting for maintainer request ${rule.hookId}:${deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`
            )
          }
          return
        }
        // 202 below does not wait for the daemon; the delivery verdict travels
        // out-of-band with the event:action stamped on for the HookRun row.
        void dispatchHookFire(
          { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
          rule,
          msg
        )
        deps.log.info(`github ingress: queued ${rule.hookId}:${deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`)
      }

      if (cleanupEvent) {
        // Lifecycle cleanup is repository maintenance, not a model-trigger
        // subscription. Fan it out to every currently assigned hook that the
        // signed installation is allowed to address; the daemon no-ops when
        // that hook never created a session for this thread.
        for (const rule of rules) {
          if (
            rule.kind === 'github' &&
            rule.github &&
            ctx.installationId &&
            rule.github.installationIds.includes(ctx.installationId)
          ) {
            dispatchRule(rule)
          }
        }
        return reply.code(202).send({ deliveryKey })
      }

      const currentAuthorizedRule = (
        rule: RcHookAssign,
        authzRequest: RcGithubCommentAuthz
      ): RcHookAssign | undefined => {
        const current = deps.table.getByHookId(authzRequest.hookId)
        if (
          !current ||
          current.hookId !== authzRequest.hookId ||
          current.kind !== 'github' ||
          !current.github ||
          current.github.repoId !== authzRequest.repoId ||
          !current.github.installationIds.includes(authzRequest.installationId) ||
          current.configRevision !== authzRequest.configRevision ||
          current.dispatchRevision !== authzRequest.dispatchRevision ||
          current.agentId !== rule.agentId ||
          current.daemonId !== rule.daemonId ||
          current.dispatchDaemonId !== rule.dispatchDaemonId ||
          githubRuleVerdict(current, ctx) !== 'needs-authz'
        ) {
          deps.log.info(`github ingress: authz rule changed ${rule.hookId}:${deliveryKey}`)
          return undefined
        }
        return current
      }

      const authorizeAndDispatch = async (
        fanout: RcHookAssign[],
        actors: {
          senderLogin: string | undefined
          subjectAuthorLogin?: string
          requireSubjectAuthor?: boolean
        },
        onDenied: 'skip' | 'request-review'
      ): Promise<void> => {
        const installationId = ctx.installationId
        const payloadRepoId = payload.repository?.id
        const repoFullName = payload.repository?.full_name
        const representative = fanout[0]
        if (!representative) return

        if (
          !representative.github ||
          !installationId ||
          payloadRepoId === undefined ||
          !repoFullName ||
          !actors.senderLogin ||
          (actors.requireSubjectAuthor === true && !actors.subjectAuthorLogin) ||
          fanout.some(
            (rule) => !rule.github || rule.configRevision === undefined || rule.dispatchRevision === undefined
          )
        ) {
          deps.log.info(`github ingress: authz metadata incomplete ${representative.hookId}:${deliveryKey}`)
          if (onDenied === 'request-review') for (const rule of fanout) dispatchRule(rule)
          return
        }

        // Permission lookups have their own budget. The repository-wide actor
        // facts are resolved once before any rule dispatch.
        if (!deps.authzLimiter.allow(`${installationId}:${payloadRepoId}`)) {
          deps.log.info(`github ingress: authz rate-limited ${representative.hookId}:${deliveryKey}`)
          if (onDenied === 'request-review') for (const rule of fanout) dispatchRule(rule)
          return
        }

        const authzRequest: RcGithubCommentAuthz = {
          hookId: representative.hookId,
          installationId,
          repoId: String(payloadRepoId),
          repoFullName,
          senderLogin: actors.senderLogin,
          ...(actors.subjectAuthorLogin && actors.subjectAuthorLogin !== actors.senderLogin
            ? { subjectAuthorLogin: actors.subjectAuthorLogin }
            : {}),
          configRevision: representative.configRevision!,
          dispatchRevision: representative.dispatchRevision!,
          ...(fanout.length > 1
            ? {
                siblingFences: fanout.slice(1).map((rule) => ({
                  hookId: rule.hookId,
                  configRevision: rule.configRevision!,
                  dispatchRevision: rule.dispatchRevision!
                }))
              }
            : {})
        }
        let allowed = false
        try {
          allowed = await deps.authorizeComment(authzRequest)
        } catch (err) {
          // Rolling upgrade against an old CP (UNKNOWN_FRAME), timeout, and
          // transient CP/GitHub failures all fail closed.
          deps.log.warn(`github ingress: authz failed ${representative.hookId}:${deliveryKey}: ${String(err)}`)
        }
        // A silent skip is indistinguishable from "GitHub never delivered it" without this line.
        if (!allowed && onDenied === 'skip') {
          deps.log.info(
            `github ingress: authz denied ${representative.hookId}:${deliveryKey} (${ctx.eventAction} actor ${actors.senderLogin})`
          )
          return
        }

        // Authorization waited on at least two remote calls. Re-read the table so a
        // remove/reconfigure/reassignment during that window cannot dispatch
        // the captured stale rule. Exact revisions fence configuration; the
        // assignment tuple is checked explicitly and the CURRENT object is the
        // one dispatched.
        for (const rule of fanout) {
          const current = currentAuthorizedRule(rule, {
            ...authzRequest,
            hookId: rule.hookId,
            configRevision: rule.configRevision!,
            dispatchRevision: rule.dispatchRevision!
          })
          if (current) dispatchRule(current, onDenied === 'request-review' && allowed)
        }
      }

      const candidates =
        ctx.eventAction === 'pull_request:review_requested'
          ? rules
          : githubMentionCandidates(rules, ctx.mentionText, ctx.teamOwnerLogin)
      const matched = candidates
        .map((rule) => ({ rule, verdict: githubRuleVerdict(rule, ctx) }))
        .filter((candidate) => candidate.verdict !== 'no-match')
      // A native reviewer request is an explicit maintainer action; a drop always deserves a line.
      if (ctx.eventAction === 'pull_request:review_requested' && matched.length === 0) {
        deps.log.info(
          `github ingress: reviewer request matched no rule ${deliveryKey} (reviewer ${ctx.requestedReviewerLogin ?? 'none'} github:${repoId}#${thread})`
        )
      }
      if (
        ctx.event === 'issues' ||
        (ctx.event === 'pull_request' && ctx.eventAction !== 'pull_request:review_requested')
      ) {
        for (const rule of matched.filter((candidate) => candidate.verdict === 'trusted').map(({ rule }) => rule)) {
          dispatchRule(rule, true)
        }
        const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
        if (needsAuthz.length === 0) return reply.code(202).send({ deliveryKey })
        void authorizeAndDispatch(
          needsAuthz,
          { senderLogin: ctx.subjectAuthorLogin },
          ctx.event === 'pull_request' ? 'request-review' : 'skip'
        ).catch((err) => {
          deps.log.warn(`github ingress: thread-author authz task failed ${deliveryKey}: ${String(err)}`)
        })
        return reply.code(202).send({ deliveryKey })
      }

      for (const { rule, verdict } of matched) if (verdict === 'trusted') dispatchRule(rule)

      const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
      const queueAuthorizedFanout = (
        fanout: RcHookAssign[],
        actorLogin: string | undefined,
        requireSubjectAuthor = false
      ): void => {
        if (fanout.length === 0) return
        // Never hold GitHub's HTTP request open on the CP/GitHub permission
        // lookup. One repository-scoped decision fences the complete matching
        // fan-out, and every rejection is contained locally.
        void authorizeAndDispatch(
          fanout,
          {
            senderLogin: actorLogin,
            ...(requireSubjectAuthor ? { subjectAuthorLogin: ctx.subjectAuthorLogin, requireSubjectAuthor: true } : {})
          },
          'skip'
        ).catch((err) => {
          deps.log.warn(`github ingress: authz task failed ${fanout[0]!.hookId}:${deliveryKey}: ${String(err)}`)
        })
      }

      if (isGithubThreadComment(ctx)) {
        queueAuthorizedFanout(
          needsAuthz.filter((rule) => githubRuleIsSummoned(rule, ctx)),
          ctx.commentAuthorLogin
        )
        queueAuthorizedFanout(
          needsAuthz.filter((rule) => !githubRuleIsSummoned(rule, ctx)),
          ctx.commentAuthorLogin,
          true
        )
      } else {
        // Native reviewer requests authorize the action actor. Issue/PR
        // lifecycle events already returned through the subject-author batch.
        queueAuthorizedFanout(needsAuthz, payload.sender?.login)
      }
      return reply.code(202).send({ deliveryKey })
    })
  })
}
