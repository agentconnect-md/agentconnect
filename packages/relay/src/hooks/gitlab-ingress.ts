/** GitLab ingress (`POST /webhooks/gitlab`, gitlab-com-integration.md §11.2, §12): per-rule Standard Webhooks verification before any matching, uniform 404, 202 when unmatched; the payload is never logged. */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  HOOK_DECISION_ROUTING_V1_FEATURE,
  HOOK_DECISION_ROUTING_V2_FEATURE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  type GitlabHookMetadata,
  type GitlabHookTarget,
  type HookContext,
  type CodeHostRoutingFamily,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcHookRouting,
  type RcRunReport,
  type RdHookNotice,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../relay-daemon-server.js'
import type { HookTable } from './hook-table.js'
import type { HookRateLimiter } from './rate-limit.js'
import { dispatchHookFire, noticeDelivery } from './ingress.js'
import { hookSnapshotForDelivery } from './hook-snapshot.js'
import { mentionsGithubHandle, truncateUtf8, GITHUB_BODY_EXCERPT_MAX } from './github-ingress.js'
import { labelFilterAdmits } from './label-filter.js'
import { createCodeHostRouter, type CodeHostRoutingProvider } from './code-host-routing.js'
import { verifyStandardWebhook } from './standard-webhooks.js'
import type { Logger } from '../log.js'

/** Raw-body cap (§11.2: 1 MiB). */
export const GITLAB_BODY_LIMIT = 1024 * 1024

export interface GitlabIngressDeps {
  table: HookTable
  /** Late-bound: the rd/* server exists only after `listen()` (routes register before). */
  daemons: () => Pick<RelayDaemonServer, 'get'> | undefined
  /** Emit one delivery-stage `rc/run-report` EVT to the CP (fire-and-forget). */
  report: (report: RcRunReport) => void
  /** §12.2 live effective-membership gate — metadata only, resolved by the CP. */
  authorizeMembership: (request: RcCodeHostMembershipAuthz) => Promise<boolean>
  /** Dedicated upstream-call budget, shared by every hook on one project. */
  authzLimiter: HookRateLimiter
  limiter: HookRateLimiter
  clock: Clock
  log: Logger
}

/** The payload slice the matcher reads: untrusted filter input; authorization is the signature plus the CP's live membership check (§12.2). */
interface GitlabPayload {
  object_kind?: string
  event_type?: string
  user?: { id?: number; username?: string; name?: string; avatar_url?: string }
  project?: { id?: number; path_with_namespace?: string; web_url?: string }
  project_id?: number
  object_attributes?: {
    id?: number
    iid?: number
    title?: string
    description?: string | null
    note?: string
    noteable_type?: string
    system?: boolean
    position?: unknown
    action?: string
    state?: string
    oldrev?: string
    url?: string
    author_id?: number
    source_project_id?: number
    target_project_id?: number
    last_commit?: { id?: string }
    draft?: boolean
    work_in_progress?: boolean
    labels?: Array<{ title?: string }>
  }
  labels?: Array<{ title?: string }>
  changes?: {
    labels?: { previous?: unknown[]; current?: unknown[] }
    reviewers?: {
      previous?: Array<{ id?: number }>
      current?: Array<{ id?: number; re_requested?: boolean }>
    }
    draft?: { previous?: boolean; current?: boolean }
    work_in_progress?: { previous?: boolean; current?: boolean }
  }
  issue?: {
    iid?: number
    title?: string
    description?: string | null
    state?: string
    labels?: Array<{ title?: string }>
    author_id?: number
  }
  merge_request?: {
    iid?: number
    title?: string
    description?: string | null
    state?: string
    labels?: Array<{ title?: string }>
    author_id?: number
    source_project_id?: number
    target_project_id?: number
    last_commit?: { id?: string }
    draft?: boolean
    work_in_progress?: boolean
  }
  // Push Hook
  ref?: string
  checkout_sha?: string | null
  user_id?: number
  user_username?: string
  commits?: Array<{ message?: string | null }>
}

