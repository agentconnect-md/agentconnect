/** Gitea delivery normalization (gitea-integration.md §8), the pure half of the ingress; keyed on `X-Gitea-Event-Type` only, and untrusted beyond filter input. */
import {
  HOOK_DECISION_ROUTING_V1_FEATURE,
  HOOK_DECISION_ROUTING_V2_FEATURE,
  type CodeHostRoutingFamily,
  type GiteaHookMetadata,
  type GiteaHookTarget,
  type HookContext,
  type RcHookAssign,
  type RcHookRouting
} from '@agentconnect.md/protocol'
import { mentionsGithubHandle, mentionsGithubTeam, truncateUtf8, GITHUB_BODY_EXCERPT_MAX } from '../github-ingress.js'
import { labelFilterAdmits } from '../label-filter.js'
import type { CodeHostRoutingProvider } from '../code-host-routing.js'

/** The Gitea webhook event types this ingress maps; every other type is silently unmapped. */
export const GITEA_EVENT_ISSUES = 'issues'
export const GITEA_EVENT_ISSUE_LABEL = 'issue_label'
export const GITEA_EVENT_ISSUE_COMMENT = 'issue_comment'
export const GITEA_EVENT_PULL_REQUEST = 'pull_request'
export const GITEA_EVENT_PULL_REQUEST_LABEL = 'pull_request_label'
export const GITEA_EVENT_PULL_REQUEST_COMMENT = 'pull_request_comment'
export const GITEA_EVENT_PULL_REQUEST_SYNC = 'pull_request_sync'
export const GITEA_EVENT_PULL_REQUEST_REVIEW_REQUEST = 'pull_request_review_request'
export const GITEA_EVENT_PUSH = 'push'
export const GITEA_EVENT_RELEASE = 'release'

/** Review event types (§16), verdict in the type; a Map so a header key never reaches Object.prototype. */
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
  state?: string
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
  // release
  release?: {
    tag_name?: string
    target_commitish?: string
    name?: string | null
    body?: string | null
    html_url?: string
    draft?: boolean
    prerelease?: boolean
  }
}

/** One delivery's normalized facts (extracted once; pure filter input). */
export interface GiteaMatchCtx {
  /** Normalized `family:action` (or bare `push`) — the stored-pattern universe. */
  eventAction: string
  family: 'issues' | 'merge_request' | 'push' | 'note' | 'review' | 'release'
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
  /** A release's tag — its identity on the header; every release shares one session. */
  tag?: string
}

/** Map the comment-subject value (`pull_request`) onto the event family it subscribes to (`merge_request`). */
function eventFamilyOfCommentSubject(subject: 'issues' | 'pull_request'): 'issues' | 'merge_request' {
  return subject === 'issues' ? 'issues' : 'merge_request'
}

function userId(user: GiteaUserRef | undefined): string | undefined {
  return user?.id !== undefined ? String(user.id) : undefined
}

function labelNames(subject: GiteaIssueRef | undefined): string[] {
  return (subject?.labels ?? []).map((label) => label.name ?? '').filter(Boolean)
}

/** The owner login a team mention names; the payload has no organization kind, so it is pure text on any repository. */
function giteaTeamOwner(repository: GiteaPayload['repository']): string | undefined {
  return repository?.owner?.login || repository?.owner?.username || repository?.full_name?.split('/')[0] || undefined
}

