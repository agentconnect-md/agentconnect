/** Azure DevOps ingress (`POST /webhooks/azure-devops`, azure-devops-integration.md §11.3, §11.4): subscription lookup, Basic verification before decoding, uniform 404; the payload and credentials are never logged. */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  type AzureDevOpsDeliveryKind,
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
import { hookSnapshotForDelivery } from '../hook-snapshot.js'
import type { Logger } from '../../log.js'
import {
  azureDevOpsMentionCandidates,
  azureDevOpsRuleAdmitsReopened,
  azureDevOpsRuleCoversPullRequests,
  azureDevOpsRuleIsSummoned,
  azureDevOpsRuleVerdict,
  azureDevOpsSessionKey,
  azureDevOpsSubscriptionKind,
  azureDevOpsVerifiedKey,
  buildAzureDevOpsContext,
  buildTrustedAzureDevOpsMetadata,
  checkAzureDevOpsDelivery,
  type AzureDevOpsEnvelope,
  type AzureDevOpsMatchCtx
} from './events.js'

/** Raw-body cap (§11.3: 1 MiB). */
export const AZURE_DEVOPS_BODY_LIMIT = 1024 * 1024

const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KEY_RANK = { current: 0, next: 1, previous: 2 } as const

export interface AzureDevOpsIngressDeps {
  table: HookTable
  /** Late-bound: the rd/* server exists only after `listen()` (routes register before). */
  daemons: () => Pick<RelayDaemonServer, 'get'> | undefined
  /** Emit one delivery-stage `rc/run-report` EVT to the CP (fire-and-forget). */
  report: (report: RcRunReport) => void
  /** Emit one `rc/codehost-delivery` EVT per verified delivery (§11.3; fire-and-forget). */
  observe?: (observed: RcCodeHostDelivery) => void
  /** §11.4 live membership gate — metadata only, resolved by the CP. */
  authorizeMembership: (request: RcCodeHostMembershipAuthz) => Promise<boolean>
  /** Dedicated upstream-call budget, shared by every hook on one repository. */
  authzLimiter: HookRateLimiter
  limiter: HookRateLimiter
  clock: Clock
  log: Logger
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404 })
}

interface CheckedRule {
  rule: RcHookAssign
  kind: AzureDevOpsDeliveryKind
  key: 'current' | 'next' | 'previous'
  ctx: AzureDevOpsMatchCtx
}