/** One delivery's normalized facts (extracted once; pure filter input). */
export interface GitlabMatchCtx {
  /** Normalized `family:action` (or bare `push`) — the stored-pattern universe. */
  eventAction: string
  family: 'issues' | 'merge_request' | 'push' | 'note'
  /** Comment deliveries: the subject family the note hangs off. */
  commentSubjectFamily?: 'issues' | 'merge_request'
  actorId?: string
  subjectAuthorId?: string
  labels: string[]
  mentionText: string | undefined
  /** MR facts (loop prevention + §12.2 external gate + metadata). */
  sourceProjectId?: string
  targetProjectId?: string
  /** §12.2 explicit start path: the SA was just assigned as reviewer. */
  serviceAccountReviewerRequested?: (serviceAccountUserId: string) => boolean
  /** True when GitLab marked the note as system-generated. */
  systemNote?: boolean
  hasDiffPosition?: boolean
  iid?: number
  ref?: string
}

/** Deliveries that close a thread's workspace (§12): merged MRs and closed issues; an unmerged closed MR may reopen. */
function gitlabThreadWorktreeCleanupEvent(payload: GitlabPayload): string | undefined {
  const attrs = payload.object_attributes
  if (!attrs) return undefined
  if (payload.object_kind === 'issue' && attrs.action === 'close') return 'issues:closed'
  if (payload.object_kind === 'merge_request' && attrs.action === 'merge') return 'merge_request:merged'
  return undefined
}

/** Normalize a verified payload to the stored-pattern universe, or undefined for lifecycle noise (§12 vetoes). */
export function normalizeGitlabEvent(payload: GitlabPayload): GitlabMatchCtx | undefined {
  const attrs = payload.object_attributes
  const kind = payload.object_kind
  if (kind === 'push') {
    if (!payload.ref) return undefined
    return {
      eventAction: 'push',
      family: 'push',
      ...(payload.user_id !== undefined ? { actorId: String(payload.user_id) } : {}),
      labels: [],
      mentionText:
        (payload.commits ?? [])
          .map((commit) => commit.message)
          .filter(Boolean)
          .join('\n') || undefined,
      ref: payload.ref
    }
  }
  if (kind === 'issue') {
    if (!attrs || attrs.iid === undefined) return undefined
    const labels = (payload.labels ?? attrs.labels ?? []).map((label) => label.title ?? '').filter(Boolean)
    const base = {
      family: 'issues' as const,
      ...(payload.user?.id !== undefined ? { actorId: String(payload.user.id) } : {}),
      ...(attrs.author_id !== undefined ? { subjectAuthorId: String(attrs.author_id) } : {}),
      labels,
      mentionText: attrs.description ?? undefined,
      iid: attrs.iid
    }
    if (attrs.action === 'open') return { ...base, eventAction: 'issues:opened' }
    // Label changes are the one substantive `update`; edit/close/reopen are noise (close fires as cleanup).
    if (attrs.action === 'update' && payload.changes?.labels) return { ...base, eventAction: 'issues:labeled' }
    return undefined
  }
  if (kind === 'merge_request') {
    if (!attrs || attrs.iid === undefined) return undefined
    const labels = (payload.labels ?? attrs.labels ?? []).map((label) => label.title ?? '').filter(Boolean)
    const base = {
      family: 'merge_request' as const,
      ...(payload.user?.id !== undefined ? { actorId: String(payload.user.id) } : {}),
      ...(attrs.author_id !== undefined ? { subjectAuthorId: String(attrs.author_id) } : {}),
      labels,
      mentionText: attrs.description ?? undefined,
      ...(attrs.source_project_id !== undefined ? { sourceProjectId: String(attrs.source_project_id) } : {}),
      ...(attrs.target_project_id !== undefined ? { targetProjectId: String(attrs.target_project_id) } : {}),
      iid: attrs.iid
    }
    if (attrs.action === 'open') return { ...base, eventAction: 'merge_request:opened' }
    if (attrs.action === 'update') {
      // Draft/ready toggles are lifecycle noise even when they ride an update.
      if (payload.changes?.draft || payload.changes?.work_in_progress) return undefined
      // New source commits normalize to the existing revision event.
      if (attrs.oldrev) return { ...base, eventAction: 'merge_request:synchronize' }
      if (payload.changes?.labels) return { ...base, eventAction: 'merge_request:labeled' }
      const currentReviewers = payload.changes?.reviewers?.current
      if (currentReviewers) {
        const previous = new Set((payload.changes?.reviewers?.previous ?? []).map((reviewer) => reviewer.id))
        return {
          ...base,
          eventAction: 'merge_request:review_requested',
          // A request is a newly added reviewer or a native re-request (`re_requested: true`); plain review state changes stay inert.
          serviceAccountReviewerRequested: (serviceAccountUserId) =>
            currentReviewers.some(
              (reviewer) =>
                reviewer.id !== undefined &&
                String(reviewer.id) === serviceAccountUserId &&
                (!previous.has(reviewer.id) || reviewer.re_requested === true)
            )
        }
      }
      return undefined
    }
    // Unmerged close, reopen, approve/unapprove and merge are not new turns (merge fires as cleanup).
    return undefined
  }
  if (kind === 'note') {
    if (!attrs || attrs.system === true) return undefined
    // §12 edit veto: a note edit (`update`) is never a new turn; an absent action (legacy) means creation.
    if (attrs.action !== undefined && attrs.action !== 'create') return undefined
    const subject = payload.issue ?? payload.merge_request
    const family = payload.issue ? ('issues' as const) : payload.merge_request ? ('merge_request' as const) : undefined
    if (!subject || subject.iid === undefined || !family) return undefined
    return {
      eventAction: 'note:created',
      family: 'note',
      commentSubjectFamily: family,
      ...(payload.user?.id !== undefined ? { actorId: String(payload.user.id) } : {}),
      ...(subject.author_id !== undefined ? { subjectAuthorId: String(subject.author_id) } : {}),
      labels: (subject.labels ?? []).map((label) => label.title ?? '').filter(Boolean),
      mentionText: attrs.note ?? undefined,
      ...(payload.merge_request?.source_project_id !== undefined
        ? { sourceProjectId: String(payload.merge_request.source_project_id) }
        : {}),
      ...(payload.merge_request?.target_project_id !== undefined
        ? { targetProjectId: String(payload.merge_request.target_project_id) }
        : {}),
      systemNote: false,
      hasDiffPosition: attrs.position != null,
      iid: subject.iid
    }
  }
  return undefined
}

