/**
 * GitLab ingress — `POST /webhooks/gitlab`, the relay's project-webhook
 * endpoint (gitlab-com-integration.md §11.2, §12). Verification is per-rule:
 * the compiled rule carries the project's `whsec_` signing token inline, so the
 * bounded first parse only extracts the numeric project id, the Standard
 * Webhooks signature is checked against the matching rules' token, and only
 * then is the payload trusted as filter input. Uniform 404 for invalid
 * signatures, stale timestamps, unknown projects, and malformed bodies — no
 * connected-project oracle. Verified unmatched deliveries answer 202.
 *
 * The payload is NEVER logged; rules carry secret material.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  type GitlabHookMetadata,
  type GitlabHookTarget,
  type HookContext,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcHookRerun,
  type RcHookRerunResult,
  type RcRunReport,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../relay-daemon-server.js'
import type { HookTable } from './hook-table.js'
import type { HookRateLimiter } from './rate-limit.js'
import { dispatchHookFire } from './ingress.js'
import { hookSnapshotForDelivery } from './hook-snapshot.js'
import { mentionsGithubHandle, truncateUtf8, GITHUB_BODY_EXCERPT_MAX } from './github-ingress.js'
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

/** The slice of a GitLab webhook payload the matcher/envelope reads. Everything
 *  here is UNTRUSTED except as filter input; authorization is the signature
 *  plus the CP's live membership resolution (§12.2). */
