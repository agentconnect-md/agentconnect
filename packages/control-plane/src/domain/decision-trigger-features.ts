import {
  DECISION_TRIGGER_V1_FEATURE,
  EMPTY_DECISION_BUNDLE,
  type AttributedRoute,
  type IntegrationSpec
} from '@agentconnect.md/protocol'
import { advertises } from './daemon-features.js'

// A `decision` BindMatch is a new union arm, so it makes a whole frame undecodable on a peer that predates it.

/** Whether a daemon or relay understands By decision candidates. */
export function decisionTriggerSupported(features: readonly string[] | undefined): boolean {
  return advertises(features, [DECISION_TRIGGER_V1_FEATURE])
}

/** The spec a daemon without decision-trigger-v1 may receive: decision rules stripped, their conversations held Off. */
export function encodeIntegrationSpecForPeer(
  spec: IntegrationSpec,
  features: readonly string[] | undefined
): IntegrationSpec {
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

/** The relay twin: drop decision routes and mute their conversations for a relay without decision-trigger-v1. */
export function encodeRelayRoutesForPeer<T extends { routes: AttributedRoute[]; mutedChannels: string[] }>(
  frame: T,
  features: readonly string[] | undefined
): T {
  if (decisionTriggerSupported(features)) return frame
  const decisionRoutes = frame.routes.filter((r) => r.match.kind === 'decision')
  if (decisionRoutes.length === 0) return frame
  const held = decisionRoutes.flatMap((r) => (r.scope?.channel ? [r.scope.channel] : []))
  return {
    ...frame,
    routes: frame.routes.filter((r) => r.match.kind !== 'decision'),
    mutedChannels: [...new Set([...frame.mutedChannels, ...held])]
  }
}