function gitlabRuleIsSummoned(rule: RcHookAssign, ctx: GitlabMatchCtx): boolean {
  return (
    mentionsGithubHandle(ctx.mentionText, rule.gitlab?.serviceAccountUsername) ||
    mentionsGithubHandle(ctx.mentionText, rule.gitlab?.agentName)
  )
}

/** Explicit agent handles narrow a project fan-out; the service-account handle is the broadcast form. */
export function gitlabMentionCandidates(rules: RcHookAssign[], body: string | undefined): RcHookAssign[] {
  if (rules.some((rule) => mentionsGithubHandle(body, rule.gitlab?.serviceAccountUsername))) return rules
  const targeted = new Set(
    rules.filter((rule) => mentionsGithubHandle(body, rule.gitlab?.agentName)).map((rule) => rule.agentId)
  )
  return targeted.size === 0 ? rules : rules.filter((rule) => targeted.has(rule.agentId))
}

export type GitlabRuleVerdict = 'no-match' | 'trusted' | 'needs-authz'

/** §12.1 veto set: every account bound to the project; an older rule names only one. */
function gitlabVetoedAuthor(rule: RcHookAssign, actorId: string | undefined): boolean {
  const gitlab = rule.gitlab
  if (!gitlab || actorId === undefined) return false
  return actorId === gitlab.serviceAccountUserId || (gitlab.boundServiceAccountUserIds ?? []).includes(actorId)
}

/** §12.1 internal lane: only a same-project MR revision by the account THIS rule names enters review. */
function isInternalServiceAccountRevision(rule: RcHookAssign, ctx: GitlabMatchCtx): boolean {
  return (
    (ctx.eventAction === 'merge_request:opened' || ctx.eventAction === 'merge_request:synchronize') &&
    ctx.subjectAuthorId !== undefined &&
    ctx.subjectAuthorId === rule.gitlab?.serviceAccountUserId &&
    ctx.sourceProjectId !== undefined &&
    ctx.sourceProjectId === ctx.targetProjectId
  )
}

