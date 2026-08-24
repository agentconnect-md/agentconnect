/**
 * Hook ingress — `POST /webhooks/in/:token`, the relay's public generic-webhook
 * endpoint (webhook-triggers-and-github-events.md, decision 1/9). One of the two
 * bearer-less writable public entrypoints in the system, so the defenses are
 * layered and uniform:
 *
 *  - unknown/removed token AND a failed `X-AC-Signature` check both answer 404
 *    (no token-existence oracle);
 *  - per-hook token-bucket rate limit (429);
 *  - `application/json` only, 128 KiB body cap (per-scope parser keeps the RAW
 *    bytes — HMAC is computed over them, never over a re-serialization);
 *  - the payload is NEVER logged.
 *
 * The handler answers 202 the moment the fire is QUEUED (GitHub's 10s delivery
 * timeout shapes the generic contract too); the dispatch verdict lands with the
 * CP asynchronously as an `rc/run-report` EVT — `accepted` opens the HookRun
 * row, a delivery-stage failure closes it as failed. The relay holds no DB and
 * does NOT dedup: a redelivered key is absorbed by the daemon's (sessionKey,
 * msgId) ack replay and the CP's (hookId, deliveryKey) unique row.
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Clock } from '@agentconnect.md/connection'
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_INSTANCE_V1_FEATURE,
  isSelfManagedGitlabHost,
  HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2,
  type RcHookAssign,
  type RcRunReport,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../relay-daemon-server.js'
import type { HookTable } from './hook-table.js'
import type { HookRateLimiter } from './rate-limit.js'
import { verifySha256Header } from './signature.js'
import { hookSnapshotForDelivery } from './hook-snapshot.js'
import type { Logger } from '../log.js'

/** Raw-body cap for the generic endpoint (design: 128 KiB). */
export const HOOK_BODY_LIMIT = 128 * 1024
/** The envelope's body excerpt cap (design: 64 KiB) — the agent pulls the rest itself. */
export const HOOK_BODY_EXCERPT_MAX = 64 * 1024

/** Missing-connection retry cadence. Including the immediate lookup, daemon
 * placement is checked at t=0, 1s, 4s, and 12s. */
export const HOOK_DISPATCH_RETRY_DELAYS_MS = [0, 1_000, 3_000, 8_000] as const

export interface HookIngressDeps {
  table: HookTable
  /** Late-bound: the rd/* server exists only after `listen()` (routes must register before). */
  daemons: () => Pick<RelayDaemonServer, 'get'> | undefined
  /** Emit one delivery-stage `rc/run-report` EVT to the CP (fire-and-forget). */
  report: (report: RcRunReport) => void
  limiter: HookRateLimiter
  clock: Clock
  log: Logger
}

function requiresGithubThreadWorktreeCleanup(msg: RdMsgHook): boolean {
  if (msg.event === 'pull_request:merged' && msg.github?.subjectKind === 'pull_request') {
    return true
  }
  if (msg.event === 'issues:closed' && msg.github?.subjectKind === 'issue') {
    return true
  }
  if (msg.event === 'issues:deleted' && msg.github?.subjectKind === 'issue') {
    return true
  }
  return false
}

/** The relay-computed session-affinity key (design decision 7; webhook kind). */
function sessionKeyFor(rule: RcHookAssign, deliveryKey: string): string {
  return rule.sessionMode === 'shared' ? rule.hookId : `${rule.hookId}:${deliveryKey}`
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404 })
}

function hasCompleteDispatchFence(rule: RcHookAssign): boolean {
  return (
    rule.configRevision !== undefined &&
    rule.dispatchRevision !== undefined &&
    rule.dispatchDaemonId !== undefined &&
    rule.reviewPolicy !== undefined &&
    rule.reportingMode !== undefined &&
    rule.gateMode !== undefined &&
    rule.dispatchDaemonId === rule.daemonId
  )
}

/** A fenced retry may follow a placement-only recompile. Everything else is
 * authority: hook kind, agent, trigger configuration, target, and policy. */
