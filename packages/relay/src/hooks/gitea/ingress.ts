/**
 * Gitea ingress — `POST /webhooks/gitea`, the relay's per-repository webhook
 * endpoint (gitea-integration.md §7, §8). Verification is per-rule: the compiled
 * rule carries the repository's signing key inline, so the bounded first parse
 * only extracts the numeric repository id, `X-Gitea-Signature` is checked
 * against the matching rules' keys, and only then is the payload trusted as
 * filter input. Uniform 404 for invalid signatures, unknown repositories,
 * missing headers, and malformed bodies — no connected-repository oracle.
 * Verified unmatched deliveries answer 202.
 *
 * Gitea sends no timestamp header, so there is no replay window — the same
 * position GitHub is in. `X-Gitea-Delivery` is the delivery key, `msgId` is
 * `${hookId}:${deliveryKey}`, and the daemon's durable `(sessionKey, msgId)`
 * inbox plus the Control Plane's unique `(hookId, deliveryKey)` `HookRun`
 * absorb every provider retry.
 *
 * Deployment supplies the HTTPS termination this endpoint requires (§7), exactly
 * as it does for the GitHub and GitLab endpoints.
 *
 * The payload is NEVER logged; rules carry secret material.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  type GiteaHookMetadata,
  type RcCodeHostDelivery,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcHookRerun,
  type RcHookRerunResult,
  type RcRunReport,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../../relay-daemon-server.js'
import type { HookTable } from '../hook-table.js'
import type { HookRateLimiter } from '../rate-limit.js'
import { dispatchHookFire } from '../ingress.js'
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
  // Own plugin scope: the buffer content parser (raw bytes for the signature)
  // must not leak onto the relay's other JSON surfaces.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: GITEA_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/webhooks/gitea', { bodyLimit: GITEA_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      // §7 order: bounded parse for the repository id FIRST, then the rules'
      // signing key verifies the delivery, and only then is anything matched.
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
      // `X-Gitea-Signature` is bare hex HMAC-SHA256 over the exact raw body (§16). Mid-rotation a
      // rule carries the successor beside the current key, and either verifies (§7); which one did
      // is what the CP promotes on.
      const verifiedWith = verifiedGiteaKey(rules, raw, signature)
      if (!verifiedWith) return notFound(reply)

      const deliveryKey = deliveryHeader.slice(0, 200)
      const firedAt = new Date(deps.clock.now()).toISOString()
      // Every verified delivery is reported, matched or not: the managed webhook's test delivery
      // is exactly one no rule ever matches, and it is what proves the relay is reachable (§6).
      deps.observe?.({
        provider: 'gitea',
        repoExternalId: String(repoId),
        deliveryKey,
        receivedAt: firedAt,
        verifiedWith
      })
      // Never `X-Gitea-Event`: it collapses the sync and reviewer-request types into
      // `pull_request`, and names a review `pull_request_comment` — a timeline comment's type (§7).
      const eventType = headerString(req.headers['x-gitea-event-type'])
      if (!eventType) return reply.code(202).send({ deliveryKey })

      const cleanup = giteaThreadWorktreeCleanup(eventType, payload)
      if (cleanup) {
        // Maintenance cleanup (§8): relay-authored, never a model turn, and it
        // bypasses the actor gate — a low-role closer must not leak a worktree.
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

      const dispatchRule = (rule: RcHookAssign): void => {
        if (!deps.limiter.allow(rule.hookId)) {
          deps.log.info(`gitea ingress: rate-limited ${rule.hookId}:${deliveryKey} (${ctx.eventAction})`)
          return
        }
        const gitea = buildTrustedGiteaMetadata(payload, ctx, rule)
        if (!gitea) {
          deps.log.info(`gitea ingress: rejected incomplete identity ${rule.hookId}:${deliveryKey}`)
          return
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
          event: ctx.eventAction,
          gitea,
          context,
          ...(rule.target ? { target: rule.target } : {})
        }
        void dispatchHookFire(
          { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
          rule,
          msg
        )
        deps.log.info(`gitea ingress: queued ${rule.hookId}:${deliveryKey} (${ctx.eventAction} ${msg.sessionKey})`)
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

      const candidates =
        ctx.eventAction === 'merge_request:review_requested' ? rules : giteaMentionCandidates(rules, ctx.mentionText)
      const matched = candidates
        .map((rule) => ({ rule, verdict: giteaRuleVerdict(rule, ctx) }))
        .filter((candidate) => candidate.verdict !== 'no-match')
      for (const { rule, verdict } of matched) if (verdict === 'trusted') dispatchRule(rule)
      const needsAuthz = matched.filter((candidate) => candidate.verdict === 'needs-authz').map(({ rule }) => rule)
      if (needsAuthz.length === 0) return reply.code(202).send({ deliveryKey })

      // §8: one live membership decision fences the whole fan-out. An external pull request
      // (`head.repo_id` ≠ `repository.id`) never starts automatically — its author fails the gate.
      const isLifecycle = ctx.family === 'issues' || ctx.family === 'merge_request'
      // Lifecycle authorizes the subject author, comments and reviews their own author, and a
      // reviewer request the REQUESTING actor — never the untrusted pull-request author (§8).
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
          // Gitea's permission lookup is by username, so the login travels beside the id; the CP
          // re-resolves the name and refuses a mismatch, so a rename cannot borrow a permission.
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
        try {
          allowed = await deps.authorizeMembership(request)
        } catch (err) {
          // Rolling upgrade against an older CP (UNKNOWN_FRAME), timeout, and
          // transient failures all fail closed (§8).
          deps.log.warn(`gitea ingress: authz failed ${representative.hookId}:${deliveryKey}: ${String(err)}`)
        }
        if (!allowed) {
          deps.log.info(
            `gitea ingress: authz denied ${representative.hookId}:${deliveryKey} (${ctx.eventAction} actor ${actorId})`
          )
          if (onDenied === 'request-review') for (const rule of fanout) reportReviewRequestRequired(rule)
          return
        }
        // The membership wait crossed a remote boundary: re-read every rule and re-run the
        // verdict, so a remove/reconfigure/retarget in that window cannot dispatch a stale capture.
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

      // Comments and review submissions on an unmentioned thread continuation also require the
      // subject author's membership (§8); a summoning comment authorizes only its author.
      if (ctx.family === 'note' || ctx.family === 'review') {
        const summonedRules = needsAuthz.filter((rule) => giteaRuleIsSummoned(rule, ctx))
        const unsummoned = needsAuthz.filter((rule) => !giteaRuleIsSummoned(rule, ctx))
        if (summonedRules.length > 0)
          void authorizeAndDispatch(summonedRules, false).catch((err) => {
            deps.log.warn(`gitea ingress: authz task failed ${deliveryKey}: ${String(err)}`)
          })
        if (unsummoned.length > 0)
          void authorizeAndDispatch(unsummoned, true).catch((err) => {
            deps.log.warn(`gitea ingress: authz task failed ${deliveryKey}: ${String(err)}`)
          })
      } else {
        void authorizeAndDispatch(needsAuthz, false).catch((err) => {
          deps.log.warn(`gitea ingress: authz task failed ${deliveryKey}: ${String(err)}`)
        })
      }
      return reply.code(202).send({ deliveryKey })
    })
  })
}

/** The deps one Console-initiated rerun needs — the ordinary ingress subset. */
export type GiteaRerunDeps = Pick<GiteaIngressDeps, 'table' | 'daemons' | 'report' | 'limiter' | 'clock' | 'log'>

