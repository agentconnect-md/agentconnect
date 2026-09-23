// The relay's `rd/route` leg (message-intake.md §6): fence the host, resolve the target, forward it; per-hop dedup keeps terminal verdicts only.
import {
  DECISION_ROUTING_V1_FEATURE,
  RD_ACK_NOT_HOLDER,
  RdRouteReason,
  type RdAck,
  type RdMsg,
  type RdMsgIm,
  type RdRoute,
  type RdRouteAck,
  type WireNormalizedMessage
} from '@agentconnect.md/protocol'
import type { RouteTarget } from './bot-arbitration.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const DEDUP_MAX = 4000
/** The inner forward's bound; the host's own request timeout is longer, so a slow target reads as `retry`. */
export const ROUTE_FORWARD_TIMEOUT_MS = 5_000

export interface RouteForwarderDeps {
  ingress: {
    hostFor(botId: string, channel: string): string | undefined
    routed(botId: string, msg: WireNormalizedMessage): { decisionId: string; evaluationDaemonId: string } | undefined
    targetFor(botId: string, agentId: string, channel: string): RouteTarget | null
  }
  daemons: (daemonId: string) => RelayDaemonConnection | undefined
  sendWithRendezvous: (daemon: RelayDaemonConnection, rd: RdMsg, botId: string, context: string) => Promise<RdAck>
  log: Logger
  timeoutMs?: number
}

const RETRY_REASONS = new Set(['durability', 'draining', 'capacity', 'not_ready', 'offline'])

/** Map the target's `rd/ack` onto the host-facing verdict. */
export function routeAckFrom(deliveryId: string, daemonId: string, ack: RdAck): RdRouteAck {
  const reason = (value: string | undefined): RdRouteReason => {
    const parsed = RdRouteReason.safeParse(value)
    return parsed.success ? parsed.data : 'rejected'
  }
  if (ack.routeAdmission === 'admitted') return { deliveryId, disposition: 'admitted', daemonId }
  if (ack.routeAdmission === 'rejected') {
    return ack.recoverable
      ? { deliveryId, disposition: 'retry', reason: reason(ack.reason), daemonId }
      : { deliveryId, disposition: 'rejected', reason: reason(ack.reason), daemonId }
  }
  // No routed verdict: a transport-level refusal (duty, drain, durability) or a target that ignored the selection.
  if (ack.reason === RD_ACK_NOT_HOLDER) return { deliveryId, disposition: 'retry', reason: 'not_ready', daemonId }
  if (!ack.accepted && ack.reason && RETRY_REASONS.has(ack.reason))
    return { deliveryId, disposition: 'retry', reason: reason(ack.reason), daemonId }
  return { deliveryId, disposition: 'rejected', reason: ack.accepted ? 'rejected' : reason(ack.reason), daemonId }
}

export function createRouteForwarder(deps: RouteForwarderDeps) {
  const seen = new Map<string, RdRouteAck>()
  const timeoutMs = deps.timeoutMs ?? ROUTE_FORWARD_TIMEOUT_MS

  async function forward(fromDaemonId: string, route: RdRoute): Promise<RdRouteAck> {
    const { deliveryId, botId, payload } = route
    const nak = (disposition: 'rejected' | 'retry', reason: RdRouteReason, daemonId?: string): RdRouteAck => ({
      deliveryId,
      disposition,
      reason,
      ...(daemonId ? { daemonId } : {})
    })
    // The fence that stops a replaced host: only the daemon the CP names now may distribute.
    if (deps.ingress.hostFor(botId, payload.channel) !== fromDaemonId) {
      deps.log.info(`relay: rd/route ${deliveryId} refused — ${fromDaemonId} is not the evaluation host`)
      return nak('rejected', 'not_host')
    }
    if (deps.ingress.routed(botId, payload)?.decisionId !== route.selection.decisionId) return nak('rejected', 'stale')
    const target = deps.ingress.targetFor(botId, route.toAgentId, payload.channel)
    if (!target) return nak('rejected', 'not_member')
    const daemon = deps.daemons(target.daemonId)
    if (!daemon) return nak('retry', 'offline', target.daemonId)
    // Fail closed: an older daemon would read the selection as a plain delivery and never answer for it.
    if (!daemon.supports(DECISION_ROUTING_V1_FEATURE)) return nak('rejected', 'unsupported', target.daemonId)
    const rd: RdMsgIm = {
      source: 'im',
      agentId: target.agentId,
      sessionKey: route.sessionKey,
      msgId: `${payload.msgId}#${target.agentId}`,
      botId,
      integrationId: target.integrationId,
      chatId: payload.channel,
      payload,
      decisionId: route.selection.decisionId,
      trustedRouteVia: route.via ?? 'implicit',
      trustedRouteSelection: { ...route.selection, hostDaemonId: fromDaemonId },
      ...(route.backfill?.length ? { backfill: route.backfill } : {})
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)))
    try {
      const ack = await Promise.race([deps.sendWithRendezvous(daemon, rd, botId, `relay-route(${botId})`), timeout])
      if (ack === 'timeout') return nak('retry', 'offline', target.daemonId)
      return routeAckFrom(deliveryId, target.daemonId, ack)
    } catch (err) {
      deps.log.warn(`relay: rd/route ${deliveryId} forward to ${target.daemonId} failed: ${(err as Error).message}`)
      return nak('retry', 'offline', target.daemonId)
    } finally {
      clearTimeout(timer)
    }
  }

  return async function routeForward(fromDaemonId: string, route: RdRoute): Promise<RdRouteAck> {
    const key = `${fromDaemonId}:${route.deliveryId}`
    const prior = seen.get(key)
    if (prior) return prior
    const verdict = await forward(fromDaemonId, route)
    // A retry, and a not-host refusal the host may outgrow, are re-evaluated on the next attempt.
    if (verdict.disposition === 'retry' || verdict.reason === 'not_host') return verdict
    if (seen.size >= DEDUP_MAX) seen.clear()
    seen.set(key, verdict)
    return verdict
  }
}

export type RouteForward = ReturnType<typeof createRouteForwarder>
