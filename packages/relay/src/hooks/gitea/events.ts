/**
 * Gitea delivery normalization (gitea-integration.md §8) — the pure half of the
 * ingress: the payload slice the matcher reads, the event-type table, the §12
 * vetoes, the loop-prevention exception, the session key, and the trusted
 * metadata and model-visible envelope a verified delivery produces.
 *
 * Every decision keys on `X-Gitea-Event-Type`, never `X-Gitea-Event`: the latter
 * collapses `pull_request_sync` and `pull_request_review_request` into
 * `pull_request`, and names an inline review comment `pull_request_comment`,
 * which is also the exact type of an ordinary pull-request comment (§7, §16).
 *
 * Nothing here is trusted beyond filter input: authorization is the signature
 * plus the Control Plane's live membership resolution.
 */
import type { GiteaHookMetadata, GiteaHookTarget, HookContext, RcHookAssign } from '@agentconnect.md/protocol'
import { mentionsGithubHandle, mentionsGithubTeam, truncateUtf8, GITHUB_BODY_EXCERPT_MAX } from '../github-ingress.js'

/** The Gitea webhook event types this ingress maps; every other type is silently unmapped. */
export const GITEA_EVENT_ISSUES = 'issues'
export const GITEA_EVENT_ISSUE_COMMENT = 'issue_comment'
export const GITEA_EVENT_PULL_REQUEST = 'pull_request'
export const GITEA_EVENT_PULL_REQUEST_COMMENT = 'pull_request_comment'
export const GITEA_EVENT_PULL_REQUEST_SYNC = 'pull_request_sync'
export const GITEA_EVENT_PULL_REQUEST_REVIEW_REQUEST = 'pull_request_review_request'
export const GITEA_EVENT_PUSH = 'push'

/** The three review event types (§16): one delivery per review submission, verdict in the type. A
 *  Map, not an object: the key is a request header, which must never reach Object.prototype. */
const GITEA_REVIEW_EVENT_ACTIONS = new Map<string, string>([
  ['pull_request_review_comment', 'review:commented'],
  ['pull_request_review_approved', 'review:approved'],
  ['pull_request_review_rejected', 'review:changes_requested']
])

interface GiteaUserRef {
  id?: number
  login?: string
  username?: string
  avatar_url?: string
}

interface GiteaBranchRef {
  ref?: string
  sha?: string
  repo_id?: number
}

interface GiteaIssueRef {
  id?: number
  number?: number
  title?: string
  body?: string | null
  html_url?: string
  user?: GiteaUserRef
  labels?: Array<{ name?: string }>
}

interface GiteaPullRequestRef extends GiteaIssueRef {
  head?: GiteaBranchRef
  base?: GiteaBranchRef
  draft?: boolean
  merged?: boolean
}

/** The slice of a Gitea webhook payload the matcher and envelope read. */
export interface GiteaPayload {
  action?: string
  /** Comment deliveries only: whether the commented subject is a pull request. */
  is_pull?: boolean
  repository?: { id?: number; full_name?: string; owner?: GiteaUserRef }
  sender?: GiteaUserRef
  issue?: GiteaIssueRef
  pull_request?: GiteaPullRequestRef
  comment?: { id?: number; body?: string; html_url?: string }
  /** Review submissions carry the summary and nothing about the inline comments (§16). */
  review?: { type?: string; content?: string | null }
  /** Meaningful ONLY on `pull_request_review_request`; on a review delivery it names the review's author. */
  requested_reviewer?: GiteaUserRef
  // push
  ref?: string
  commits?: Array<{ message?: string | null }>
}

