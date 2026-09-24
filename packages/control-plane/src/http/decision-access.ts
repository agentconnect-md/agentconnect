import type { FastifyRequest } from 'fastify'
import {
  DECISION_TRIGGER_V1_FEATURE,
  OWNER_DEFAULT_DECISION_V1_FEATURE,
  manifestFor,
  DECISION_CHAIN_V1_FEATURE,
  decisionChainIds,
  type DecisionChainStep,
  type DecisionDefinition
} from '@agentconnect.md/protocol'
import { canView } from '../authorization/policy.js'
import { decisionTriggerSupported } from '../domain/decision-trigger-features.js'
import type { AgentRecord, BotRecord, IntegrationChannelRecord, IntegrationRecord } from '../persistence/ports.js'
import { conversationOwnerRow, pickConversationOwner } from '../orchestrator/httpBot.js'
import type { OrgId } from '../domain/ids.js'
import { decisionGateState, decisionRoutingState, type DecisionDisabledReason } from '../orchestrator/decisionBundle.js'
import type { RoutingDescription } from '../orchestrator/httpBot.js'
import type { HttpDeps } from './deps.js'
import { ctxOf, orgOf } from './rbac.js'

export type DecisionGateReadiness = {
  status: 'ready' | 'pending_sync' | 'needs_review' | 'daemon_offline' | 'unsupported'
  reason?: string
}

/** The Decision a caller may use: same org and visible to them, else null (a 404, never a name leak). */
export async function visibleDecision(
  deps: Pick<HttpDeps, 'repos'>,
  req: FastifyRequest,
  id: string
): Promise<DecisionDefinition | null> {
  const row = await deps.repos.decision.get(orgOf(req), id)
  return row && canView(row, ctxOf(req)) ? row : null
}

export async function visibleDecisionChain(
  deps: Pick<HttpDeps, 'repos'>,
  req: FastifyRequest,
  chain: DecisionChainStep & { steps?: readonly DecisionChainStep[] }
): Promise<Map<string, DecisionDefinition> | null> {
  const definitions = await Promise.all(decisionChainIds(chain).map((id) => visibleDecision(deps, req, id)))
  return definitions.some((d) => !d) ? null : new Map(definitions.map((d) => [d!.id, d!]))
}

/** The gate's consumer: a shared bot's compiled conversation owner, else the URL install's agent; null when unresolved. */
export async function gateConsumer(
  deps: Pick<HttpDeps, 'repos'>,
  orgId: OrgId,
  integration: IntegrationRecord,
  bot: Pick<BotRecord, 'id' | 'transport'>,
  channelId: string
): Promise<{ agent: AgentRecord; integration: IntegrationRecord; row: IntegrationChannelRecord } | null> {
  if (bot.transport === 'http') {
    const [installs, rows] = await Promise.all([
      deps.repos.integration.listForBot(bot.id),
      deps.repos.integrationChannel.listForBot(bot.id)
    ])
    const conversation = rows.filter((row) => row.channelId === channelId)
    const owner = pickConversationOwner(installs, conversation)
    const row = conversationOwnerRow(owner, conversation)
    if (!owner || !row || owner.orgId !== orgId) return null
    const agent = await deps.repos.agent.get(orgId, owner.agentId)
    return agent ? { agent, integration: owner, row } : null
  }
  const [row, agent] = await Promise.all([
    deps.repos.integrationChannel
      .listForIntegration(integration.id)
      .then((rows) => rows.find((candidate) => candidate.channelId === channelId)),
    deps.repos.agent.get(orgId, integration.agentId)
  ])
  return row && agent ? { agent, integration, row } : null
}

/** Whether every consumer on this integration's route understands By decision (decisions.md §7.1). */
export async function decisionGateReadiness(
  deps: Pick<HttpDeps, 'placementResolver' | 'daemonConns' | 'httpBot'>,
  agent: AgentRecord,
  bot: Pick<BotRecord, 'transport' | 'platform'>,
  chained = false
): Promise<DecisionGateReadiness> {
  const ready = (await deps.placementResolver.routableDaemons(agent))
    .map((daemonId) => deps.daemonConns.get(daemonId))
    .filter((conn) => conn?.state === 'READY')
  if (ready.length === 0) return { status: 'daemon_offline', reason: 'No daemon serving this agent is connected.' }
  if (
    ready.some(
      (conn) =>
        !decisionTriggerSupported(conn?.capabilities?.features) ||
        (chained && !conn?.capabilities?.features?.includes(DECISION_CHAIN_V1_FEATURE))
    )
  )
    return { status: 'unsupported', reason: 'Upgrade the daemon to use By decision.' }
  if (bot.transport === 'http') {
    const relays = deps.httpBot.relayFeatureSupport(DECISION_TRIGGER_V1_FEATURE)
    if (relays.connected === 0) return { status: 'pending_sync', reason: 'No relay is connected.' }
    if (relays.missing > 0) return { status: 'unsupported', reason: 'Upgrade the relay to use By decision.' }
    // An ownerAsDefault conversation's decision route is held on a relay that cannot seat it as the default.
    if (
      manifestFor(bot.platform).ownerAsDefault &&
      deps.httpBot.relayFeatureSupport(OWNER_DEFAULT_DECISION_V1_FEATURE).missing > 0
    )
      return { status: 'unsupported', reason: 'Upgrade the relay to use By decision.' }
  }
  return { status: 'ready' }
}

/** A routed conversation's readiness, read from the bot's routing plan. */
export function routedChannelReadiness(
  description: Pick<RoutingDescription, 'channels' | 'readiness'>,
  channelId: string
): DecisionGateReadiness {
  const r = description.channels.find((c) => c.channelId === channelId)?.readiness ?? description.readiness
  const status = r.status === 'missing_credentials' || r.status === 'insufficient_credits' ? 'unsupported' : r.status
  return { status, ...(r.reason ? { reason: r.reason } : {}) }
}

/** The channel DTO's Decision view: name only when the caller can view it, per-row review state over readiness. */
export function decisionChannelView(
  row: IntegrationChannelRecord,
  names: ReadonlyMap<string, string>,
  readiness: DecisionGateReadiness | undefined
): {
  consumer: 'gate' | 'shared_bot_routing'
  id: string
  name: string | null
  enabled: boolean
  disabledReason?: DecisionDisabledReason
  readiness: DecisionGateReadiness
} | null {
  const routed = decisionRoutingState(row)
  if (routed) {
    const effective: DecisionGateReadiness =
      routed.disabledReason === 'needs_review'
        ? { status: 'needs_review', reason: 'The routing configuration needs review.' }
        : (readiness ?? { status: 'pending_sync' })
    return {
      consumer: 'shared_bot_routing',
      id: routed.decisionId ?? '',
      name: routed.decisionId ? (names.get(routed.decisionId) ?? null) : null,
      enabled: routed.enabled && effective.status === 'ready',
      ...(routed.disabledReason ? { disabledReason: routed.disabledReason } : {}),
      readiness: effective
    }
  }
  const state = decisionGateState(row)
  if (!state?.gate) return null
  const effective: DecisionGateReadiness =
    state.disabledReason === 'needs_review'
      ? { status: 'needs_review', reason: 'The Decision changed; review this condition.' }
      : (readiness ?? { status: 'pending_sync' })
  return {
    consumer: 'gate',
    id: state.gate.decisionId,
    name: names.get(state.gate.decisionId) ?? null,
    enabled: state.enabled && effective.status === 'ready',
    ...(state.disabledReason ? { disabledReason: state.disabledReason } : {}),
    readiness: effective
  }
}