/** One rule's pure verdict: loop veto → reviewer request → cadence/summon → comment scope → mention-only → labels → authz. */
export function gitlabRuleVerdict(rule: RcHookAssign, ctx: GitlabMatchCtx): GitlabRuleVerdict {
  if (rule.kind !== 'gitlab' || !rule.gitlab) return 'no-match'
  // §12.1: bound accounts never re-trigger, except this rule's own same-project MR revision; their notes never do.
  const actorIsBoundAccount = gitlabVetoedAuthor(rule, ctx.actorId)
  const internalRevision =
    ctx.actorId === rule.gitlab.serviceAccountUserId && isInternalServiceAccountRevision(rule, ctx)
  if (actorIsBoundAccount && !internalRevision) return 'no-match'
  if (ctx.family === 'note' && actorIsBoundAccount) return 'no-match'
  // §12.2 start path: assigning this rule's SA as reviewer bypasses cadence, label and mention filters, still behind live authz.
  if (ctx.eventAction === 'merge_request:review_requested') {
    const supportsMr =
      rule.gitlab.events.some((event) => event.startsWith('merge_request:')) ||
      (rule.gitlab.commentFamilies ?? []).includes('merge_request')
    return ctx.serviceAccountReviewerRequested?.(rule.gitlab.serviceAccountUserId) && supportsMr
      ? 'needs-authz'
      : 'no-match'
  }
  const action = ctx.eventAction.includes(':') ? ctx.eventAction.slice(ctx.eventAction.indexOf(':')) : ''
  const matchesPattern = (family: string): boolean =>
    (action !== '' && rule.gitlab!.events.includes(`${family}${action}`)) || rule.gitlab!.events.includes(`${family}:*`)
  const summoned = gitlabRuleIsSummoned(rule, ctx)
  let eventMatched: boolean
  if (ctx.family === 'note') {
    // Notes are scoped by the selected comment families; a summon in a created-cadence family fires additively (§12).
    const families = rule.gitlab.commentFamilies ?? []
    const familySelected = ctx.commentSubjectFamily !== undefined && families.includes(ctx.commentSubjectFamily)
    const createdCadenceSummon =
      summoned &&
      ctx.commentSubjectFamily !== undefined &&
      rule.gitlab.events.includes(`${ctx.commentSubjectFamily}:opened`)
    eventMatched = familySelected || createdCadenceSummon
  } else {
    const createdCadenceSummon =
      summoned &&
      (ctx.family === 'issues' || ctx.family === 'merge_request') &&
      rule.gitlab.events.includes(`${ctx.family}:opened`)
    eventMatched = matchesPattern(ctx.family) || createdCadenceSummon
  }
  if (!eventMatched) return 'no-match'
  if (rule.gitlab.mentionOnly && !summoned) return 'no-match'
  if (!labelFilterAdmits(rule.gitlab.labelFilter, ctx.labels)) return 'no-match'
  // §12.2: pushes and the SA's own same-project revisions are relay-trusted; everything else resolves live membership.
  if (ctx.family === 'push') return 'trusted'
  if (internalRevision) return 'trusted'
  return 'needs-authz'
}

/** The §12.3 rename-stable session key: subject kind plus positive IID, or the canonical ref for a push. */
export function gitlabSessionKey(rule: RcHookAssign, target: GitlabHookTarget): string {
  const prefix = rule.gitlab!.sessionKeyPrefix
  return target.kind === 'push' ? `${prefix}:push:${target.ref}` : `${prefix}:${target.kind}:${target.iid}`
}

/** The signed subject → trusted `RdMsgHook.gitlab`; incomplete identity is rejected, never substituted. */
export function buildTrustedGitlabMetadata(
  payload: GitlabPayload,
  ctx: GitlabMatchCtx,
  rule: RcHookAssign
): GitlabHookMetadata | undefined {
  const gitlab = rule.gitlab
  if (!gitlab) return undefined
  const projectId = payload.project?.id ?? payload.project_id
  if (projectId === undefined || String(projectId) !== gitlab.projectId) return undefined
  let target: GitlabHookTarget
  if (ctx.family === 'push') {
    if (!ctx.ref) return undefined
    target = { kind: 'push', ref: ctx.ref }
  } else if (ctx.family === 'issues' || ctx.commentSubjectFamily === 'issues') {
    if (ctx.iid === undefined || ctx.iid <= 0) return undefined
    target = { kind: 'issue', iid: ctx.iid }
  } else {
    if (ctx.iid === undefined || ctx.iid <= 0) return undefined
    const mr = payload.object_attributes?.iid === ctx.iid ? payload.object_attributes : payload.merge_request
    const headSha = mr?.last_commit?.id
    const draft = mr?.draft ?? mr?.work_in_progress
    target = {
      kind: 'merge_request',
      iid: ctx.iid,
      ...(ctx.sourceProjectId !== undefined ? { sourceProjectId: ctx.sourceProjectId } : {}),
      ...(headSha ? { headSha } : {}),
      ...(draft !== undefined ? { isDraft: draft } : {}),
      ...(ctx.eventAction === 'merge_request:review_requested' ? { explicitReviewRequest: true } : {})
    }
  }
  const rawNoteId = ctx.family === 'note' ? payload.object_attributes?.id : undefined
  const noteId =
    typeof rawNoteId === 'number' && Number.isSafeInteger(rawNoteId) && rawNoteId > 0 ? rawNoteId : undefined
  return {
    projectId: gitlab.projectId,
    // §24.4: opaque pass-through the daemon fences the turn on; the relay never parses it.
    ...(gitlab.host !== undefined ? { host: gitlab.host } : {}),
    projectPath: payload.project?.path_with_namespace ?? gitlab.projectPath,
    target,
    // The note that fired this delivery — the acknowledgement reaction's exact target.
    ...(noteId !== undefined ? { noteId: String(noteId) } : {})
  }
}

