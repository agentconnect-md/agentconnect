import {
  DECISION_CHAIN_V1_FEATURE,
  decisionChainIds,
  DECISION_ROUTING_FORWARD_V1_FEATURE,
  DECISION_ROUTING_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  EMPTY_DECISION_BUNDLE,
  OWNER_DEFAULT_DECISION_V1_FEATURE,
  type AttributedRoute,
  type IntegrationSpec,
  type RcRoutedConversation
} from '@agentconnect.md/protocol'
import { advertises } from './daemon-features.js'

// A `decision` BindMatch is a new union arm, so it makes a whole frame undecodable on a peer that predates it.

/** Whether a daemon or relay understands By decision candidates. */
export function decisionTriggerSupported(features: readonly string[] | undefined): boolean {
  return advertises(features, [DECISION_TRIGGER_V1_FEATURE])
}

/** Whether a daemon or relay understands shared-bot routing and never treats a routed conversation as Any. */
export function decisionRoutingSupported(features: readonly string[] | undefined): boolean {
  return advertises(features, [DECISION_ROUTING_V1_FEATURE])
}

/** Whether a relay seats an ownerAsDefault assignment's decision route as the channel default. */
export function ownerDefaultDecisionSupported(features: readonly string[] | undefined): boolean {
  return advertises(features, [OWNER_DEFAULT_DECISION_V1_FEATURE])
}

/** Whether a relay both parses routed conversations and forwards them to their evaluation host. */
export function relayRoutingSupported(features: readonly string[] | undefined): boolean {
  return advertises(features, [DECISION_ROUTING_V1_FEATURE, DECISION_ROUTING_FORWARD_V1_FEATURE])
}

/** A daemon without decision-routing-v1: routed bindings, the host config and routed decision rules go, their channels mute. */
function stripRoutingForPeer(spec: IntegrationSpec): IntegrationSpec {
  const decisions = spec.core.decisions ?? EMPTY_DECISION_BUNDLE
  const routed = new Set(
    decisions.bindings.filter((b) => b.consumer.type === 'shared_bot_routing').map((b) => b.channel)
  )
  if (routed.size === 0 && !decisions.sharedBotRouting) return spec
  const bindings = decisions.bindings.filter((b) => b.consumer.type !== 'shared_bot_routing')
  const gateIds = new Set(bindings.flatMap((b) => (b.consumer.type === 'gate' ? decisionChainIds(b.consumer) : [])))
  return {
    ...spec,
    core: {
      ...spec.core,
      bindRules: spec.core.bindRules.filter(
        (r) => !(r.match.kind === 'decision' && r.channel !== undefined && routed.has(r.channel))
      ),
      mutedChannels: [...new Set([...spec.core.mutedChannels, ...routed])],
      decisions: { bindings, definitions: decisions.definitions.filter((d) => gateIds.has(d.id)) }
    }
  }
}

function stripChainsForPeer(spec: IntegrationSpec): IntegrationSpec {
  const bundle = spec.core.decisions
  if (!bundle) return spec
  const held = new Set(
    bundle.bindings.filter((b) => b.consumer.type === 'gate' && b.consumer.steps?.length).map((b) => b.channel)
  )
  if (bundle.sharedBotRouting?.config.steps?.length)
    for (const channel of bundle.sharedBotRouting.channels) held.add(channel.channel)
  if (!held.size) return spec
  const bindings = bundle.bindings.filter((b) => !held.has(b.channel))
  const sharedBotRouting = bundle.sharedBotRouting?.config.steps?.length ? undefined : bundle.sharedBotRouting
  const ids = new Set([
    ...bindings.flatMap((b) => (b.consumer.type === 'gate' ? decisionChainIds(b.consumer) : [])),
    ...decisionChainIds(sharedBotRouting?.config)
  ])
  return {
    ...spec,
    core: {
      ...spec.core,
      mutedChannels: [...new Set([...spec.core.mutedChannels, ...held])],
      bindRules: spec.core.bindRules.filter((r) => !(r.match.kind === 'decision' && r.channel && held.has(r.channel))),
      decisions: {
        bindings,
        definitions: bundle.definitions.filter((d) => ids.has(d.id)),
        ...(sharedBotRouting ? { sharedBotRouting } : {})
      }
    }
  }
}

/** The spec a daemon may receive: routing stripped without routing-v1, every decision rule without trigger-v1, held Off. */
export function encodeIntegrationSpecForPeer(
  spec: IntegrationSpec,
  features: readonly string[] | undefined
): IntegrationSpec {
  if (!features?.includes(DECISION_CHAIN_V1_FEATURE)) spec = stripChainsForPeer(spec)
  if (!decisionRoutingSupported(features)) spec = stripRoutingForPeer(spec)
  if (decisionTriggerSupported(features)) return spec
  const decisions = spec.core.decisions ?? EMPTY_DECISION_BUNDLE
  const held = [
    ...decisions.bindings.map((b) => b.channel),
    ...spec.core.bindRules.filter((r) => r.match.kind === 'decision' && r.channel).map((r) => r.channel!)
  ]
  if (held.length === 0 && decisions.definitions.length === 0) return spec
  return {
    ...spec,
    core: {
      ...spec.core,
      bindRules: spec.core.bindRules.filter((r) => r.match.kind !== 'decision'),
      mutedChannels: [...new Set([...spec.core.mutedChannels, ...held])],
      decisions: EMPTY_DECISION_BUNDLE
    }
  }
}

/** The relay twin: routed routes go without routing-v1 and forward-v1, every decision route without trigger-v1, all muted. */
export function encodeRelayRoutesForPeer<
  T extends { routes: AttributedRoute[]; mutedChannels: string[]; routedConversations?: RcRoutedConversation[] }
>(frame: T, features: readonly string[] | undefined, opts: { ownerAsDefault?: boolean } = {}): T {
  // A relay that would rank an ownerAsDefault decision route first gets none, and the conversation holds.
  if (opts.ownerAsDefault && !ownerDefaultDecisionSupported(features)) frame = stripDecisionRoutes(frame)
  if (!relayRoutingSupported(features) && frame.routedConversations?.length) {
    // A relay that cannot forward to the host would still deliver the decision route gate-style, so the route goes too.
    const routed = new Set(frame.routedConversations.map((c) => c.channel))
    frame = {
      ...frame,
      routes: frame.routes.filter(
        (r) => !(r.match.kind === 'decision' && r.scope?.channel && routed.has(r.scope.channel))
      ),
      mutedChannels: [...new Set([...frame.mutedChannels, ...routed])],
      routedConversations: []
    }
  }
  if (decisionTriggerSupported(features)) return frame
  return stripDecisionRoutes(frame)
}

/** Every decision route removed and its conversation muted, never delivered as Any. */
function stripDecisionRoutes<T extends { routes: AttributedRoute[]; mutedChannels: string[] }>(frame: T): T {
  const decisionRoutes = frame.routes.filter((r) => r.match.kind === 'decision')
  if (decisionRoutes.length === 0) return frame
  const held = decisionRoutes.flatMap((r) => (r.scope?.channel ? [r.scope.channel] : []))
  return {
    ...frame,
    routes: frame.routes.filter((r) => r.match.kind !== 'decision'),
    mutedChannels: [...new Set([...frame.mutedChannels, ...held])]
  }
}