function positiveIndex(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Deliveries that close a thread's workspace (§8): merged pulls and closed issues; an unmerged close may reopen. */
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

/** Normalize to the stored-pattern universe, or undefined for noise (§8) or unmapped types; assign/milestone types are never named. */
export function normalizeGiteaEvent(eventType: string, payload: GiteaPayload): GiteaMatchCtx | undefined {
  const ctx = normalizeGiteaSubject(eventType, payload)
  if (!ctx) return undefined
  // The team-mention owner comes from the delivery's OWN repository, never from a rule.
  const teamOwnerLogin = giteaTeamOwner(payload.repository)
  return teamOwnerLogin === undefined ? ctx : { ...ctx, teamOwnerLogin }
}

/** `opened` on the issues type; `label_updated` on the label type (a cleared label set can match no filter). */
function issueEventAction(eventType: string, action: string | undefined): string | undefined {
  if (eventType === GITEA_EVENT_ISSUE_LABEL) return action === 'label_updated' ? 'issues:labeled' : undefined
  return action === 'opened' ? 'issues:opened' : undefined
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
  if (eventType === GITEA_EVENT_RELEASE) {
    // `published` is the publish, `updated` an edit; a deletion is never new work.
    const release = payload.release
    const eventAction =
      payload.action === 'published' ? 'release:published' : payload.action === 'updated' ? 'release:edited' : undefined
    if (!release?.tag_name || eventAction === undefined) return undefined
    return {
      eventAction,
      family: 'release',
      ...(userId(payload.sender) !== undefined ? { actorId: userId(payload.sender) } : {}),
      ...(payload.sender?.login ? { actorLogin: payload.sender.login } : {}),
      labels: [],
      mentionText: release.body ?? undefined,
      tag: release.tag_name
    }
  }
  if (eventType === GITEA_EVENT_ISSUES || eventType === GITEA_EVENT_ISSUE_LABEL) {
    const issue = payload.issue
    const index = positiveIndex(issue?.number)
    if (!issue || index === undefined) return undefined
    // `closed` fires separately as maintenance cleanup; `edited` and `reopened` are lifecycle noise.
    const eventAction = issueEventAction(eventType, payload.action)
    if (eventAction === undefined) return undefined
    return {
      eventAction,
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
  if (
    eventType === GITEA_EVENT_PULL_REQUEST ||
    eventType === GITEA_EVENT_PULL_REQUEST_SYNC ||
    eventType === GITEA_EVENT_PULL_REQUEST_LABEL
  ) {
    const pull = payload.pull_request
    const index = positiveIndex(pull?.number)
    if (!pull || index === undefined) return undefined
    const base = pullRequestCtxBase(payload, pull, index)
    if (eventType === GITEA_EVENT_PULL_REQUEST_SYNC) {
      return payload.action === 'synchronized' ? { ...base, eventAction: 'merge_request:synchronize' } : undefined
    }
    if (eventType === GITEA_EVENT_PULL_REQUEST_LABEL) {
      return payload.action === 'label_updated' ? { ...base, eventAction: 'merge_request:labeled' } : undefined
    }
    // A merged close fires as cleanup; an unmerged close, reopen and `edited` (draft, target branch) are noise.
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
      // A review carries only its summary; the daemon lists reviews to read the inline comments (§8).
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

/** The agent handle as `@name` or the `@<owner>/<name>` team; team membership only shapes composer suggestions. */
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

/** One rule's pure verdict: loop veto → reviewer request → cadence/summon → comment scope → mention-only → labels → authz. */
export function giteaRuleVerdict(rule: RcHookAssign, ctx: GiteaMatchCtx): GiteaRuleVerdict {
  const gitea = rule.gitea
  if (rule.kind !== 'gitea' || !gitea) return 'no-match'
  // §8 loop prevention: the bot never re-triggers, except its own same-repository pull revision.
  const botAuthored = ctx.actorId !== undefined && ctx.actorId === gitea.botUserId
  const internalRevision = botAuthored && isInternalBotRevision(rule, ctx)
  if (botAuthored && !internalRevision) return 'no-match'
  // §8 start path: requesting this rule's bot as reviewer bypasses cadence and mention filters, still behind live authz.
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
    // Comments and reviews are scoped by the selected comment families; a created-cadence summon fires additively (§8).
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
  // Label churn stays vetoed (§8) unless the row filters on labels — then a label change is how a thread enters the filter.
  if (action === ':labeled' && !gitea.labelFilter?.length) return 'no-match'
  if (gitea.mentionOnly && !summoned) return 'no-match'
  if (!labelFilterAdmits(gitea.labelFilter, ctx.labels)) return 'no-match'
  // §8: pushes, releases (publishing takes write access) and the bot's own same-repository revisions are relay-trusted; everything else resolves live membership.
  if (ctx.family === 'push' || ctx.family === 'release') return 'trusted'
  if (internalRevision) return 'trusted'
  return 'needs-authz'
}

/** The §8 rename-stable session key: subject kind plus positive index, the canonical ref for a push, or the repository's one releases session. */
export function giteaSessionKey(rule: RcHookAssign, target: GiteaHookTarget): string {
  const prefix = rule.gitea!.sessionKeyPrefix
  if (target.kind === 'release') return `${prefix}:releases`
  return target.kind === 'push' ? `${prefix}:push:${target.ref}` : `${prefix}:${target.kind}:${target.index}`
}

/** The signed subject → trusted `RdMsgHook.gitea`; incomplete identity is rejected, never substituted. */
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
  } else if (ctx.family === 'release') {
    if (!ctx.tag) return undefined
    target = { kind: 'release', tag: ctx.tag }
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
    // §3: opaque pass-through the daemon fences the turn on; the relay never parses it.
    ...(gitea.host !== undefined ? { host: gitea.host } : {}),
    repoPath: payload.repository?.full_name ?? gitea.repoPath,
    target,
    // The comment that fired this delivery, the reaction target; a review has no comment id (§16).
    ...(commentId !== undefined ? { commentId: String(commentId) } : {})
  }
}

/** One capped line for the daemon's trusted header. */
function flattenLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

/** The trimmed model-visible envelope shared by the delivery's fan-out. */
export function buildGiteaContext(payload: GiteaPayload, ctx: GiteaMatchCtx): HookContext {
  const subject = payload.pull_request ?? payload.issue
  const release = ctx.family === 'release' ? payload.release : undefined
  const bodySource = payload.comment?.body ?? ctx.mentionText ?? ''
  const excerpt = truncateUtf8(bodySource, GITHUB_BODY_EXCERPT_MAX)
  const title = subject?.title ?? (release ? release.name || release.tag_name : undefined)
  const flatTitle = title ? title.replace(/\s+/g, ' ').trim() : undefined
  const htmlUrl = payload.comment?.html_url ?? subject?.html_url ?? release?.html_url
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
    ...(giteaSubject(subject, ctx) ?? {}),
    // The flags let the agent tell a prerelease or draft apart, as on GitHub.
    ...(release?.tag_name
      ? {
          release: {
            tag: flattenLine(release.tag_name),
            ...(release.target_commitish ? { target: flattenLine(release.target_commitish) } : {}),
            ...(typeof release.prerelease === 'boolean' ? { prerelease: release.prerelease } : {}),
            ...(typeof release.draft === 'boolean' ? { draft: release.draft } : {})
          }
        }
      : {}),
    truncated: excerpt.truncated
  }
}

/** The issue or pull request itself, for a Decision to judge a comment or review against (code-host-decisions.md §4). */
function giteaSubject(
  subject: GiteaPullRequestRef | undefined,
  ctx: GiteaMatchCtx
): Pick<HookContext, 'subject'> | undefined {
  if (!subject || ctx.family === 'push') return undefined
  const body = subject.body ? truncateUtf8(subject.body, GITHUB_BODY_EXCERPT_MAX).text : ''
  return {
    subject: {
      ...(subject.user?.login ? { authorLogin: subject.user.login } : {}),
      ...(subject.state ? { state: subject.state } : {}),
      ...(typeof subject.draft === 'boolean' ? { draft: subject.draft } : {}),
      ...(body ? { body } : {})
    }
  }
}

/** One Gitea event as the routing step reads it: the normalized facts and the signed repository id. */
export interface GiteaRouteEvent {
  ctx: GiteaMatchCtx
  repoId: string
}

type GiteaThreadFamily = Extract<CodeHostRoutingFamily, 'issues' | 'merge_request'>

/** Routing scopes use the event-family names the hook rows store; a comment or review takes its subject's. */
function giteaEventFamily({ ctx }: GiteaRouteEvent): GiteaThreadFamily | undefined {
  if (ctx.family === 'issues' || ctx.family === 'merge_request') return ctx.family
  if (ctx.family === 'note' || ctx.family === 'review') {
    return ctx.commentSubjectFamily === undefined ? undefined : eventFamilyOfCommentSubject(ctx.commentSubjectFamily)
  }
  return undefined
}

/** The thread families a Gitea rule's event patterns and comment scope cover. */
export function giteaRuleFamilies(rule: RcHookAssign): ReadonlySet<GiteaThreadFamily> {
  const families = new Set<GiteaThreadFamily>()
  if (rule.kind !== 'gitea' || !rule.gitea) return families
  for (const pattern of rule.gitea.events) {
    const prefix = pattern.split(':', 1)[0]
    if (prefix === 'issues' || prefix === 'merge_request') families.add(prefix)
  }
  for (const family of rule.gitea.commentFamilies ?? []) families.add(eventFamilyOfCommentSubject(family))
  return families
}

function giteaRoutingHostRule(
  scopeRules: readonly RcHookAssign[],
  routing: RcHookRouting,
  event: GiteaRouteEvent
): RcHookAssign | undefined {
  return scopeRules.find(
    (rule) =>
      rule.routing?.routingId === routing.routingId &&
      rule.agentId === routing.evaluationAgentId &&
      rule.kind === 'gitea' &&
      rule.gitea?.repoId === event.repoId
  )
}

/** The normalizer already dropped noise and edits; what is left is a numbered thread event of one repository. */
function giteaRecordOnlyFence(hostRule: RcHookAssign, { ctx, repoId }: GiteaRouteEvent): boolean {
  if (hostRule.kind !== 'gitea' || hostRule.gitea?.repoId !== repoId) return false
  if (ctx.index === undefined || ctx.index <= 0) return false
  return !ctx.eventAction.endsWith(':deleted')
}

/** Gitea's callbacks for the shared routing step; its routed copies need a v2 host. */
export const GITEA_ROUTING: CodeHostRoutingProvider<GiteaRouteEvent> = {
  provider: 'gitea',
  hostFeatures: [HOOK_DECISION_ROUTING_V1_FEATURE, HOOK_DECISION_ROUTING_V2_FEATURE],
  eventFamily: giteaEventFamily,
  ruleFamilies: giteaRuleFamilies,
  hostRule: giteaRoutingHostRule,
  recordOnlyEligible: giteaRecordOnlyFence
}