/** The trimmed model-visible envelope shared by the delivery's fan-out. */
export function buildGitlabContext(payload: GitlabPayload, ctx: GitlabMatchCtx): HookContext {
  const attrs = payload.object_attributes
  const subject = payload.issue ?? payload.merge_request
  const title = attrs?.title ?? subject?.title
  const bodySource = attrs?.note ?? attrs?.description ?? ctx.mentionText ?? ''
  const excerpt = truncateUtf8(bodySource, GITHUB_BODY_EXCERPT_MAX)
  const flatTitle = title ? title.replace(/\s+/g, ' ').trim() : undefined
  return {
    source: 'gitlab',
    event: ctx.family === 'note' ? 'note' : ctx.family,
    ...(ctx.eventAction.includes(':') ? { action: ctx.eventAction.slice(ctx.eventAction.indexOf(':') + 1) } : {}),
    ...(payload.project?.path_with_namespace ? { repo: payload.project.path_with_namespace } : {}),
    ...(ctx.iid !== undefined ? { number: ctx.iid } : {}),
    ...(flatTitle ? { title: flatTitle.length > 200 ? `${flatTitle.slice(0, 199)}…` : flatTitle } : {}),
    ...((payload.user?.username ?? payload.user_username)
      ? { senderLogin: payload.user?.username ?? payload.user_username }
      : {}),
    ...(payload.user?.avatar_url ? { senderAvatarUrl: payload.user.avatar_url } : {}),
    ...(ctx.labels.length > 0 ? { labels: ctx.labels } : {}),
    ...(attrs?.url ? { htmlUrl: attrs.url } : {}),
    ...(excerpt.text ? { bodyExcerpt: excerpt.text } : {}),
    ...(subjectOf(payload, ctx) ?? {}),
    truncated: excerpt.truncated
  }
}

/** The issue or MR itself, for a Decision to judge a note against (code-host-decisions.md §4). */
function subjectOf(payload: GitlabPayload, ctx: GitlabMatchCtx): Pick<HookContext, 'subject'> | undefined {
  if (ctx.family === 'push') return undefined
  const attrs = payload.object_attributes
  const subject = ctx.family === 'note' ? (payload.issue ?? payload.merge_request) : attrs
  if (!subject) return undefined
  // GitLab names only the author's id; the actor's username is the author's when they are the same user.
  const authorLogin =
    ctx.subjectAuthorId !== undefined && ctx.subjectAuthorId === ctx.actorId ? payload.user?.username : undefined
  const mr = ctx.family === 'note' ? payload.merge_request : ctx.family === 'merge_request' ? attrs : undefined
  const draft = mr?.draft ?? mr?.work_in_progress
  const body = subject.description ? truncateUtf8(subject.description, GITHUB_BODY_EXCERPT_MAX).text : ''
  return {
    subject: {
      ...(authorLogin ? { authorLogin } : {}),
      ...(subject.state ? { state: subject.state } : {}),
      ...(typeof draft === 'boolean' ? { draft } : {}),
      ...(body ? { body } : {})
    }
  }
}

/** One GitLab event as the routing step reads it: the normalized facts and the signed project id. */
export interface GitlabRouteEvent {
  ctx: GitlabMatchCtx
  projectId: string
}

type GitlabThreadFamily = Extract<CodeHostRoutingFamily, 'issues' | 'merge_request'>

function gitlabEventFamily({ ctx }: GitlabRouteEvent): GitlabThreadFamily | undefined {
  if (ctx.family === 'issues' || ctx.family === 'merge_request') return ctx.family
  return ctx.family === 'note' ? ctx.commentSubjectFamily : undefined
}