/** One delivery's normalized facts (extracted once; pure filter input). */
export interface GiteaMatchCtx {
  /** Normalized `family:action` (or bare `push`) — the stored-pattern universe. */
  eventAction: string
  family: 'issues' | 'merge_request' | 'push' | 'note' | 'review'
  /** Comment and review deliveries: the subject family the text hangs off. */
  commentSubjectFamily?: 'issues' | 'pull_request'
  actorId?: string
  actorLogin?: string
  subjectAuthorId?: string
  subjectAuthorLogin?: string
  labels: string[]
  mentionText: string | undefined
  /** The owner login a `@<owner>/<agent-name>` team mention may name (§8). */
  teamOwnerLogin?: string
  /** Pull-request facts (loop prevention + the §8 external gate + metadata). */
  sourceRepoId?: string
  targetRepoId?: string
  /** §8 explicit start path: set only on `pull_request_review_request`, where the field means what its name says. */
  requestedReviewerId?: string
  /** Positive issue/pull index — one index space, so the subject kind discriminates. */
  index?: number
  ref?: string
}

/** Gitea's issue and pull-request event patterns share GitLab's product families, so the
 *  comment-family value (`pull_request`) needs mapping onto the event family it subscribes to. */
function eventFamilyOfCommentSubject(subject: 'issues' | 'pull_request'): 'issues' | 'merge_request' {
  return subject === 'issues' ? 'issues' : 'merge_request'
}

function userId(user: GiteaUserRef | undefined): string | undefined {
  return user?.id !== undefined ? String(user.id) : undefined
}

function labelNames(subject: GiteaIssueRef | undefined): string[] {
  return (subject?.labels ?? []).map((label) => label.name ?? '').filter(Boolean)
}

/** The owner login a Gitea team mention names. Gitea's `api.Repository.owner` is an `api.User`
 *  with no organization kind in 1.27 (`modules/structs/user.go`), so nothing in the signed payload
 *  gates the form: it is pure text against the owner login, inert where Gitea renders no team. */
function giteaTeamOwner(repository: GiteaPayload['repository']): string | undefined {
  return repository?.owner?.login || repository?.owner?.username || repository?.full_name?.split('/')[0] || undefined
}