interface GitlabPayload {
  object_kind?: string
  event_type?: string
  user?: { id?: number; username?: string; name?: string; avatar_url?: string }
  project?: { id?: number; path_with_namespace?: string; web_url?: string }
  project_id?: number
  object_attributes?: {
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
  issue?: { iid?: number; title?: string; labels?: Array<{ title?: string }>; author_id?: number }
  merge_request?: {
    iid?: number
    title?: string
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

/** Lifecycle deliveries that close a GitLab thread's daemon-owned workspace
 *  (§12): merged MRs and closed issues; an unmerged closed MR may reopen. */
function gitlabThreadWorktreeCleanupEvent(payload: GitlabPayload): string | undefined {
  const attrs = payload.object_attributes
  if (!attrs) return undefined
  if (payload.object_kind === 'issue' && attrs.action === 'close') return 'issues:closed'
  if (payload.object_kind === 'merge_request' && attrs.action === 'merge') return 'merge_request:merged'
  return undefined
}

/** Normalize one verified payload to the stored-pattern event universe, or
 *  undefined when the delivery is lifecycle noise (§12 vetoes). Exported for
 *  unit tests. */
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
    // Label changes are the one substantive `update`; edit/close/reopen are
    // lifecycle noise (close fires separately as maintenance cleanup).
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
          // A request is a NEWLY ADDED reviewer, or a native re-request — which
          // keeps the reviewer in both arrays and flags the current entry with
          // `re_requested: true`. Ordinary submitted-review state changes carry
          // neither and stay inert.
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
    // close (unmerged), reopen, approve/unapprove, merge → not new turns here
    // (merge fires separately as maintenance cleanup).
    return undefined
  }
  if (kind === 'note') {
    if (!attrs || attrs.system === true) return undefined
    // §12 edit veto: GitLab Note Hooks also fire on comment EDITS with
    // action 'update' and a fresh webhook-id — never a new turn. Absent action
    // (legacy payloads) keeps meaning creation.
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

/** Explicit agent handles narrow a project fan-out; the service-account handle
 *  is the broadcast form (the GitLab analog of the App slug). */
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

/**
 * One rule's verdict for one verified delivery (pure; exported for unit tests).
 * Order: loop-prevention veto → reviewer-request path → cadence/additive summon
 * match → comment scope → mention-only gate → live-authz classification.
 */
export function gitlabRuleVerdict(rule: RcHookAssign, ctx: GitlabMatchCtx): GitlabRuleVerdict {
  if (rule.kind !== 'gitlab' || !rule.gitlab) return 'no-match'
  // §12.1: any bound account's events never re-trigger, except this rule's own same-project MR revisions.
  // A note a bound account authors is always rejected (the note author IS the actor).
  const actorIsBoundAccount = gitlabVetoedAuthor(rule, ctx.actorId)
  const internalRevision =
    ctx.actorId === rule.gitlab.serviceAccountUserId && isInternalServiceAccountRevision(rule, ctx)
  if (actorIsBoundAccount && !internalRevision) return 'no-match'
  if (ctx.family === 'note' && actorIsBoundAccount) return 'no-match'
  // §12.2 explicit start path: assigning the SA as reviewer bypasses cadence,
  // label, and mention filters — but only for this rule's SA, and only after
  // the live membership gate authorizes the assigning actor.
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
    // Comments are scoped by the console-selected families; a summon in a
    // created-cadence thread family fires additively (§12).
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
  // §12.2: pushes and the SA's own same-project revisions stay relay-trusted;
  // every issue/MR lifecycle event and comment resolves live membership.
  if (ctx.family === 'push') return 'trusted'
  if (internalRevision) return 'trusted'
  return 'needs-authz'
}

/** The §12.3 rename-stable session key: exact subject discriminator, positive
 *  IID (or the payload's canonical ref) — never a display path or delivery id. */
export function gitlabSessionKey(rule: RcHookAssign, target: GitlabHookTarget): string {
  const prefix = rule.gitlab!.sessionKeyPrefix
  return target.kind === 'push' ? `${prefix}:push:${target.ref}` : `${prefix}:${target.kind}:${target.iid}`
}

/** The signed-payload subject → the trusted `RdMsgHook.gitlab` discriminator.
 *  Undefined identity is rejected before any dispatch — never substituted. */
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
  return {
    projectId: gitlab.projectId,
    // §24.4: opaque pass-through. The relay never dials GitLab and never parses this — the
    // daemon fences the turn on it against the session's spec-carried host.
    ...(gitlab.host !== undefined ? { host: gitlab.host } : {}),
    projectPath: payload.project?.path_with_namespace ?? gitlab.projectPath,
    target
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
    truncated: excerpt.truncated
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404 })
}

export function registerGitlabIngress(app: FastifyInstance, deps: GitlabIngressDeps): void {
  // Own plugin scope: the buffer content parser (raw bytes for the signature)
  // must not leak onto the relay's other JSON surfaces.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: GITLAB_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/webhooks/gitlab', { bodyLimit: GITLAB_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      // §11.2 order: bounded parse for the project id FIRST, then the rules'
      // signing token verifies the delivery, and only then is anything matched.
      let payload: GitlabPayload
      try {
        payload = JSON.parse(raw.toString('utf8')) as GitlabPayload
      } catch {
        return notFound(reply)
      }
      const projectId = payload.project?.id ?? payload.project_id
      if (projectId === undefined || !Number.isSafeInteger(projectId)) return notFound(reply)
      const rules = deps.table.getByGitlabProject(String(projectId))
      if (rules.length === 0) return notFound(reply)

      const webhookId = headerString(req.headers['webhook-id'])
      const webhookTimestamp = headerString(req.headers['webhook-timestamp'])
      const signature = headerString(req.headers['webhook-signature'])
      if (!webhookId || !webhookTimestamp || !signature) return notFound(reply)
      // Every rule on one project carries the binding's key; accept any match
      // so a mid-rotation mixed table cannot drop deliveries.
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
        // Maintenance cleanup (§12): relay-authored, never a model turn, and it
        // bypasses the actor gate — a low-role closer must not leak a worktree.
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

      const dispatchRule = (rule: RcHookAssign): void => {
        if (!deps.limiter.allow(rule.hookId)) {
          deps.log.info(`gitlab ingress: rate-limited ${rule.hookId}:${deliveryKey} (${ctx.eventAction})`)
          return
        }
        const gitlab = buildTrustedGitlabMetadata(payload, ctx, rule)
        if (!gitlab) {
          deps.log.info(`gitlab ingress: rejected incomplete identity ${rule.hookId}:${deliveryKey}`)
          return
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
          event: ctx.eventAction,
          gitlab,
          context,
          ...(rule.target ? { target: rule.target } : {})
        }
        void dispatchHookFire(
          { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
          rule,
          msg
        )
        deps.log.info(`gitlab ingress: queued ${rule.hookId}:${deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`)
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

      const candidates =
        ctx.eventAction === 'merge_request:review_requested' ? rules : gitlabMentionCandidates(rules, ctx.mentionText)
      const matched = candidates
        .map((rule) => ({ rule, verdict: gitlabRuleVerdict(rule, ctx) }))
        .filter((candidate) => candidate.verdict !== 'no-match')
      for (const { rule, verdict } of matched) if (verdict === 'trusted') dispatchRule(rule)
      const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
      if (needsAuthz.length === 0) return reply.code(202).send({ deliveryKey })

      // §12.2: one live membership decision fences the complete fan-out. An MR
      // from an untrusted author does not start automatically — a denied
      // revision event leaves a durable, actionable run row instead.
      const isLifecycle = ctx.family === 'issues' || ctx.family === 'merge_request'
      // Lifecycle events authorize the subject author; comments authorize the
      // commenter. A reviewer request/re-request instead authorizes the
      // ASSIGNING actor — the MR author is deliberately untrusted on the
      // explicit external start path (§12.2).
      const actorId =
        ctx.eventAction === 'merge_request:review_requested'
          ? ctx.actorId
          : isLifecycle
            ? (ctx.subjectAuthorId ?? ctx.actorId)
            : ctx.actorId
      // Only a denied MR REVISION leaves the durable actionable row (§12.2) —
      // the same two events GitHub treats as first-review material.
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
        try {
          allowed = await deps.authorizeMembership(request)
        } catch (err) {
          // Rolling upgrade against an older CP (UNKNOWN_FRAME), timeout, and
          // transient failures all fail closed (§12.2).
          deps.log.warn(`gitlab ingress: authz failed ${representative.hookId}:${deliveryKey}: ${String(err)}`)
        }
        if (!allowed) {
          deps.log.info(
            `gitlab ingress: authz denied ${representative.hookId}:${deliveryKey} (${ctx.eventAction} actor ${actorId})`
          )
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        // The membership wait crossed a remote boundary: re-read every rule and
        // re-run the verdict so a remove/reconfigure/retarget in that window
        // cannot dispatch a stale capture.
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

      // Comments on an unmentioned thread continuation also require the subject
      // author's membership (§12.2); a summoning comment authorizes only the
      // commenter.
      if (ctx.family === 'note') {
        const summonedRules = needsAuthz.filter((rule) => gitlabRuleIsSummoned(rule, ctx))
        const unsummoned = needsAuthz.filter((rule) => !gitlabRuleIsSummoned(rule, ctx))
        if (summonedRules.length > 0)
          void authorizeAndDispatch(summonedRules, false).catch((err) => {
            deps.log.warn(`gitlab ingress: authz task failed ${deliveryKey}: ${String(err)}`)
          })
        if (unsummoned.length > 0)
          void authorizeAndDispatch(unsummoned, true).catch((err) => {
            deps.log.warn(`gitlab ingress: authz task failed ${deliveryKey}: ${String(err)}`)
          })
      } else {
        void authorizeAndDispatch(needsAuthz, false).catch((err) => {
          deps.log.warn(`gitlab ingress: authz task failed ${deliveryKey}: ${String(err)}`)
        })
      }
      return reply.code(202).send({ deliveryKey })
    })
  })
}