/** The thread families a GitLab rule's event patterns and note scope cover. */
export function gitlabRuleFamilies(rule: RcHookAssign): ReadonlySet<GitlabThreadFamily> {
  const families = new Set<GitlabThreadFamily>()
  if (rule.kind !== 'gitlab' || !rule.gitlab) return families
  for (const pattern of rule.gitlab.events) {
    const prefix = pattern.split(':', 1)[0]
    if (prefix === 'issues' || prefix === 'merge_request') families.add(prefix)
  }
  for (const family of rule.gitlab.commentFamilies ?? []) families.add(family)
  return families
}

function gitlabRoutingHostRule(
  scopeRules: readonly RcHookAssign[],
  routing: RcHookRouting,
  event: GitlabRouteEvent
): RcHookAssign | undefined {
  return scopeRules.find(
    (rule) =>
      rule.routing?.routingId === routing.routingId &&
      rule.agentId === routing.evaluationAgentId &&
      rule.kind === 'gitlab' &&
      rule.gitlab?.projectId === event.projectId
  )
}

/** The normalizer already dropped noise and edits; what is left is a numbered thread event of one project. */
function gitlabRecordOnlyFence(hostRule: RcHookAssign, { ctx, projectId }: GitlabRouteEvent): boolean {
  if (hostRule.kind !== 'gitlab' || hostRule.gitlab?.projectId !== projectId) return false
  if (ctx.iid === undefined || ctx.iid <= 0) return false
  return !ctx.eventAction.endsWith(':deleted')
}

/** GitLab's callbacks for the shared routing step; its routed copies need a v2 host. */
export const GITLAB_ROUTING: CodeHostRoutingProvider<GitlabRouteEvent> = {
  provider: 'gitlab',
  hostFeatures: [HOOK_DECISION_ROUTING_V1_FEATURE, HOOK_DECISION_ROUTING_V2_FEATURE],
  eventFamily: gitlabEventFamily,
  ruleFamilies: gitlabRuleFamilies,
  hostRule: gitlabRoutingHostRule,
  recordOnlyEligible: gitlabRecordOnlyFence
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404 })
}

