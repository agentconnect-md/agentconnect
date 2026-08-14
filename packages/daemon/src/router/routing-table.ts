/**
 * The daemon's routing-ladder surface — since the activation-policy extraction
 * a thin adapter over `@agentconnect.md/activation-policy`, which owns the
 * PURE decision logic ("who does this message activate"): the arbitration
 * ladder (`routeRules`), the set selectors (`mentionedAgents`,
 * `participantAgents`, `automaticAgents`, `conversationPeers`), the
 * conversation Off/gated fence predicate, the §4.1 hop-transition gates, and
 * (since the webchat fold-in) the §5.2a webchat continuation edge
 * (`webchatContinuationDecision`).
 *
 * The daemon stays the owner of everything that is NOT pure decision: building
 * `RoutingRule`s from integrations and CP frames (routing-rule.ts), session
 * state (the `threadOwner` / participants providers), authorship VERIFICATION,
 * mute latches, the durable activation rendezvous, and dispatch. Those call
 * sites pass their facts and providers into the policy functions.
 *
 * `NormalizedMessage` structurally satisfies the policy package's
 * `ActivationMessageFacts`, and `RoutingRule` extends its `ActivationRule`
 * (routing-rule.ts), so no adaptation happens at the call sites — this module
 * exists to keep the daemon-side import path and to document the boundary.
 */
export {
  automaticAgents,
  conversationAdmitsAgent,
  conversationPeers,
  hopTransition,
  isUsableSourceDepth,
  mentionedAgents,
  participantAgents,
  routeRules,
  webchatContinuationDecision,
  type ActivationMessageFacts,
  type ActivationRule,
  type RouteVia
} from '@agentconnect.md/activation-policy'
