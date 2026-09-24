// Code-host Decision routing (code-host-decisions.md §4): candidates, one host copy per scope, fan-out of the host's choice.
import type {
  CodeHostProvider,
  CodeHostRoutingFamily,
  HookRouteSelection,
  RcHookAssign,
  RcHookRouting,
  RdAck,
  RdHookRouteCandidate,
  RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../relay-daemon-server.js'
import type { HookTable } from './hook-table.js'
import type { HookRateLimiter } from './rate-limit.js'
import type { Logger } from '../log.js'

/** Longer than the host's 5 s Decision deadline, single-shot so the fallback is not delayed by retransmits. */
export const HOOK_ROUTING_ACK_TIMEOUT_MS = 15_000
const ROUTING_REQUEST = { ackTimeoutMs: HOOK_ROUTING_ACK_TIMEOUT_MS, maxTries: 1 }

/** One routed rule that would fire; the host's Decision chooses among them. */
export interface CodeHostRouteCandidate {
  rule: RcHookAssign
}

/** What one provider's ingress supplies to the shared routing step; `E` is its per-event match input. */
export interface CodeHostRoutingProvider<E> {
  /** The hook-table namespace the scope's rules are re-read from. */
  provider: CodeHostProvider
  /** Every feature the host daemon must advertise before it is sent a copy of this provider's events. */
  hostFeatures: readonly string[]
  /** The routing family an event's thread belongs to; undefined for events outside every scope (push). */
  eventFamily(event: E): CodeHostRoutingFamily | undefined
  /** The routing families a rule's subscriptions cover. */
  ruleFamilies(rule: RcHookAssign): ReadonlySet<CodeHostRoutingFamily>
  /** The evaluation agent's own rule in a scope, fenced to this event's repository. */
  hostRule(scopeRules: readonly RcHookAssign[], routing: RcHookRouting, event: E): RcHookAssign | undefined
  /** The provider's record-only fence: a non-deleted thread event of the host rule's repository. */
  recordOnlyEligible(hostRule: RcHookAssign, event: E): boolean
}

/** Whether a scope with no candidate records this event on its host: the provider's fence plus the host rule's family. */
export function codeHostRecordOnlyEligible<E>(
  provider: CodeHostRoutingProvider<E>,
  hostRule: RcHookAssign,
  event: E
): boolean {
  if (hostRule.routing === undefined) return false
  const family = provider.eventFamily(event)
  if (family === undefined || !provider.ruleFamilies(hostRule).has(family)) return false
  return provider.recordOnlyEligible(hostRule, event)
}

/** The wire candidates, one per hook, in fire order. */
export function codeHostRouteCandidates(candidates: readonly CodeHostRouteCandidate[]): RdHookRouteCandidate[] {
  return candidates.map(({ rule }) => ({ hookId: rule.hookId, agentId: rule.agentId }))
}

/** The provider-failure fallback's evidence: every candidate fires as without a Decision. */
export function hostUnavailableSelection(routing: RcHookRouting): HookRouteSelection {
  return {
    routingId: routing.routingId,
    decisionId: routing.decisionId,
    reason: 'unavailable',
    unavailableReason: 'host_unavailable'
  }
}

/** The host copy of a routed event: the host rule's own delivery under a distinct msgId, carrying the candidates. */
export function codeHostHostCopy(
  hostMsg: RdMsgHook,
  routing: RcHookRouting,
  candidates: readonly CodeHostRouteCandidate[]
): RdMsgHook {
  return {
    ...hostMsg,
    msgId: `${hostMsg.msgId}:route`,
    routing: {
      routingId: routing.routingId,
      decisionId: routing.decisionId,
      candidates: codeHostRouteCandidates(candidates)
    }
  }
}

export type CodeHostHostVerdict =
  | { kind: 'targets'; targets: NonNullable<RdAck['hookRoute']>['targets'] }
  | { kind: 'held'; reason: string }
  | { kind: 'unavailable'; reason: string }

type RoutedScope = NonNullable<HookRouteSelection['scope']>

type Daemons = () => Pick<RelayDaemonServer, 'get'> | undefined

/** The scope host's connection, when it can read this provider's routed copies. */
function routingHost(daemons: Daemons, routing: RcHookRouting, features: readonly string[]) {
  const conn = daemons()?.get(routing.evaluationDaemonId)
  if (!conn) return { conn: undefined, reason: 'offline' }
  if (features.some((feature) => !conn.supports(feature))) return { conn: undefined, reason: 'unsupported' }
  return { conn, reason: undefined }
}

/** Ask the scope's host for its choice; any failure to get an answer is `unavailable`. */
export async function askCodeHostRoutingHost(
  daemons: Daemons,
  routing: RcHookRouting,
  copy: RdMsgHook,
  features: readonly string[]
): Promise<CodeHostHostVerdict> {
  const { conn, reason } = routingHost(daemons, routing, features)
  if (!conn) return { kind: 'unavailable', reason: reason ?? 'offline' }
  let ack: RdAck
  try {
    ack = await conn.sendMsg(copy, ROUTING_REQUEST)
  } catch (err) {
    return { kind: 'unavailable', reason: `timeout: ${String(err)}` }
  }
  if (!ack.accepted) return { kind: 'held', reason: ack.reason ?? 'rejected' }
  if (!ack.hookRoute) return { kind: 'held', reason: 'no_route' }
  return { kind: 'targets', targets: ack.hookRoute.targets }
}

/** Fire-and-forget a record-only copy; a host that cannot take it loses one history row, nothing more. */
export function sendCodeHostRecordOnlyCopy(
  daemons: Daemons,
  routing: RcHookRouting,
  copy: RdMsgHook,
  features: readonly string[],
  log: Logger,
  label: string
): void {
  const { conn } = routingHost(daemons, routing, features)
  if (!conn) {
    log.info(`${label}: record-only copy dropped, host unavailable ${copy.msgId}`)
    return
  }
  void conn.sendMsg(copy, ROUTING_REQUEST).catch(() => {})
  log.info(`${label}: queued record-only copy ${copy.msgId} (${copy.event ?? 'unknown'})`)
}

export interface CodeHostRouterDeps {
  table: Pick<HookTable, 'getByCodeHostRepo'>
  daemons: Daemons
  limiter: Pick<HookRateLimiter, 'allow'>
  log: Logger
}

/** One delivery's inputs to the routing step. */
export interface CodeHostRoutedDelivery<E> {
  event: E
  /** The delivery's repository id in the provider's table namespace; undefined routes nothing. */
  repoId: string | undefined
  deliveryKey: string
  eventAction: string
  /** A rule's ordinary delivery for this event; undefined when its trusted identity is incomplete. */
  messageFor(rule: RcHookAssign): RdMsgHook | undefined
  /** Dispatch one selected rule's delivery; the budget has already been spent. */
  fire(rule: RcHookAssign, msg: RdMsgHook, label: string): void
}

export interface CodeHostRouter {
  /** The event's routing family, or undefined when no scope can apply. */
  readonly family: CodeHostRoutingFamily | undefined
  /** Whether a rule would be routed rather than fired for this event (mention narrowing skips such rules). */
  routed(rule: RcHookAssign): boolean
  /** Collect a routed rule that would fire as a candidate of its scope. */
  collect(rule: RcHookAssign): void
  /** An authorization still deciding candidates; scopes are routed only once every task settles. */
  track(task: Promise<unknown>): void
  /** Route every scope of the event once all tracked tasks settle; fire-and-forget. */
  routeScopes(): void
}

/** Build one delivery's router over a provider's callbacks. */
export function createCodeHostRouter<E>(
  deps: CodeHostRouterDeps,
  provider: CodeHostRoutingProvider<E>,
  delivery: CodeHostRoutedDelivery<E>
): CodeHostRouter {
  const label = `${provider.provider} ingress`
  const { deliveryKey, eventAction } = delivery
  const family = provider.eventFamily(delivery.event)
  const candidatesByScope = new Map<string, Map<string, CodeHostRouteCandidate>>()
  const tasks: Promise<unknown>[] = []

  // A routed rule spends the per-hook budget only when selected.
  const fireSelected = (rule: RcHookAssign, selection: HookRouteSelection, scope: RoutedScope): void => {
    if (!deps.limiter.allow(rule.hookId)) {
      deps.log.info(`${label}: rate-limited ${rule.hookId}:${deliveryKey} (${eventAction})`)
      return
    }
    const msg = delivery.messageFor(rule)
    if (!msg) {
      deps.log.info(`${label}: rejected incomplete identity ${rule.hookId}:${deliveryKey}`)
      return
    }
    delivery.fire(rule, { ...msg, routeSelection: { ...selection, scope } }, `routed:${selection.reason}`)
  }

  const routeScope = async (routingId: string, scopeRules: RcHookAssign[], scope: RoutedScope): Promise<void> => {
    const candidates = [...(candidatesByScope.get(routingId)?.values() ?? [])]
    const routing = scopeRules[0]?.routing ?? candidates[0]?.rule.routing
    if (!routing) return
    const hostRule = provider.hostRule(scopeRules, routing, delivery.event)
    const hostMsg = hostRule ? delivery.messageFor(hostRule) : undefined
    if (candidates.length === 0) {
      // A record-only copy on its own budget key: it never spends, or is starved by, the fire budget.
      if (!hostRule || !hostMsg || !codeHostRecordOnlyEligible(provider, hostRule, delivery.event)) return
      if (!deps.limiter.allow(`routing-record:${routingId}`)) {
        deps.log.info(`${label}: record-only copy rate-limited ${routingId}:${deliveryKey} (${eventAction})`)
        return
      }
      const copy = codeHostHostCopy(hostMsg, routing, [])
      sendCodeHostRecordOnlyCopy(deps.daemons, routing, copy, provider.hostFeatures, deps.log, label)
      return
    }
    const verdict: CodeHostHostVerdict = hostMsg
      ? await askCodeHostRoutingHost(
          deps.daemons,
          routing,
          codeHostHostCopy(hostMsg, routing, candidates),
          provider.hostFeatures
        )
      : { kind: 'unavailable', reason: 'no_host_rule' }
    if (verdict.kind === 'held') {
      deps.log.info(`${label}: routing held ${routingId}:${deliveryKey} (${verdict.reason})`)
      return
    }
    if (verdict.kind === 'unavailable') {
      deps.log.warn(`${label}: routing host unavailable ${routingId}:${deliveryKey} (${verdict.reason})`)
      const selection = hostUnavailableSelection(routing)
      for (const { rule } of candidates) fireSelected(rule, selection, scope)
      return
    }
    // Only a candidate may fire; dispatchHookFire re-reads and fences every selected rule against the captured one.
    const byHook = new Map(candidates.map((candidate) => [candidate.rule.hookId, candidate.rule]))
    for (const target of verdict.targets) {
      const rule = byHook.get(target.hookId)
      if (!rule || target.selection.routingId !== routingId) {
        deps.log.warn(`${label}: routing host named a non-candidate ${target.hookId}:${deliveryKey}`)
        continue
      }
      byHook.delete(target.hookId)
      fireSelected(rule, target.selection, scope)
    }
  }

  return {
    family,
    routed: (rule) => rule.routing !== undefined && family !== undefined,
    collect: (rule) => {
      const routing = rule.routing
      if (!routing) return
      const scope = candidatesByScope.get(routing.routingId) ?? new Map<string, CodeHostRouteCandidate>()
      scope.set(rule.hookId, { rule })
      candidatesByScope.set(routing.routingId, scope)
    },
    track: (task) => {
      tasks.push(task)
    },
    // Every scope is settled once all authorizations have: a candidate set is final only then.
    routeScopes: () => {
      void Promise.allSettled(tasks)
        .then(async () => {
          if (family === undefined || delivery.repoId === undefined) return
          const scope: RoutedScope = { repoId: delivery.repoId, family }
          const current = deps.table.getByCodeHostRepo(provider.provider, delivery.repoId)
          const scopeIds = new Set([
            ...current.flatMap((rule) => (rule.routing ? [rule.routing.routingId] : [])),
            ...candidatesByScope.keys()
          ])
          await Promise.all(
            [...scopeIds].map((routingId) =>
              routeScope(
                routingId,
                current.filter((rule) => rule.routing?.routingId === routingId),
                scope
              )
            )
          )
        })
        .catch((err) => deps.log.warn(`${label}: routing failed ${deliveryKey}: ${String(err)}`))
    }
  }
}
