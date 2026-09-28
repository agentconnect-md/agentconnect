// An agent's chat APIs (shared-bot-relay.md §10.4): the protocols it can add, and the Decision gate each may carry.
import { z } from 'zod'
import { ChannelDecisionGate, DECISION_CHAIN_MAX_STEPS, decisionChainIds } from './decision.js'
import { DecisionToolDefinition } from './frames/decision.js'

// A chat API an agent accepts calls on once its owner adds it under Integrations.
export const AgentApiProtocol = z.enum(['ai-sdk-ui'])
export type AgentApiProtocol = z.infer<typeof AgentApiProtocol>
export const AGENT_API_PROTOCOLS = AgentApiProtocol.options

// A Decision gate per protocol: a turn is admitted only when the chain matches, or when it cannot be evaluated.
export const AgentApiGates = z.partialRecord(AgentApiProtocol, ChannelDecisionGate)
export type AgentApiGates = z.infer<typeof AgentApiGates>

// What AgentSpec ships: each gate with the Decisions its chain names, so admission never reads the CP.
export const AgentApiGateProjection = z.strictObject({
  gate: ChannelDecisionGate,
  definitions: z.array(DecisionToolDefinition).min(1).max(DECISION_CHAIN_MAX_STEPS)
})
export type AgentApiGateProjection = z.infer<typeof AgentApiGateProjection>
export const AgentApiGateProjections = z.partialRecord(AgentApiProtocol, AgentApiGateProjection)
export type AgentApiGateProjections = z.infer<typeof AgentApiGateProjections>

// The daemon evaluates an API turn's gate before admitting it and refuses a negative answer as `declined`.
export const API_DECISION_GATE_V1_FEATURE = 'api-decision-gate-v1'

export function apiGateDecisionIds(gates: AgentApiGates | null | undefined): string[] {
  return [...new Set(Object.values(gates ?? {}).flatMap((gate) => (gate ? decisionChainIds(gate) : [])))]
}
