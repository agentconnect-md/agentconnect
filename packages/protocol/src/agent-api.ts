// An agent's chat APIs (shared-bot-relay.md §10.4): the protocols it can add, and the Decision gate each may carry.
import { z } from 'zod'
import { ChannelDecisionGate, decisionChainIds } from './decision.js'

// A chat API an agent accepts calls on once its owner adds it under Integrations.
export const AgentApiProtocol = z.enum(['ai-sdk-ui'])
export type AgentApiProtocol = z.infer<typeof AgentApiProtocol>
export const AGENT_API_PROTOCOLS = AgentApiProtocol.options

// A Decision gate per protocol: a turn is admitted only when the chain matches, or when it cannot be evaluated.
export const AgentApiGates = z.partialRecord(AgentApiProtocol, ChannelDecisionGate)
export type AgentApiGates = z.infer<typeof AgentApiGates>

// The daemon evaluates an API turn's gate before admitting it and refuses a negative answer as `declined`.
export const API_DECISION_GATE_V1_FEATURE = 'api-decision-gate-v1'

export function apiGateDecisionIds(gates: AgentApiGates | null | undefined): string[] {
  return [...new Set(Object.values(gates ?? {}).flatMap((gate) => (gate ? decisionChainIds(gate) : [])))]
}