function positiveIndex(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Lifecycle deliveries that close a Gitea thread's daemon-owned workspace (§8):
 *  merged pull requests and closed issues; an unmerged closed pull request may reopen. */
export interface GiteaCleanupDelivery {
  event: string
  kind: 'issue' | 'pull'
  index: number
}

export function giteaThreadWorktreeCleanup(eventType: string, payload: GiteaPayload): GiteaCleanupDelivery | undefined {
  if (payload.action !== 'closed') return undefined
  if (eventType === GITEA_EVENT_ISSUES) {
    const index = positiveIndex(payload.issue?.number)
    return index === undefined ? undefined : { event: 'issues:closed', kind: 'issue', index }
  }
  if (eventType === GITEA_EVENT_PULL_REQUEST && payload.pull_request?.merged === true) {
    const index = positiveIndex(payload.pull_request.number)
    return index === undefined ? undefined : { event: 'merge_request:merged', kind: 'pull', index }
  }
  return undefined
}

function pullRequestCtxBase(payload: GiteaPayload, pull: GiteaPullRequestRef, index: number) {
  return {
    family: 'merge_request' as const,
    ...(userId(payload.sender) !== undefined ? { actorId: userId(payload.sender) } : {}),
    ...(payload.sender?.login ? { actorLogin: payload.sender.login } : {}),
    ...(userId(pull.user) !== undefined ? { subjectAuthorId: userId(pull.user) } : {}),
    ...(pull.user?.login ? { subjectAuthorLogin: pull.user.login } : {}),
    labels: labelNames(pull),
    mentionText: pull.body ?? undefined,
    ...(pull.head?.repo_id !== undefined ? { sourceRepoId: String(pull.head.repo_id) } : {}),
    ...(payload.repository?.id !== undefined ? { targetRepoId: String(payload.repository.id) } : {}),
    index
  }
}

/**
 * Normalize one verified delivery to the stored-pattern event universe, or
 * undefined when the delivery is lifecycle noise (§8 vetoes) or an event type
 * this ingress does not map. Exported for unit tests.
 *
 * Label, assignment, and milestone churn arrive under their own event types
 * (`issue_label`, `issue_assign`, `issue_milestone`, and the pull-request
 * equivalents), which the table below never names — the Gitea form of GitLab's
 * label/assignment veto. Draft toggles and target-branch edits ride
 * `pull_request` `edited`, which is inert here for the same reason.
 */
export function normalizeGiteaEvent(eventType: string, payload: GiteaPayload): GiteaMatchCtx | undefined {
  const ctx = normalizeGiteaSubject(eventType, payload)
  if (!ctx) return undefined
  // The team-mention owner comes from the delivery's OWN repository, never from a rule.
  const teamOwnerLogin = giteaTeamOwner(payload.repository)
  return teamOwnerLogin === undefined ? ctx : { ...ctx, teamOwnerLogin }
}

/** The subject half of the normalization: everything except the team-mention owner. */
function normalizeGiteaSubject(eventType: string, payload: GiteaPayload): GiteaMatchCtx | undefined {
  if (eventType === GITEA_EVENT_PUSH) {
    if (!payload.ref) return undefined
    return {
      eventAction: 'push',
      family: 'push',
      ...(userId(payload.sender) !== undefined ? { actorId: userId(payload.sender) } : {}),
      ...(payload.sender?.login ? { actorLogin: payload.sender.login } : {}),
      labels: [],
      mentionText:
        (payload.commits ?? [])
          .map((commit) => commit.message)
          .filter(Boolean)
          .join('\n') || undefined,
      ref: payload.ref
    }
  }
  if (eventType === GITEA_EVENT_ISSUES) {
    const issue = payload.issue
    const index = positiveIndex(issue?.number)
    if (!issue || index === undefined) return undefined
    // `closed` fires separately as maintenance cleanup; `edited` and `reopened` are lifecycle noise.
    if (payload.action !== 'opened') return undefined
    return {
      eventAction: 'issues:opened',
      family: 'issues',
      ...(userId(payload.sender) !== undefined ? { actorId: userId(payload.sender) } : {}),
      ...(payload.sender?.login ? { actorLogin: payload.sender.login } : {}),
      ...(userId(issue.user) !== undefined ? { subjectAuthorId: userId(issue.user) } : {}),
      ...(issue.user?.login ? { subjectAuthorLogin: issue.user.login } : {}),
      labels: labelNames(issue),
      mentionText: issue.body ?? undefined,
      index
    }
  }
  if (eventType === GITEA_EVENT_PULL_REQUEST || eventType === GITEA_EVENT_PULL_REQUEST_SYNC) {
    const pull = payload.pull_request
    const index = positiveIndex(pull?.number)
    if (!pull || index === undefined) return undefined
    const base = pullRequestCtxBase(payload, pull, index)
    if (eventType === GITEA_EVENT_PULL_REQUEST_SYNC) {
      return payload.action === 'synchronized' ? { ...base, eventAction: 'merge_request:synchronize' } : undefined
    }
    // `closed` with `merged` fires separately as maintenance cleanup; an unmerged close, a
    // reopen, and `edited` (which carries draft toggles and target-branch changes) are noise.
    return payload.action === 'opened' ? { ...base, eventAction: 'merge_request:opened' } : undefined
  }
  if (eventType === GITEA_EVENT_PULL_REQUEST_REVIEW_REQUEST) {
    const pull = payload.pull_request
    const index = positiveIndex(pull?.number)
    if (!pull || index === undefined || payload.action !== 'review_requested') return undefined
    return {
      ...pullRequestCtxBase(payload, pull, index),
      eventAction: 'merge_request:review_requested',
      // The one event type where `requested_reviewer` names a requested reviewer (§8).
      ...(userId(payload.requested_reviewer) !== undefined
        ? { requestedReviewerId: userId(payload.requested_reviewer) }
        : {})
    }
  }
  const reviewAction = GITEA_REVIEW_EVENT_ACTIONS.get(eventType)
  if (reviewAction !== undefined) {
    const pull = payload.pull_request
    const index = positiveIndex(pull?.number)
    if (!pull || index === undefined || payload.action !== 'reviewed') return undefined
    return {
      ...pullRequestCtxBase(payload, pull, index),
      eventAction: reviewAction,
      family: 'review',
      commentSubjectFamily: 'pull_request',
      // The summary body is all a review delivery carries; the daemon lists the reviews and
      // correlates by author, state, and body to read the inline comments (§8).
      mentionText: payload.review?.content ?? undefined
    }
  }
  if (eventType === GITEA_EVENT_ISSUE_COMMENT || eventType === GITEA_EVENT_PULL_REQUEST_COMMENT) {
    // §8 edit veto: a comment EDIT or DELETE re-fires the same type with a fresh delivery id.
    if (payload.action !== 'created') return undefined
    const isPull = eventType === GITEA_EVENT_PULL_REQUEST_COMMENT
    // The event type already names the subject family; a payload disagreeing with it fails closed.
    if (payload.is_pull !== isPull) return undefined
    const subject = isPull ? payload.pull_request : payload.issue
    const index = positiveIndex(payload.issue?.number ?? subject?.number)
    if (!subject || index === undefined) return undefined
    const pull = isPull ? payload.pull_request : undefined
    return {
      eventAction: 'note:created',
      family: 'note',
      commentSubjectFamily: isPull ? 'pull_request' : 'issues',
      ...(userId(payload.sender) !== undefined ? { actorId: userId(payload.sender) } : {}),
      ...(payload.sender?.login ? { actorLogin: payload.sender.login } : {}),
      ...(userId(subject.user) !== undefined ? { subjectAuthorId: userId(subject.user) } : {}),
      ...(subject.user?.login ? { subjectAuthorLogin: subject.user.login } : {}),
      labels: labelNames(subject),
      mentionText: payload.comment?.body ?? undefined,
      ...(pull?.head?.repo_id !== undefined ? { sourceRepoId: String(pull.head.repo_id) } : {}),
      ...(payload.repository?.id !== undefined ? { targetRepoId: String(payload.repository.id) } : {}),
      index
    }
  }
  return undefined
}

/** The targeted agent handle in either accepted form: the bare name, or the `@<owner>/<agent-name>`
 *  team an organization creates so the same handle autocompletes in Gitea's comment composer. */
function giteaMentionsAgent(body: string | undefined, rule: RcHookAssign, owner: string | undefined): boolean {
  return mentionsGithubHandle(body, rule.gitea?.agentName) || mentionsGithubTeam(body, owner, rule.gitea?.agentName)
}

export function giteaRuleIsSummoned(rule: RcHookAssign, ctx: GiteaMatchCtx): boolean {
  return (
    mentionsGithubHandle(ctx.mentionText, rule.gitea?.botUsername) ||
    giteaMentionsAgent(ctx.mentionText, rule, ctx.teamOwnerLogin)
  )
}

/** Explicit agent handles narrow a repository fan-out; the connection's bot handle is the broadcast form. */
export function giteaMentionCandidates(
  rules: RcHookAssign[],
  body: string | undefined,
  owner?: string
): RcHookAssign[] {
  if (rules.some((rule) => mentionsGithubHandle(body, rule.gitea?.botUsername))) return rules
  const targeted = new Set(rules.filter((rule) => giteaMentionsAgent(body, rule, owner)).map((rule) => rule.agentId))
  return targeted.size === 0 ? rules : rules.filter((rule) => targeted.has(rule.agentId))
}

export type GiteaRuleVerdict = 'no-match' | 'trusted' | 'needs-authz'

/** §8 internal lane: only a same-repository pull-request revision the bot itself authored enters review. */
function isInternalBotRevision(rule: RcHookAssign, ctx: GiteaMatchCtx): boolean {
  return (
    (ctx.eventAction === 'merge_request:opened' || ctx.eventAction === 'merge_request:synchronize') &&
    ctx.subjectAuthorId !== undefined &&
    ctx.subjectAuthorId === rule.gitea?.botUserId &&
    ctx.sourceRepoId !== undefined &&
    ctx.sourceRepoId === ctx.targetRepoId
  )
}

/**
 * One rule's verdict for one verified delivery (pure; exported for unit tests).
 * Order: loop-prevention veto → reviewer-request path → cadence/additive summon
 * match → comment scope → mention-only gate → live-authz classification.
 */
export function giteaRuleVerdict(rule: RcHookAssign, ctx: GiteaMatchCtx): GiteaRuleVerdict {
  const gitea = rule.gitea
  if (rule.kind !== 'gitea' || !gitea) return 'no-match'
  // §8 loop prevention: the connection's single bot user never re-triggers, except its own
  // same-repository pull-request revisions. A comment it authors is always rejected.
  const botAuthored = ctx.actorId !== undefined && ctx.actorId === gitea.botUserId
  const internalRevision = botAuthored && isInternalBotRevision(rule, ctx)
  if (botAuthored && !internalRevision) return 'no-match'
  // §8 explicit start path: requesting the bot as reviewer bypasses cadence and mention filters,
  // but only for THIS rule's bot and only after the live membership gate authorizes the requester.
  if (ctx.eventAction === 'merge_request:review_requested') {
    const supportsPulls =
      gitea.events.some((event) => event.startsWith('merge_request:')) ||
      (gitea.commentFamilies ?? []).includes('pull_request')
    return ctx.requestedReviewerId === gitea.botUserId && supportsPulls ? 'needs-authz' : 'no-match'
  }
  const action = ctx.eventAction.includes(':') ? ctx.eventAction.slice(ctx.eventAction.indexOf(':')) : ''
  const matchesPattern = (family: string): boolean =>
    (action !== '' && gitea.events.includes(`${family}${action}`)) || gitea.events.includes(`${family}:*`)
  const summoned = giteaRuleIsSummoned(rule, ctx)
  let eventMatched: boolean
  if (ctx.family === 'note' || ctx.family === 'review') {
    // Comments and review submissions are both scoped by the console-selected comment families;
    // a summon in a created-cadence thread family fires additively (§8).
    const families = gitea.commentFamilies ?? []
    const familySelected = ctx.commentSubjectFamily !== undefined && families.includes(ctx.commentSubjectFamily)
    const createdCadenceSummon =
      summoned &&
      ctx.commentSubjectFamily !== undefined &&
      gitea.events.includes(`${eventFamilyOfCommentSubject(ctx.commentSubjectFamily)}:opened`)
    eventMatched = familySelected || createdCadenceSummon
  } else {
    const createdCadenceSummon =
      summoned &&
      (ctx.family === 'issues' || ctx.family === 'merge_request') &&
      gitea.events.includes(`${ctx.family}:opened`)
    eventMatched = matchesPattern(ctx.family) || createdCadenceSummon
  }
  if (!eventMatched) return 'no-match'
  if (gitea.mentionOnly && !summoned) return 'no-match'
  // §8: pushes and the bot's own same-repository revisions stay relay-trusted; every issue and
  // pull-request lifecycle event, comment, and review submission resolves live membership.
  if (ctx.family === 'push') return 'trusted'
  if (internalRevision) return 'trusted'
  return 'needs-authz'
}

/** The §8 rename-stable session key: exact subject discriminator, positive index
 *  (or the payload's canonical ref) — never a display path or delivery id. */
export function giteaSessionKey(rule: RcHookAssign, target: GiteaHookTarget): string {
  const prefix = rule.gitea!.sessionKeyPrefix
  return target.kind === 'push' ? `${prefix}:push:${target.ref}` : `${prefix}:${target.kind}:${target.index}`
}

/** The signed-payload subject → the trusted `RdMsgHook.gitea` discriminator.
 *  Undefined identity is rejected before any dispatch — never substituted. */
export function buildTrustedGiteaMetadata(
  payload: GiteaPayload,
  ctx: GiteaMatchCtx,
  rule: RcHookAssign
): GiteaHookMetadata | undefined {
  const gitea = rule.gitea
  if (!gitea) return undefined
  const repoId = payload.repository?.id
  if (repoId === undefined || String(repoId) !== gitea.repoId) return undefined
  let target: GiteaHookTarget
  if (ctx.family === 'push') {
    if (!ctx.ref) return undefined
    target = { kind: 'push', ref: ctx.ref }
  } else if (ctx.family === 'issues' || ctx.commentSubjectFamily === 'issues') {
    if (ctx.index === undefined || ctx.index <= 0) return undefined
    target = { kind: 'issue', index: ctx.index }
  } else {
    if (ctx.index === undefined || ctx.index <= 0) return undefined
    const pull = payload.pull_request
    target = {
      kind: 'pull',
      index: ctx.index,
      ...(ctx.sourceRepoId !== undefined ? { sourceRepoId: ctx.sourceRepoId } : {}),
      // Both sides of the head fence are on every pull-request payload (§8).
      ...(pull?.head?.sha ? { headSha: pull.head.sha } : {}),
      ...(pull?.base?.sha ? { baseSha: pull.base.sha } : {}),
      ...(pull?.draft !== undefined ? { isDraft: pull.draft } : {}),
      ...(ctx.eventAction === 'merge_request:review_requested' ? { explicitReviewRequest: true } : {})
    }
  }
  const commentId = ctx.family === 'note' ? positiveIndex(payload.comment?.id) : undefined
  return {
    repoId: gitea.repoId,
    // §3: opaque pass-through. The relay never dials Gitea and never parses this — the daemon
    // fences the turn on it against the session's spec-carried host.
    ...(gitea.host !== undefined ? { host: gitea.host } : {}),
    repoPath: payload.repository?.full_name ?? gitea.repoPath,
    target,
    // The comment that fired this delivery — the acknowledgement reaction's exact target. A review
    // submission carries no comment id at all (§16), so it never gets one.
    ...(commentId !== undefined ? { commentId: String(commentId) } : {})
  }
}

/** The trimmed model-visible envelope shared by the delivery's fan-out. */
export function buildGiteaContext(payload: GiteaPayload, ctx: GiteaMatchCtx): HookContext {
  const subject = payload.pull_request ?? payload.issue
  const bodySource = payload.comment?.body ?? ctx.mentionText ?? ''
  const excerpt = truncateUtf8(bodySource, GITHUB_BODY_EXCERPT_MAX)
  const flatTitle = subject?.title ? subject.title.replace(/\s+/g, ' ').trim() : undefined
  const htmlUrl = payload.comment?.html_url ?? subject?.html_url
  return {
    source: 'gitea',
    event: ctx.family,
    ...(ctx.eventAction.includes(':') ? { action: ctx.eventAction.slice(ctx.eventAction.indexOf(':') + 1) } : {}),
    ...(payload.repository?.full_name ? { repo: payload.repository.full_name } : {}),
    ...(ctx.index !== undefined ? { number: ctx.index } : {}),
    ...(flatTitle ? { title: flatTitle.length > 200 ? `${flatTitle.slice(0, 199)}…` : flatTitle } : {}),
    ...(ctx.actorLogin ? { senderLogin: ctx.actorLogin } : {}),
    ...(payload.sender?.avatar_url ? { senderAvatarUrl: payload.sender.avatar_url } : {}),
    ...(ctx.labels.length > 0 ? { labels: ctx.labels } : {}),
    ...(htmlUrl ? { htmlUrl } : {}),
    ...(excerpt.text ? { bodyExcerpt: excerpt.text } : {}),
    truncated: excerpt.truncated
  }
}