function retryRuleIsAuthorized(captured: RcHookAssign, current: RcHookAssign): boolean {
  if (!hasCompleteDispatchFence(captured) || !hasCompleteDispatchFence(current)) {
    // A legacy rule has no revision fence with which to authorize a retarget.
    // It may still survive a transient disconnect when the rule is unchanged.
    return isDeepStrictEqual(captured, current)
  }

  const capturedAuthority = { ...captured } as Record<string, unknown>
  const currentAuthority = { ...current } as Record<string, unknown>
  for (const field of ['daemonId', 'dispatchDaemonId', 'dispatchRevision']) {
    delete capturedAuthority[field]
    delete currentAuthority[field]
  }
  // The canonical repository name is display metadata discovered from signed
  // deliveries. A rename refresh must not revoke an otherwise identical retry.
  if (captured.kind === 'github' && current.kind === 'github') {
    capturedAuthority.github = {
      ...captured.github,
      repoFullName: undefined,
      sessionKeyPrefix: captured.github?.sessionKeyPrefix ?? captured.github?.repoFullName
    }
    currentAuthority.github = {
      ...current.github,
      repoFullName: undefined,
      sessionKeyPrefix: current.github?.sessionKeyPrefix ?? current.github?.repoFullName
    }
  }
  return isDeepStrictEqual(capturedAuthority, currentAuthority)
}

/** Replace the rolling snapshot as one unit. Deleting first is important: a
 * newly incomplete rule must not inherit optional fence fields from the first
 * attempt when the stable message fields are spread. */
function messageForRetry(rule: RcHookAssign, msg: RdMsgHook): RdMsgHook {
  const stable = { ...msg }
  delete stable.configRevision
  delete stable.dispatchRevision
  delete stable.dispatchDaemonId
  delete stable.reviewPolicy
  delete stable.reportingMode
  delete stable.gateMode
  return {
    ...stable,
    agentId: rule.agentId,
    ...hookSnapshotForDelivery(rule)
  }
}

function reportBase(rule: RcHookAssign, msg: RdMsgHook): Omit<RcRunReport, 'status' | 'reason'> {
  return {
    hookId: rule.hookId,
    deliveryKey: msg.deliveryKey,
    firedAt: msg.firedAt,
    agentId: rule.agentId,
    daemonId: rule.daemonId,
    ...hookSnapshotForDelivery(rule),
    ...(msg.event ? { event: msg.event } : {}),
    ...(msg.github ? { github: msg.github } : {}),
    ...(msg.gitlab ? { gitlab: msg.gitlab } : {})
  }
}

/**
 * Dispatch one queued fire to its daemon and report the delivery verdict.
 * Exported for unit tests; never throws (the verdict IS the error channel).
 */
