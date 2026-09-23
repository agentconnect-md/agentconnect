import {
  decisionConditionIssues,
  type ChannelDecisionGate,
  type DecisionBundle,
  type DecisionBundleBinding,
  type DecisionBundleDefinition
} from '@agentconnect.md/protocol'
import type { ChannelActivation, IntegrationChannelRecord } from '../persistence/ports.js'

type DecisionChannel = Pick<
  IntegrationChannelRecord,
  | 'channelId'
  | 'kind'
  | 'trigger'
  | 'decisionBinding'
  | 'decisionNeedsReview'
  | 'decisionDefinition'
  | 'decisionRouting'
>

export type DecisionDisabledReason = NonNullable<DecisionBundleBinding['disabledReason']>

/** One By decision gate row's projected state; null for any other trigger or consumer. */
export interface DecisionGateState {
  gate: ChannelDecisionGate | null
  definition: DecisionBundleDefinition | null
  enabled: boolean
  disabledReason?: DecisionDisabledReason
}

/** One shared-bot router row's projected state, read through the bot's record; null for any other consumer. */
export interface DecisionRoutingState {
  decisionId: string | null
  enabled: boolean
  disabledReason?: DecisionDisabledReason
}

/** The row's current trigger write, so a replication or backfill carries the binding along with the trigger. */
export function activationOf(
  row: Pick<IntegrationChannelRecord, 'trigger' | 'decisionBinding' | 'decisionNeedsReview'>
): ChannelActivation {
  if (row.trigger !== 'decision') return { trigger: row.trigger }
  // An unparseable binding cannot be replicated; Off is the fail-closed stand-in.
  if (!row.decisionBinding) return { trigger: 'off' }
  if (row.decisionBinding.type === 'shared_bot_routing')
    return { trigger: 'decision', decisionBinding: row.decisionBinding, decisionNeedsReview: false }
  return { trigger: 'decision', decisionBinding: row.decisionBinding, decisionNeedsReview: row.decisionNeedsReview }
}

/** Whether a row is bound to its bot's shared router. */
export function isRoutedChannel(c: Pick<IntegrationChannelRecord, 'trigger' | 'decisionBinding'>): boolean {
  return c.trigger === 'decision' && c.decisionBinding?.type === 'shared_bot_routing'
}

/** Whether a By decision gate row executes, and why not when it does not (decisions.md §6.1, §7.1). */
export function decisionGateState(c: DecisionChannel): DecisionGateState | null {
  if (c.trigger !== 'decision') return null
  if (c.decisionBinding?.type === 'shared_bot_routing') return null
  const gate = c.decisionBinding
  const definition = c.decisionDefinition
  if (!gate || !definition || definition.id !== gate.decisionId)
    return { gate, definition, enabled: false, disabledReason: 'access_revoked' }
  if (c.decisionNeedsReview || decisionConditionIssues(definition.question, gate.when).length > 0)
    return { gate, definition, enabled: false, disabledReason: 'needs_review' }
  // By decision applies to group conversations only; a 1:1 DM row never executes a gate.
  if (c.kind === 'im') return { gate, definition, enabled: false }
  return { gate, definition, enabled: true }
}

/** Whether a router row may take part in routing; per-channel host and target readiness are the compile's. */
export function decisionRoutingState(c: DecisionChannel): DecisionRoutingState | null {
  if (!isRoutedChannel(c)) return null
  const routing = c.decisionRouting
  if (!routing) return { decisionId: null, enabled: false, disabledReason: 'needs_review' }
  if (routing.needsReview || !routing.botShared)
    return { decisionId: routing.decisionId, enabled: false, disabledReason: 'needs_review' }
  if (!routing.enabled) return { decisionId: routing.decisionId, enabled: false, disabledReason: 'paused' }
  if (c.kind === 'im') return { decisionId: routing.decisionId, enabled: false }
  return { decisionId: routing.decisionId, enabled: true }
}

/** The complete Decision bundle for an integration: one binding per decision row, definitions deduplicated. */
export function decisionBundleOf(channels: readonly DecisionChannel[]): DecisionBundle {
  const bindings: DecisionBundleBinding[] = []
  const definitions = new Map<string, DecisionBundleDefinition>()
  for (const c of channels) {
    const routed = decisionRoutingState(c)
    if (routed) {
      // The router's definition travels only to the evaluation host (§7.1), never on a member's base spec.
      bindings.push({
        channel: c.channelId,
        consumer: { type: 'shared_bot_routing' },
        enabled: routed.enabled,
        ...(routed.disabledReason ? { disabledReason: routed.disabledReason } : {})
      })
      continue
    }
    const state = decisionGateState(c)
    if (!state?.gate) continue
    bindings.push({
      channel: c.channelId,
      consumer: state.gate,
      enabled: state.enabled,
      ...(state.disabledReason ? { disabledReason: state.disabledReason } : {})
    })
    // Disabled bindings keep their definition too: Stage 3b's repair evidence reads it.
    if (state.definition && !definitions.has(state.definition.id))
      definitions.set(state.definition.id, state.definition)
  }
  return { bindings, definitions: [...definitions.values()] }
}

/** The enabled gates, one per conversation. */
export function enabledDecisionGates(
  channels: readonly DecisionChannel[]
): Array<{ channel: string; decisionId: string }> {
  const out: Array<{ channel: string; decisionId: string }> = []
  for (const c of channels) {
    const state = decisionGateState(c)
    if (state?.enabled && state.gate) out.push({ channel: c.channelId, decisionId: state.gate.decisionId })
  }
  return out
}

/** By decision conversations that must be held: never Any, so muted until repaired. */
export function heldDecisionChannels(channels: readonly DecisionChannel[]): string[] {
  return channels
    .filter((c) => {
      if (c.trigger !== 'decision') return false
      const routed = decisionRoutingState(c)
      if (routed) return !routed.enabled
      // A binding that no longer parses is neither a gate nor a router, and must never read as Any.
      return decisionGateState(c)?.enabled !== true
    })
    .map((c) => c.channelId)
}
