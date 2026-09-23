import {
  decisionRoutingIssues,
  supportsDecision,
  type DecisionValidationIssue,
  type SharedBotDecisionRouting,
  type SharedBotRoutingProjection
} from '@agentconnect.md/protocol'
import type { BotDecisionRoutingRecord } from '../persistence/ports.js'
import type { DecisionDisabledReason } from './decisionBundle.js'

/** Why a routed conversation is held (muted, never Any) instead of projected. */
export type RoutingHold =
  'paused' | 'needs_review' | 'access_revoked' | 'host_offline' | 'host_unsupported' | 'owner_unavailable'

export interface EvaluationHost {
  daemonId: string
  source: 'default_agent' | 'earliest_candidate'
}

/** message-intake.md §6: the live default daemon, else the earliest-created live candidate; liveness only. */
export function resolveEvaluationHost(input: {
  defaultDaemonId?: string | undefined
  candidateDaemonIds: readonly string[]
  live: (daemonId: string) => boolean
  createdAt: (daemonId: string) => number | undefined
}): EvaluationHost | null {
  if (input.defaultDaemonId && input.live(input.defaultDaemonId))
    return { daemonId: input.defaultDaemonId, source: 'default_agent' }
  const ordered = [...new Set(input.candidateDaemonIds)]
    .filter((id) => input.live(id))
    .sort((a, b) => {
      const at = input.createdAt(a) ?? Number.POSITIVE_INFINITY
      const bt = input.createdAt(b) ?? Number.POSITIVE_INFINITY
      return at === bt ? (a < b ? -1 : a > b ? 1 : 0) : at - bt
    })
  return ordered[0] ? { daemonId: ordered[0], source: 'earliest_candidate' } : null
}

export interface RoutingConfigState {
  executable: boolean
  disabledReason?: Extract<DecisionDisabledReason, 'needs_review' | 'access_revoked' | 'paused'>
  issues: DecisionValidationIssue[]
}

/** Whether the bot's stored router can execute: review state, rule validity, and every target still connected. */
export function routingConfigState(
  record: BotDecisionRoutingRecord | null,
  memberAgentIds: ReadonlySet<string>,
  botShared: boolean
): RoutingConfigState {
  if (!record)
    return {
      executable: false,
      disabledReason: 'needs_review',
      issues: [{ path: [], message: 'Save the routing configuration again.' }]
    }
  if (!botShared)
    return {
      executable: false,
      disabledReason: 'needs_review',
      issues: [{ path: [], message: 'Routing requires a shared bot.' }]
    }
  const definition = record.definition
  if (!definition || definition.id !== record.config.decisionId)
    return {
      executable: false,
      disabledReason: 'access_revoked',
      issues: [{ path: ['decisionId'], message: 'The Decision is unavailable.' }]
    }
  const issues: DecisionValidationIssue[] = [...decisionRoutingIssues(definition.question, record.config)]
  if (record.needsReview) issues.push({ path: [], message: 'The Decision changed; review the routing rules.' })
  if (!supportsDecision(definition))
    issues.push({ path: ['decisionId'], message: 'The Decision model does not support this question type.' })
  record.config.rules.forEach((rule, index) => {
    if (rule.action.type === 'agent' && !memberAgentIds.has(rule.action.agentId))
      issues.push({ path: ['rules', index, 'action'], message: 'Choose an agent connected to this bot.' })
  })
  if (issues.length > 0) return { executable: false, disabledReason: 'needs_review', issues }
  if (!record.config.enabled) return { executable: false, disabledReason: 'paused', issues: [] }
  return { executable: true, issues: [] }
}

/** One routed conversation's compile input. */
export interface RoutedConversationInput {
  channel: string
  /** The conversation's resolved default agent (its placed owner), absent when it is not placed. */
  defaultAgentId?: string | undefined
  /** Daemons serving this conversation's candidate agents: placed rule targets plus the resolved default. */
  candidateDaemonIds: readonly string[]
  /** A row-level refusal (a direct conversation, an unreadable binding) that holds it whatever the config says. */
  rowHold?: RoutingHold | undefined
}

export interface RoutedConversationPlan {
  channel: string
  decisionId: string
  evaluationDaemonId: string | null
  hostSource: EvaluationHost['source'] | null
  defaultAgentId?: string
  hold: RoutingHold | null
}

/** Plan every routed conversation: its host and whether it is held (first reason wins). */
export function planRoutedConversations(input: {
  config: Pick<SharedBotDecisionRouting, 'decisionId'>
  state: RoutingConfigState
  conversations: readonly RoutedConversationInput[]
  defaultDaemonId?: string | undefined
  live: (daemonId: string) => boolean
  createdAt: (daemonId: string) => number | undefined
  hostSupported: (daemonId: string) => boolean
}): RoutedConversationPlan[] {
  return input.conversations.map((c) => {
    const host = resolveEvaluationHost({
      defaultDaemonId: input.defaultDaemonId,
      candidateDaemonIds: c.candidateDaemonIds,
      live: input.live,
      createdAt: input.createdAt
    })
    const hold: RoutingHold | null = !input.state.executable
      ? (input.state.disabledReason ?? 'needs_review')
      : (c.rowHold ??
        (c.defaultAgentId === undefined
          ? 'owner_unavailable'
          : !host
            ? 'host_offline'
            : !input.hostSupported(host.daemonId)
              ? 'host_unsupported'
              : null))
    return {
      channel: c.channel,
      decisionId: input.config.decisionId,
      evaluationDaemonId: host?.daemonId ?? null,
      hostSource: host?.source ?? null,
      ...(c.defaultAgentId ? { defaultAgentId: c.defaultAgentId } : {}),
      hold
    }
  })
}

/** The bundle projection for one daemon: only the executable conversations it hosts, else undefined. */
export function sharedBotRoutingFor(
  plan: readonly RoutedConversationPlan[],
  routing: { botId: string; config: SharedBotDecisionRouting },
  daemonId: string
): SharedBotRoutingProjection | undefined {
  const channels = plan
    .filter((entry) => entry.hold === null && entry.evaluationDaemonId === daemonId)
    .map((entry) => ({
      channel: entry.channel,
      ...(entry.defaultAgentId ? { defaultAgentId: entry.defaultAgentId } : {})
    }))
  return channels.length > 0 ? { botId: routing.botId, config: routing.config, channels } : undefined
}
