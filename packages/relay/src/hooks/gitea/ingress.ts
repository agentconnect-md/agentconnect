/** Gitea ingress (`POST /webhooks/gitea`, gitea-integration.md §7, §8): per-rule `X-Gitea-Signature` verification before matching, uniform 404, no replay window (durable msgId dedup absorbs retries); the payload is never logged. */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  type GiteaHookMetadata,
  type RcCodeHostDelivery,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcRunReport,
  type RdHookNotice,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../../relay-daemon-server.js'
import type { HookTable } from '../hook-table.js'
import type { HookRateLimiter } from '../rate-limit.js'
import { dispatchHookFire, noticeDelivery } from '../ingress.js'
import { createCodeHostRouter } from '../code-host-routing.js'
import { hookSnapshotForDelivery } from '../hook-snapshot.js'
import { verifyHexHmacSha256 } from '../signature.js'
import type { Logger } from '../../log.js'
import {
  buildGiteaContext,
  buildTrustedGiteaMetadata,
  giteaMentionCandidates,
  giteaRuleIsSummoned,
  giteaRuleVerdict,
  giteaSessionKey,
  giteaThreadWorktreeCleanup,
  GITEA_ROUTING,
  normalizeGiteaEvent,
  type GiteaPayload
} from './events.js'

/** Raw-body cap (§7: 1 MiB). */
export const GITEA_BODY_LIMIT = 1024 * 1024

export interface GiteaIngressDeps {
  table: HookTable
  /** Late-bound: the rd/* server exists only after `listen()` (routes register before). */
  daemons: () => Pick<RelayDaemonServer, 'get'> | undefined
  /** Emit one delivery-stage `rc/run-report` EVT to the CP (fire-and-forget). */
  report: (report: RcRunReport) => void
  /** Emit one `rc/codehost-delivery` EVT per verified delivery (§6 step 4, §7 promotion; fire-and-forget). */
  observe?: (observed: RcCodeHostDelivery) => void
  /** §8 live effective-membership gate — metadata only, resolved by the CP. */
  authorizeMembership: (request: RcCodeHostMembershipAuthz) => Promise<boolean>
  /** Dedicated upstream-call budget, shared by every hook on one repository. */
  authzLimiter: HookRateLimiter
  limiter: HookRateLimiter
  clock: Clock
  log: Logger
}

/** Which signing key of any rule on the repository verifies the body; null when none does. */
function verifiedGiteaKey(rules: readonly RcHookAssign[], raw: Buffer, signature: string): 'current' | 'next' | null {
  for (const rule of rules) {
    if (!rule.gitea) continue
    if (verifyHexHmacSha256(rule.gitea.signingKey, raw, signature)) return 'current'
    if (rule.gitea.nextSigningKey !== undefined && verifyHexHmacSha256(rule.gitea.nextSigningKey, raw, signature)) {
      return 'next'
    }
  }
  return null
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404 })
}