export function registerAzureDevOpsIngress(app: FastifyInstance, deps: AzureDevOpsIngressDeps): void {
  // Own plugin scope, so the raw-body parser does not leak onto other JSON routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: AZURE_DEVOPS_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/webhooks/azure-devops', { bodyLimit: AZURE_DEVOPS_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      // §11.3 order: read only the subscription id, verify against its rules' keys, only then decode the rest.
      let envelope: AzureDevOpsEnvelope
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return notFound(reply)
        envelope = parsed as AzureDevOpsEnvelope
      } catch {
        return notFound(reply)
      }
      const subscriptionId = envelope.subscriptionId
      if (typeof subscriptionId !== 'string' || !SUBSCRIPTION_ID.test(subscriptionId)) return notFound(reply)
      const rules = deps.table.getByAzureDevOpsSubscription(subscriptionId)
      if (rules.length === 0) return notFound(reply)

      const authorization = headerString(req.headers.authorization)
      const now = deps.clock.now()
      const verified = rules.flatMap((rule) => {
        const kind = azureDevOpsSubscriptionKind(rule, subscriptionId)
        const key = kind && rule.azureDevOps ? azureDevOpsVerifiedKey(rule.azureDevOps, authorization, now) : null
        return kind && key ? [{ rule, kind, key }] : []
      })
      if (verified.length === 0) return notFound(reply)

      // Decoded only now: a body that disagrees with the rule that verified it is refused like a failed verification.
      const eventId = envelope.id
      if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 200) return notFound(reply)
      const checked: CheckedRule[] = verified.flatMap((candidate) => {
        const ctx = checkAzureDevOpsDelivery(envelope, candidate.rule.azureDevOps!, candidate.kind)
        return ctx ? [{ ...candidate, ctx }] : []
      })
      const first = checked[0]
      if (!first) {
        deps.log.info(`azure-devops ingress: refused a body that disagrees with its subscription ${eventId}`)
        return notFound(reply)
      }

      const deliveryKey = eventId
      const firedAt = new Date(now).toISOString()
      const verifiedWith = checked.reduce((best, { key }) => (KEY_RANK[key] < KEY_RANK[best] ? key : best), first.key)
      // Every verified delivery is reported, matched or not: it proves the subscription reaches the relay (§11.3).
      deps.observe?.({
        provider: 'azure-devops',
        repoExternalId: first.rule.azureDevOps!.repoId,
        deliveryKey,
        receivedAt: firedAt,
        verifiedWith
      })

      // Every rule records the binding's subscriptions alike; one that names another kind is a stale copy and sits this one out.
      const ctx = first.ctx
      const matching = checked.filter((candidate) => candidate.kind === first.kind).map(({ rule }) => rule)
      const dispatchDeps = {
        table: deps.table,
        daemons: deps.daemons,
        report: deps.report,
        clock: deps.clock,
        log: deps.log
      }

      const messageFor = (
        rule: RcHookAssign,
        extra: { ref?: string; admitsReopened?: boolean; deliveryKey?: string } = {}
      ): RdMsgHook | undefined => {
        const azureDevOps = buildTrustedAzureDevOpsMetadata(ctx, rule, extra)
        if (!azureDevOps) return undefined
        const key = extra.deliveryKey ?? deliveryKey
        return {
          source: 'hook',
          agentId: rule.agentId,
          sessionKey: azureDevOpsSessionKey(rule, azureDevOps.target),
          msgId: `${rule.hookId}:${key}`,
          hookId: rule.hookId,
          deliveryKey: key,
          firedAt,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          azureDevOps,
          context: buildAzureDevOpsContext(rule, ctx, extra.ref),
          ...(rule.target ? { target: rule.target } : {})
        }
      }
      const fire = (rule: RcHookAssign, msg: RdMsgHook, label = ''): void => {
        void dispatchHookFire(dispatchDeps, rule, msg)
        deps.log.info(
          `azure-devops ingress: queued ${label}${label ? ' ' : ''}${rule.hookId}:${msg.deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`
        )
      }

      // Merged and state carry only the pull request's id: every pull-request rule gets them, and the daemon classifies on its own read (§11.4).
      if (ctx.deliveryKind === 'merged' || ctx.deliveryKind === 'state') {
        for (const rule of matching) {
          if (!azureDevOpsRuleCoversPullRequests(rule)) continue
          // A reopening may start a turn, so it spends the budget; cleanup alone never does.
          const admitsReopened =
            ctx.deliveryKind === 'state' &&
            rule.routing === undefined &&
            azureDevOpsRuleAdmitsReopened(rule) &&
            deps.limiter.allow(rule.hookId)
          const msg = messageFor(rule, ctx.deliveryKind === 'state' ? { admitsReopened } : {})
          if (msg) fire(rule, msg)
        }
        return reply.code(202).send({ deliveryKey })
      }

      // Decision routing is not offered for Azure DevOps yet: a routed rule fails closed rather than fire around its Decision.
      const unrouted = matching.filter((rule) => {
        if (rule.routing === undefined) return true
        deps.log.info(`azure-devops ingress: skipped routed rule ${rule.hookId}:${deliveryKey}`)
        return false
      })

      const dispatchRule = (rule: RcHookAssign, notice?: RdHookNotice): void => {
        if (notice === undefined && !deps.limiter.allow(rule.hookId)) {
          deps.log.info(`azure-devops ingress: rate-limited ${rule.hookId}:${deliveryKey} (${ctx.eventAction})`)
          return
        }
        if (ctx.family === 'push') {
          // One fire per moved ref, each its own session; a single-ref push keeps the event id as its key.
          const refs = ctx.refs ?? []
          for (const ref of refs) {
            const msg = messageFor(rule, {
              ref,
              deliveryKey: refs.length === 1 ? deliveryKey : `${deliveryKey}:${ref}`
            })
            if (msg) fire(rule, msg)
          }
          return
        }
        const msg = messageFor(rule)
        if (!msg) {
          deps.log.info(`azure-devops ingress: rejected incomplete identity ${rule.hookId}:${deliveryKey}`)
          return
        }
        fire(rule, notice ? noticeDelivery(msg, notice) : msg, notice)
      }

      // A reviewer change names no actor: the daemon confirms the request on its read, and the pull request's author is gated there (§11.4).
      if (ctx.deliveryKind === 'reviewers') {
        for (const rule of unrouted) if (azureDevOpsRuleCoversPullRequests(rule)) dispatchRule(rule)
        return reply.code(202).send({ deliveryKey })
      }

      const narrowed = azureDevOpsMentionCandidates(unrouted, ctx.mentionText)
      const matched = narrowed
        .map((rule) => ({ rule, verdict: azureDevOpsRuleVerdict(rule, ctx) }))
        .filter((candidate) => candidate.verdict !== 'no-match')
      for (const { rule, verdict } of matched) if (verdict === 'trusted') dispatchRule(rule)
      const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
      if (needsAuthz.length === 0) return reply.code(202).send({ deliveryKey })

      // Only a denied opened pull request leaves the durable actionable row.
      const onDenied: 'skip' | 'request-review' = ctx.deliveryKind === 'opened' ? 'request-review' : 'skip'
      const reportReviewRequestRequired = (rule: RcHookAssign): void => {
        const azureDevOps = buildTrustedAzureDevOpsMetadata(ctx, rule)
        deps.report({
          hookId: rule.hookId,
          deliveryKey,
          firedAt,
          agentId: rule.agentId,
          daemonId: rule.daemonId,
          ...hookSnapshotForDelivery(rule),
          event: ctx.eventAction,
          ...(azureDevOps ? { azureDevOps } : {}),
          status: 'failed',
          reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
        })
      }

      // §11.4: one live membership decision on the actor fences the whole fan-out.
      const authorizeAndDispatch = async (fanout: RcHookAssign[]): Promise<void> => {
        const representative = fanout[0]
        const azure = representative?.azureDevOps
        if (!representative || !azure) return
        const actorId = ctx.actorId
        if (
          !actorId ||
          fanout.some(
            (rule) => !rule.azureDevOps || rule.configRevision === undefined || rule.dispatchRevision === undefined
          )
        ) {
          deps.log.info(`azure-devops ingress: authz metadata incomplete ${representative.hookId}:${deliveryKey}`)
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        if (!deps.authzLimiter.allow(azure.repoId)) {
          deps.log.info(`azure-devops ingress: authz rate-limited ${representative.hookId}:${deliveryKey}`)
          return
        }
        const request: RcCodeHostMembershipAuthz = {
          hookId: representative.hookId,
          provider: 'azure-devops',
          repoExternalId: azure.repoId,
          actorIdentityId: actorId,
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
          // An older CP, a timeout or a transient failure all fail closed.
          deps.log.warn(`azure-devops ingress: authz failed ${representative.hookId}:${deliveryKey}: ${String(err)}`)
        }
        if (!allowed) {
          deps.log.info(
            `azure-devops ingress: authz denied ${representative.hookId}:${deliveryKey} (${ctx.eventAction})`
          )
          // A refused explicit summons gets one fixed-text notice on its thread; anything less deliberate stays silent.
          if (refused && ctx.family === 'note' && fanout.some((rule) => azureDevOpsRuleIsSummoned(rule, ctx))) {
            dispatchRule(representative, 'actor_not_trusted')
          }
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        // Authz crossed a remote boundary: re-read and re-judge every rule so a stale capture never dispatches.
        for (const rule of fanout) {
          const current = deps.table.getByHookId(rule.hookId)
          if (
            !current ||
            current.kind !== 'azure-devops' ||
            !current.azureDevOps ||
            current.azureDevOps.repoId !== rule.azureDevOps!.repoId ||
            current.configRevision !== rule.configRevision ||
            current.dispatchRevision !== rule.dispatchRevision ||
            current.agentId !== rule.agentId ||
            current.routing !== undefined ||
            azureDevOpsSubscriptionKind(current, subscriptionId) !== ctx.deliveryKind ||
            azureDevOpsRuleVerdict(current, ctx) !== 'needs-authz'
          ) {
            deps.log.info(`azure-devops ingress: authz rule changed ${rule.hookId}:${deliveryKey}`)
            continue
          }
          dispatchRule(current)
        }
      }
      void authorizeAndDispatch(needsAuthz).catch((err) => {
        deps.log.warn(`azure-devops ingress: authz task failed ${deliveryKey}: ${String(err)}`)
      })
      return reply.code(202).send({ deliveryKey })
    })
  })
}