/** The deps one Console-initiated rerun needs — the ordinary ingress subset. */
export type GitlabRerunDeps = Pick<GitlabIngressDeps, 'table' | 'daemons' | 'report' | 'limiter' | 'clock' | 'log'>

/**
 * Re-dispatch one gitlab hook turn on the Control Plane's `rc/hook-rerun`
 * (§16.1 "Run again"). The CP already revalidated the hook, agent, binding, and
 * live subject; the relay re-checks the frame against its OWN compiled rule —
 * a disable, retarget, or reconfigure since the CP read fails the rerun closed
 * — then reuses the ordinary dispatch path, including its per-hook run budget.
 *
 * The return value IS the admission: only `admitted` means a turn was queued and
 * a run report will follow. Every refusal is definitive and leaves no HookRun
 * row, so the Control Plane is free to ask another relay.
 */
export function dispatchGitlabRerun(deps: GitlabRerunDeps, rerun: RcHookRerun): RcHookRerunResult {
  const rule = deps.table.getByHookId(rerun.hookId)
  // No rule at all reads as an unconverged table: this relay's copy is filled by
  // the CP's register replay, and the CP only sends a rerun it just compiled.
  if (!rule) {
    deps.log.info(`gitlab rerun: no rule yet for ${rerun.hookId}:${rerun.deliveryKey}`)
    return { admitted: false, code: 'replay_pending' }
  }
  if (
    rule.kind !== 'gitlab' ||
    !rule.gitlab ||
    rule.agentId !== rerun.agentId ||
    rule.gitlab.projectId !== rerun.gitlab.projectId ||
    rule.configRevision !== rerun.configRevision ||
    rule.dispatchRevision !== rerun.dispatchRevision
  ) {
    deps.log.info(`gitlab rerun: ignored stale ${rerun.hookId}:${rerun.deliveryKey}`)
    return { admitted: false, code: 'rule_mismatch' }
  }
  if (!deps.limiter.allow(rule.hookId)) {
    deps.log.info(`gitlab rerun: rate-limited ${rule.hookId}:${rerun.deliveryKey}`)
    return { admitted: false, code: 'limiter_exhausted' }
  }
  const family = rerun.gitlab.target.kind === 'issue' ? ('issues' as const) : ('merge_request' as const)
  const msg: RdMsgHook = {
    source: 'hook',
    agentId: rule.agentId,
    sessionKey: gitlabSessionKey(rule, rerun.gitlab.target),
    msgId: `${rule.hookId}:${rerun.deliveryKey}`,
    hookId: rule.hookId,
    deliveryKey: rerun.deliveryKey,
    firedAt: new Date(deps.clock.now()).toISOString(),
    ...hookSnapshotForDelivery(rule),
    event: rerun.event,
    gitlab: rerun.gitlab,
    // Control-authored envelope: no third-party text, so nothing to fence.
    context: {
      source: 'gitlab',
      event: family,
      action: 'rerun',
      repo: rerun.gitlab.projectPath,
      ...(rerun.gitlab.target.kind !== 'push' ? { number: rerun.gitlab.target.iid } : {}),
      truncated: false
    },
    ...(rule.target ? { target: rule.target } : {})
  }
  void dispatchHookFire(
    { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
    rule,
    msg
  )
  deps.log.info(`gitlab rerun: queued ${rule.hookId}:${rerun.deliveryKey} (${rerun.event} ${msg.sessionKey})`)
  return { admitted: true, deliveryKey: rerun.deliveryKey }
}