export function registerGiteaIngress(app: FastifyInstance, deps: GiteaIngressDeps): void {
  // Own plugin scope, so the raw-body parser the signature needs does not leak onto other JSON routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: GITEA_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/webhooks/gitea', { bodyLimit: GITEA_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      // §7 order: parse the repository id, verify with the rules' key, only then match.
      let payload: GiteaPayload
      try {
        payload = JSON.parse(raw.toString('utf8')) as GiteaPayload
      } catch {
        return notFound(reply)
      }
      const repoId = payload.repository?.id
      if (repoId === undefined || !Number.isSafeInteger(repoId)) return notFound(reply)
      const rules = deps.table.getByCodeHostRepo('gitea', String(repoId))
      if (rules.length === 0) return notFound(reply)

      const deliveryHeader = headerString(req.headers['x-gitea-delivery'])
      const signature = headerString(req.headers['x-gitea-signature'])
      if (!deliveryHeader || !signature) return notFound(reply)
      // Hex HMAC-SHA256 over the raw body (§16); mid-rotation either key verifies, and which one did is what the CP promotes on (§7).
      const verifiedWith = verifiedGiteaKey(rules, raw, signature)
      if (!verifiedWith) return notFound(reply)

      const deliveryKey = deliveryHeader.slice(0, 200)
      const firedAt = new Date(deps.clock.now()).toISOString()
      // Report every verified delivery, matched or not: the test delivery proves the relay is reachable (§6).
      deps.observe?.({
        provider: 'gitea',
        repoExternalId: String(repoId),
        deliveryKey,
        receivedAt: firedAt,
        verifiedWith
      })
      // Never `X-Gitea-Event`: it collapses sync/reviewer-request into `pull_request` and mislabels reviews (§7).
      const eventType = headerString(req.headers['x-gitea-event-type'])
      if (!eventType) return reply.code(202).send({ deliveryKey })

      const cleanup = giteaThreadWorktreeCleanup(eventType, payload)
      if (cleanup) {
        // Maintenance cleanup (§8): relay-authored, never a turn, and past the actor gate so no worktree leaks.
        const { event: cleanupEvent, kind, index: cleanupIndex } = cleanup
        for (const rule of rules) {
          if (rule.kind !== 'gitea' || !rule.gitea) continue
          const gitea: GiteaHookMetadata = {
            repoId: rule.gitea.repoId,
            ...(rule.gitea.host !== undefined ? { host: rule.gitea.host } : {}),
            repoPath: payload.repository?.full_name ?? rule.gitea.repoPath,
            target: { kind, index: cleanupIndex }
          }
          const msg: RdMsgHook = {
            source: 'hook',
            agentId: rule.agentId,
            sessionKey: giteaSessionKey(rule, gitea.target),
            msgId: `${rule.hookId}:${deliveryKey}`,
            hookId: rule.hookId,
            deliveryKey,
            firedAt,
            ...hookSnapshotForDelivery(rule),
            event: cleanupEvent,
            gitea,
            context: buildGiteaContext(payload, {
              eventAction: cleanupEvent,
              family: kind === 'issue' ? 'issues' : 'merge_request',
              labels: [],
              mentionText: undefined,
              index: cleanupIndex
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

      const ctx = normalizeGiteaEvent(eventType, payload)
      if (!ctx) return reply.code(202).send({ deliveryKey })
      const context = buildGiteaContext(payload, ctx)

      const dispatchDeps = {
        table: deps.table,
        daemons: deps.daemons,
        report: deps.report,
        clock: deps.clock,
        log: deps.log
      }
      const ruleMessage = (rule: RcHookAssign): RdMsgHook | undefined => {
        const gitea = buildTrustedGiteaMetadata(payload, ctx, rule)
        if (!gitea) return undefined
        return {
          source: 'hook',
          agentId: rule.agentId,
          sessionKey: giteaSessionKey(rule, gitea.target),
          msgId: `${rule.hookId}:${deliveryKey}`,
          hookId: rule.hookId,
          deliveryKey,
          firedAt,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          gitea,
          context,
          ...(rule.target ? { target: rule.target } : {})
        }
      }
      const fireRule = (rule: RcHookAssign, msg: RdMsgHook, label = ''): void => {
        void dispatchHookFire(dispatchDeps, rule, msg)
        deps.log.info(
          `gitea ingress: queued ${label}${label ? ' ' : ''}${rule.hookId}:${deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`
        )
      }
      // Routing (code-host-decisions.md §4): a routed rule that would fire becomes a candidate of its scope instead.
      const router = createCodeHostRouter(deps, GITEA_ROUTING, {
        event: { ctx, repoId: String(repoId) },
        repoId: String(repoId),
        deliveryKey,
        eventAction: ctx.eventAction,
        messageFor: ruleMessage,
        fire: fireRule
      })

      const dispatchRule = (rule: RcHookAssign, notice?: RdHookNotice): void => {
        // A notice is a fixed post, never routed; a routed rule spends the budget only when selected.
        const routed = notice === undefined && router.routed(rule)
        if (!routed && !deps.limiter.allow(rule.hookId)) {
          deps.log.info(`gitea ingress: rate-limited ${rule.hookId}:${deliveryKey} (${ctx.eventAction})`)
          return
        }
        const msg = ruleMessage(rule)
        if (!msg) {
          deps.log.info(`gitea ingress: rejected incomplete identity ${rule.hookId}:${deliveryKey}`)
          return
        }
        if (routed) {
          router.collect(rule)
          return
        }
        fireRule(rule, notice ? noticeDelivery(msg, notice) : msg, notice)
      }

      const reportReviewRequestRequired = (rule: RcHookAssign): void => {
        const gitea = buildTrustedGiteaMetadata(payload, ctx, rule)
        deps.report({
          hookId: rule.hookId,
          deliveryKey,
          firedAt,
          agentId: rule.agentId,
          daemonId: rule.daemonId,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          ...(gitea ? { gitea } : {}),
          status: 'failed',
          reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
        })
      }

      // A routed rule is never narrowed by a mention: its scope's Decision chooses, a mentioned agent included.
      const unrouted = rules.filter((rule) => !router.routed(rule))
      const narrowed = new Set(
        ctx.eventAction === 'merge_request:review_requested'
          ? unrouted
          : giteaMentionCandidates(unrouted, ctx.mentionText, ctx.teamOwnerLogin)
      )
      const candidates = rules.filter((rule) => router.routed(rule) || narrowed.has(rule))
      const matched = candidates
        .map((rule) => ({ rule, verdict: giteaRuleVerdict(rule, ctx) }))
        .filter((candidate) => candidate.verdict !== 'no-match')
      for (const { rule, verdict } of matched) if (verdict === 'trusted') dispatchRule(rule)
      const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
      if (needsAuthz.length === 0) {
        router.routeScopes()
        return reply.code(202).send({ deliveryKey })
      }

      // §8: one live membership decision fences the whole fan-out; an external pull request's author fails it.
      const isLifecycle = ctx.family === 'issues' || ctx.family === 'merge_request'
      // Lifecycle authorizes the subject author, comments and reviews their author, a reviewer request the requester (§8).
      const gated =
        ctx.eventAction !== 'merge_request:review_requested' && isLifecycle && ctx.subjectAuthorId !== undefined
          ? { id: ctx.subjectAuthorId, login: ctx.subjectAuthorLogin }
          : { id: ctx.actorId, login: ctx.actorLogin }
      const actorId = gated.id
      // Only a denied pull-request REVISION leaves the durable actionable row (§8).
      const onDenied: 'skip' | 'request-review' =
        ctx.eventAction === 'merge_request:opened' || ctx.eventAction === 'merge_request:synchronize'
          ? 'request-review'
          : 'skip'

      const authorizeAndDispatch = async (fanout: RcHookAssign[], requireSubjectAuthor: boolean): Promise<void> => {
        const representative = fanout[0]
        if (!representative?.gitea) return
        if (
          !actorId ||
          (requireSubjectAuthor && !ctx.subjectAuthorId) ||
          fanout.some((rule) => !rule.gitea || rule.configRevision === undefined || rule.dispatchRevision === undefined)
        ) {
          deps.log.info(`gitea ingress: authz metadata incomplete ${representative.hookId}:${deliveryKey}`)
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        if (!deps.authzLimiter.allow(representative.gitea.repoId)) {
          deps.log.info(`gitea ingress: authz rate-limited ${representative.hookId}:${deliveryKey}`)
          return
        }
        const request: RcCodeHostMembershipAuthz = {
          hookId: representative.hookId,
          provider: 'gitea',
          repoExternalId: representative.gitea.repoId,
          actorExternalId: actorId,
          // Gitea checks permission by username; the CP re-resolves it against the id, so a rename borrows nothing.
          ...(gated.login ? { actorUsername: gated.login } : {}),
          ...(requireSubjectAuthor && ctx.subjectAuthorId && ctx.subjectAuthorId !== actorId
            ? {
                subjectAuthorExternalId: ctx.subjectAuthorId,
                ...(ctx.subjectAuthorLogin ? { subjectAuthorUsername: ctx.subjectAuthorLogin } : {})
              }
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
          // An older CP (UNKNOWN_FRAME), a timeout or a transient failure all fail closed (§8).
          deps.log.warn(`gitea ingress: authz failed ${representative.hookId}:${deliveryKey}: ${String(err)}`)
        }
        if (!allowed) {
          deps.log.info(
            `gitea ingress: authz denied ${representative.hookId}:${deliveryKey} (${ctx.eventAction} actor ${actorId})`
          )
          // A refused explicit @-mention gets one fixed-text notice on its thread; anything less deliberate stays silent.
          if (refused && fanout.some((rule) => giteaRuleIsSummoned(rule, ctx)))
            dispatchRule(representative, 'actor_not_trusted')
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        // Authz crossed a remote boundary: re-read and re-judge every rule so a stale capture never dispatches.
        for (const rule of fanout) {
          const current = deps.table.getByHookId(rule.hookId)
          if (
            !current ||
            current.kind !== 'gitea' ||
            !current.gitea ||
            current.gitea.repoId !== rule.gitea!.repoId ||
            current.configRevision !== rule.configRevision ||
            current.dispatchRevision !== rule.dispatchRevision ||
            current.agentId !== rule.agentId ||
            giteaRuleVerdict(current, ctx) !== 'needs-authz'
          ) {
            deps.log.info(`gitea ingress: authz rule changed ${rule.hookId}:${deliveryKey}`)
            continue
          }
          dispatchRule(current)
        }
      }

      // An unmentioned comment or review also fences the subject author (§8); the router waits on every lookup before routing.
      const queueAuthorized = (fanout: RcHookAssign[], requireSubjectAuthor: boolean): void => {
        if (fanout.length === 0) return
        router.track(
          authorizeAndDispatch(fanout, requireSubjectAuthor).catch((err) => {
            deps.log.warn(`gitea ingress: authz task failed ${deliveryKey}: ${String(err)}`)
          })
        )
      }
      if (ctx.family === 'note' || ctx.family === 'review') {
        queueAuthorized(
          needsAuthz.filter((rule) => giteaRuleIsSummoned(rule, ctx)),
          false
        )
        queueAuthorized(
          needsAuthz.filter((rule) => !giteaRuleIsSummoned(rule, ctx)),
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