export function registerGitlabIngress(app: FastifyInstance, deps: GitlabIngressDeps): void {
  // Own plugin scope, so the raw-body parser the signature needs does not leak onto other JSON routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: GITLAB_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/webhooks/gitlab', { bodyLimit: GITLAB_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      // §11.2 order: parse the project id, verify with the rules' token, only then match.
      let payload: GitlabPayload
      try {
        payload = JSON.parse(raw.toString('utf8')) as GitlabPayload
      } catch {
        return notFound(reply)
      }
      const projectId = payload.project?.id ?? payload.project_id
      if (projectId === undefined || !Number.isSafeInteger(projectId)) return notFound(reply)
      const rules = deps.table.getByCodeHostRepo('gitlab', String(projectId))
      if (rules.length === 0) return notFound(reply)

      const webhookId = headerString(req.headers['webhook-id'])
      const webhookTimestamp = headerString(req.headers['webhook-timestamp'])
      const signature = headerString(req.headers['webhook-signature'])
      if (!webhookId || !webhookTimestamp || !signature) return notFound(reply)
      // Accept any rule's key, so a mid-rotation mixed table cannot drop deliveries.
      const nowMs = deps.clock.now()
      const verified = rules.some(
        (rule) =>
          rule.gitlab &&
          verifyStandardWebhook(rule.gitlab.signingToken, webhookId, webhookTimestamp, raw, signature, nowMs)
      )
      if (!verified) return notFound(reply)

      const deliveryKey = webhookId.slice(0, 200)
      const firedAt = new Date(nowMs).toISOString()

      const cleanupEvent = gitlabThreadWorktreeCleanupEvent(payload)
      const cleanupIid = payload.object_attributes?.iid
      if (cleanupEvent && cleanupIid !== undefined && cleanupIid > 0) {
        // Maintenance cleanup (§12): relay-authored, never a turn, and past the actor gate so no worktree leaks.
        const kind = cleanupEvent.startsWith('issues') ? ('issue' as const) : ('merge_request' as const)
        for (const rule of rules) {
          if (rule.kind !== 'gitlab' || !rule.gitlab) continue
          const gitlab: GitlabHookMetadata = {
            projectId: rule.gitlab.projectId,
            ...(rule.gitlab.host !== undefined ? { host: rule.gitlab.host } : {}),
            projectPath: payload.project?.path_with_namespace ?? rule.gitlab.projectPath,
            target: { kind, iid: cleanupIid }
          }
          const msg: RdMsgHook = {
            source: 'hook',
            agentId: rule.agentId,
            sessionKey: gitlabSessionKey(rule, gitlab.target),
            msgId: `${rule.hookId}:${deliveryKey}`,
            hookId: rule.hookId,
            deliveryKey,
            firedAt,
            ...hookSnapshotForDelivery(rule),
            event: cleanupEvent,
            gitlab,
            context: buildGitlabContext(payload, {
              eventAction: cleanupEvent,
              family: kind === 'issue' ? 'issues' : 'merge_request',
              labels: [],
              mentionText: undefined,
              iid: cleanupIid
            }),
            ...(rule.target ? { target: rule.target } : {})
          }
          void dispatchHookFire(
            { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
            rule,
            msg
          )
        }
        return reply.code(202).send({ deliveryKey })
      }

      const ctx = normalizeGitlabEvent(payload)
      if (!ctx) return reply.code(202).send({ deliveryKey })
      const context = buildGitlabContext(payload, ctx)

      const dispatchDeps = {
        table: deps.table,
        daemons: deps.daemons,
        report: deps.report,
        clock: deps.clock,
        log: deps.log
      }
      const ruleMessage = (rule: RcHookAssign): RdMsgHook | undefined => {
        const gitlab = buildTrustedGitlabMetadata(payload, ctx, rule)
        if (!gitlab) return undefined
        return {
          source: 'hook',
          agentId: rule.agentId,
          sessionKey: gitlabSessionKey(rule, gitlab.target),
          msgId: `${rule.hookId}:${deliveryKey}`,
          hookId: rule.hookId,
          deliveryKey,
          firedAt,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          gitlab,
          context,
          ...(rule.target ? { target: rule.target } : {})
        }
      }
      const fireRule = (rule: RcHookAssign, msg: RdMsgHook, label = ''): void => {
        void dispatchHookFire(dispatchDeps, rule, msg)
        deps.log.info(
          `gitlab ingress: queued ${label}${label ? ' ' : ''}${rule.hookId}:${deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`
        )
      }
      // Routing (code-host-decisions.md §4): a routed rule that would fire becomes a candidate of its scope instead.
      const router = createCodeHostRouter(deps, GITLAB_ROUTING, {
        event: { ctx, projectId: String(projectId) },
        repoId: String(projectId),
        deliveryKey,
        eventAction: ctx.eventAction,
        messageFor: ruleMessage,
        fire: fireRule
      })

      const dispatchRule = (rule: RcHookAssign, notice?: RdHookNotice): void => {
        // A notice is a fixed post, never routed; a routed rule spends the budget only when selected.
        const routed = notice === undefined && router.routed(rule)
        if (!routed && !deps.limiter.allow(rule.hookId)) {
          deps.log.info(`gitlab ingress: rate-limited ${rule.hookId}:${deliveryKey} (${ctx.eventAction})`)
          return
        }
        const msg = ruleMessage(rule)
        if (!msg) {
          deps.log.info(`gitlab ingress: rejected incomplete identity ${rule.hookId}:${deliveryKey}`)
          return
        }
        if (routed) {
          router.collect(rule)
          return
        }
        fireRule(rule, notice ? noticeDelivery(msg, notice) : msg, notice)
      }

      const reportReviewRequestRequired = (rule: RcHookAssign): void => {
        const gitlab = buildTrustedGitlabMetadata(payload, ctx, rule)
        deps.report({
          hookId: rule.hookId,
          deliveryKey,
          firedAt,
          agentId: rule.agentId,
          daemonId: rule.daemonId,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          ...(gitlab ? { gitlab } : {}),
          status: 'failed',
          reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
        })
      }

      // A routed rule is never narrowed by a mention: its scope's Decision chooses, a mentioned agent included.
      const unrouted = rules.filter((rule) => !router.routed(rule))
      const narrowed = new Set(
        ctx.eventAction === 'merge_request:review_requested'
          ? unrouted
          : gitlabMentionCandidates(unrouted, ctx.mentionText)
      )
      const candidates = rules.filter((rule) => router.routed(rule) || narrowed.has(rule))
      const matched = candidates
        .map((rule) => ({ rule, verdict: gitlabRuleVerdict(rule, ctx) }))
        .filter((candidate) => candidate.verdict !== 'no-match')
      for (const { rule, verdict } of matched) if (verdict === 'trusted') dispatchRule(rule)
      const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
      if (needsAuthz.length === 0) {
        router.routeScopes()
        return reply.code(202).send({ deliveryKey })
      }

      // §12.2: one live membership decision fences the whole fan-out; a denied MR revision leaves an actionable run row.
      const isLifecycle = ctx.family === 'issues' || ctx.family === 'merge_request'
      // Lifecycle authorizes the subject author, notes the commenter, a reviewer request the assigning actor (§12.2).
      const actorId =
        ctx.eventAction === 'merge_request:review_requested'
          ? ctx.actorId
          : isLifecycle
            ? (ctx.subjectAuthorId ?? ctx.actorId)
            : ctx.actorId
      // Only a denied MR revision leaves the durable actionable row (§12.2).
      const onDenied: 'skip' | 'request-review' =
        ctx.eventAction === 'merge_request:opened' || ctx.eventAction === 'merge_request:synchronize'
          ? 'request-review'
          : 'skip'

      const authorizeAndDispatch = async (fanout: RcHookAssign[], requireSubjectAuthor: boolean): Promise<void> => {
        const representative = fanout[0]
        if (!representative?.gitlab) return
        if (
          !actorId ||
          (requireSubjectAuthor && !ctx.subjectAuthorId) ||
          fanout.some(
            (rule) => !rule.gitlab || rule.configRevision === undefined || rule.dispatchRevision === undefined
          )
        ) {
          deps.log.info(`gitlab ingress: authz metadata incomplete ${representative.hookId}:${deliveryKey}`)
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        if (!deps.authzLimiter.allow(representative.gitlab.projectId)) {
          deps.log.info(`gitlab ingress: authz rate-limited ${representative.hookId}:${deliveryKey}`)
          return
        }
        const request: RcCodeHostMembershipAuthz = {
          hookId: representative.hookId,
          provider: 'gitlab',
          repoExternalId: representative.gitlab.projectId,
          actorExternalId: actorId,
          ...(requireSubjectAuthor && ctx.subjectAuthorId && ctx.subjectAuthorId !== actorId
            ? { subjectAuthorExternalId: ctx.subjectAuthorId }
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
        // Only the CP's own `false` refuses the actor; an operational failure earns no notice.
        let refused = false
        try {
          allowed = await deps.authorizeMembership(request)
          refused = !allowed
        } catch (err) {
          // An older CP (UNKNOWN_FRAME), a timeout or a transient failure all fail closed (§12.2).
          deps.log.warn(`gitlab ingress: authz failed ${representative.hookId}:${deliveryKey}: ${String(err)}`)
        }
        if (!allowed) {
          deps.log.info(
            `gitlab ingress: authz denied ${representative.hookId}:${deliveryKey} (${ctx.eventAction} actor ${actorId})`
          )
          // A refused explicit @-mention gets one fixed-text notice on its thread; anything less deliberate stays silent.
          if (refused && fanout.some((rule) => gitlabRuleIsSummoned(rule, ctx)))
            dispatchRule(representative, 'actor_not_trusted')
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        // Authz crossed a remote boundary: re-read and re-judge every rule so a stale capture never dispatches.
        for (const rule of fanout) {
          const current = deps.table.getByHookId(rule.hookId)
          if (
            !current ||
            current.kind !== 'gitlab' ||
            !current.gitlab ||
            current.gitlab.projectId !== rule.gitlab!.projectId ||
            current.configRevision !== rule.configRevision ||
            current.dispatchRevision !== rule.dispatchRevision ||
            current.agentId !== rule.agentId ||
            gitlabRuleVerdict(current, ctx) !== 'needs-authz'
          ) {
            deps.log.info(`gitlab ingress: authz rule changed ${rule.hookId}:${deliveryKey}`)
            continue
          }
          dispatchRule(current)
        }
      }

      // An unmentioned note also fences the subject author (§12.2); the router waits on every lookup before routing.
      const queueAuthorized = (fanout: RcHookAssign[], requireSubjectAuthor: boolean): void => {
        if (fanout.length === 0) return
        router.track(
          authorizeAndDispatch(fanout, requireSubjectAuthor).catch((err) => {
            deps.log.warn(`gitlab ingress: authz task failed ${deliveryKey}: ${String(err)}`)
          })
        )
      }
      if (ctx.family === 'note') {
        queueAuthorized(
          needsAuthz.filter((rule) => gitlabRuleIsSummoned(rule, ctx)),
          false
        )
        queueAuthorized(
          needsAuthz.filter((rule) => !gitlabRuleIsSummoned(rule, ctx)),
          true
        )
      } else {
        queueAuthorized(needsAuthz, false)
      }
      router.routeScopes()
      return reply.code(202).send({ deliveryKey })
    })
  })
}