/**
 * Re-dispatch one gitea hook turn on the Control Plane's `rc/hook-rerun`
 * (gitea-integration.md §10.4). The CP already revalidated the hook, agent,
 * binding, and live subject; the relay re-checks the frame against its OWN
 * compiled rule — a disable, retarget, or reconfigure since the CP read fails
 * the rerun closed — then reuses the ordinary dispatch path, including its
 * per-hook run budget.
 *
 * The return value IS the admission: only `admitted` means a turn was queued and
 * a run report will follow. Every refusal is definitive and leaves no HookRun
 * row, so the Control Plane is free to ask another relay.
 */
export function dispatchGiteaRerun(deps: GiteaRerunDeps, rerun: RcHookRerun): RcHookRerunResult {
  const rule = deps.table.getByHookId(rerun.hookId)
  // No rule at all reads as an unconverged table: this relay's copy is filled by
  // the CP's register replay, and the CP only sends a rerun it just compiled.
  if (!rule) {
    deps.log.info(`gitea rerun: no rule yet for ${rerun.hookId}:${rerun.deliveryKey}`)
    return { admitted: false, code: 'replay_pending' }
  }
  // The frame is provider-keyed: a member this handler does not own is not a rule mismatch it
  // can fix, so it refuses definitively and the Control Plane moves on.
  const gitea = rerun.gitea
  if (
    !gitea ||
    rule.kind !== 'gitea' ||
    !rule.gitea ||
    rule.agentId !== rerun.agentId ||
    rule.gitea.repoId !== gitea.repoId ||
    rule.configRevision !== rerun.configRevision ||
    rule.dispatchRevision !== rerun.dispatchRevision
  ) {
    deps.log.info(`gitea rerun: ignored stale ${rerun.hookId}:${rerun.deliveryKey}`)
    return { admitted: false, code: 'rule_mismatch' }
  }
  if (!deps.limiter.allow(rule.hookId)) {
    deps.log.info(`gitea rerun: rate-limited ${rule.hookId}:${rerun.deliveryKey}`)
    return { admitted: false, code: 'limiter_exhausted' }
  }
  const family = gitea.target.kind === 'issue' ? ('issues' as const) : ('merge_request' as const)
  const msg: RdMsgHook = {
    source: 'hook',
    agentId: rule.agentId,
    sessionKey: giteaSessionKey(rule, gitea.target),
    msgId: `${rule.hookId}:${rerun.deliveryKey}`,
    hookId: rule.hookId,
    deliveryKey: rerun.deliveryKey,
    firedAt: new Date(deps.clock.now()).toISOString(),
    ...hookSnapshotForDelivery(rule),
    event: rerun.event,
    gitea,
    // Control-authored envelope: no third-party text, so nothing to fence.
    context: {
      source: 'gitea',
      event: family,
      action: 'rerun',
      repo: gitea.repoPath,
      ...(gitea.target.kind !== 'push' ? { number: gitea.target.index } : {}),
      truncated: false
    },
    ...(rule.target ? { target: rule.target } : {})
  }
  void dispatchHookFire(
    { table: deps.table, daemons: deps.daemons, report: deps.report, clock: deps.clock, log: deps.log },
    rule,
    msg
  )
  deps.log.info(`gitea rerun: queued ${rule.hookId}:${rerun.deliveryKey} (${rerun.event} ${msg.sessionKey})`)
  return { admitted: true, deliveryKey: rerun.deliveryKey }
}