export async function dispatchHookFire(
  deps: Pick<HookIngressDeps, 'table' | 'daemons' | 'report' | 'clock' | 'log'>,
  capturedRule: RcHookAssign,
  msg: RdMsgHook
): Promise<void> {
  await new Promise<void>((resolve) => {
    let attemptIndex = 0

    const attempt = (): void => {
      // Re-read on every attempt. A remove/config change revokes the captured
      // fire; a complete revision fence alone can authorize a placement move.
      const rule = deps.table.getByHookId(capturedRule.hookId)
      if (!rule || !retryRuleIsAuthorized(capturedRule, rule)) {
        deps.log.info(`hook dispatch: cancelled changed rule ${capturedRule.hookId}:${msg.deliveryKey}`)
        resolve()
        return
      }

      const dispatchMsg = messageForRetry(rule, msg)
      const base = reportBase(rule, dispatchMsg)
      const conn = deps.daemons()?.get(rule.daemonId)
      if (!conn) {
        if (attemptIndex === HOOK_DISPATCH_RETRY_DELAYS_MS.length - 1) {
          deps.report({ ...base, status: 'failed', reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE })
          resolve()
          return
        }
        attemptIndex += 1
        deps.clock.setTimeout(attempt, HOOK_DISPATCH_RETRY_DELAYS_MS[attemptIndex]!)
        return
      }

      // These event names are relay-authored maintenance commands. An older
      // daemon would run them as model prompts, so fail closed until the target
      // explicitly advertises maintenance-only handling.
      if (requiresGithubThreadWorktreeCleanup(dispatchMsg) && !conn.supports(RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2)) {
        deps.report({ ...base, status: 'failed', reason: 'rejected:unsupported' })
        resolve()
        return
      }
      // A GitLab turn's session-key/normalization contract is the daemon's
      // gitlab-com-v1 capability (§12.3): an older daemon would fall back to
      // generic parsing and mis-scope the thread, so fail closed instead.
      if (dispatchMsg.gitlab && !conn.supports(GITLAB_COM_V1_FEATURE)) {
        deps.report({ ...base, status: 'failed', reason: 'rejected:unsupported' })
        resolve()
        return
      }
      // §24.4, the same shape one bit newer: a self-managed host needs a daemon that
      // resolves the host from its spec rather than assuming GitLab.com. Fenced HERE, on the
      // live connection, because a daemon's advertisement changes under a standing rule —
      // and re-read on every retry attempt, so a rollout heals without a convergence pass.
      if (isSelfManagedGitlabHost(dispatchMsg.gitlab?.host) && !conn.supports(GITLAB_INSTANCE_V1_FEATURE)) {
        deps.report({ ...base, status: 'failed', reason: 'rejected:unsupported' })
        resolve()
        return
      }

      // Once a connection exists, dispatch exactly once. A rejection is an
      // agent/business verdict; a throw is ambiguous delivery. Neither is a
      // missing-connection condition, so neither enters this fast retry loop.
      let ack: ReturnType<typeof conn.sendMsg>
      try {
        ack = conn.sendMsg(dispatchMsg)
      } catch {
        deps.report({ ...base, status: 'failed', reason: HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT })
        resolve()
        return
      }
      void ack.then(
        (result) => {
          if (result.accepted) deps.report({ ...base, status: 'accepted' })
          else deps.report({ ...base, status: 'failed', reason: `rejected:${result.reason ?? 'unknown'}` })
          resolve()
        },
        () => {
          // Correlator timeout / socket died mid-flight — the daemon may or may
          // not have run it. Record the ambiguity terminally; an exact-fence
          // late daemon completion may still converge the run.
          deps.report({ ...base, status: 'failed', reason: HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT })
          resolve()
        }
      )
    }

    attempt()
  })
}

export function registerHookIngress(app: FastifyInstance, deps: HookIngressDeps): void {
  // Own plugin scope: the buffer content parser (raw bytes for HMAC) must not
  // leak onto the relay's other JSON surfaces (health probes).
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: HOOK_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post<{ Params: { token: string } }>(
      '/webhooks/in/:token',
      { bodyLimit: HOOK_BODY_LIMIT },
      async (req, reply) => {
        const rule = deps.table.getByToken(req.params.token)
        if (!rule || rule.kind !== 'webhook' || !rule.webhook) return notFound(reply)

        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        // Second capability layer when configured: signature failure reads
        // exactly like an unknown token (uniform 404, no oracle).
        if (
          rule.webhook.hmacSecret &&
          !verifySha256Header(rule.webhook.hmacSecret, raw, req.headers['x-ac-signature'] as string)
        )
          return notFound(reply)

        if (!deps.limiter.allow(rule.hookId)) {
          return reply.code(429).send({ error: 'Too Many Requests', statusCode: 429 })
        }

        const headerKey = req.headers['x-ac-delivery-key']
        const deliveryKey =
          typeof headerKey === 'string' && headerKey.length > 0 && headerKey.length <= 200 ? headerKey : randomUUID()

        const text = raw.toString('utf8')
        const truncated = text.length > HOOK_BODY_EXCERPT_MAX
        const msg: RdMsgHook = {
          source: 'hook',
          agentId: rule.agentId,
          sessionKey: sessionKeyFor(rule, deliveryKey),
          msgId: `${rule.hookId}:${deliveryKey}`,
          hookId: rule.hookId,
          deliveryKey,
          firedAt: new Date(deps.clock.now()).toISOString(),
          ...hookSnapshotForDelivery(rule),
          context: {
            source: 'webhook',
            body: truncated ? text.slice(0, HOOK_BODY_EXCERPT_MAX) : text,
            truncated
          },
          ...(rule.target ? { target: rule.target } : {})
        }

        // 202 now; the delivery verdict travels out-of-band (rc/run-report).
        void dispatchHookFire(deps, rule, msg)
        deps.log.info(`hook ingress: queued ${rule.hookId}:${deliveryKey}`)
        return reply.code(202).send({ deliveryKey })
      }
    )
  })
}
