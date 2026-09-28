// An agent's chat APIs (shared-bot-relay.md §10.4): the protocols it can add, and the Decision gate each may carry.
import { z } from 'zod'
import {
  ChannelDecisionGate,
  DECISION_CHAIN_MAX_STEPS,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage,
  decisionChainIds
} from './decision.js'
import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionToolDefinition
} from './frames/decision.js'
import { encodedBytes } from './wire-slice.js'

// A chat API an agent accepts calls on once its owner adds it under Integrations.
export const AgentApiProtocol = z.enum(['ai-sdk-ui', 'ag-ui'])
export type AgentApiProtocol = z.infer<typeof AgentApiProtocol>
export const AGENT_API_PROTOCOLS = AgentApiProtocol.options
// A protocol named on a frame a daemon parses: a string, so a newer peer's protocol never fails an older daemon's decode.
export const AgentApiProtocolName = z.string().min(1).max(64)

// The daemon takes AG-UI turns and gates; it advertises this to the CP and on `rd/hello`, and neither sends it one without.
export const API_AG_UI_V1_FEATURE = 'api-ag-ui-v1'
// The daemon feature a protocol needs beyond the chat API itself; `ai-sdk-ui` shipped with it.
export const AGENT_API_PROTOCOL_FEATURE: Readonly<Partial<Record<AgentApiProtocol, string>>> = {
  'ag-ui': API_AG_UI_V1_FEATURE
}

// A Decision gate per protocol: a turn is admitted only when the chain matches, or when it cannot be evaluated.
export const AgentApiGates = z.partialRecord(AgentApiProtocol, ChannelDecisionGate)
export type AgentApiGates = z.infer<typeof AgentApiGates>

// What AgentSpec ships: each gate with the Decisions its chain names, so admission never reads the CP.
export const AgentApiGateProjection = z.strictObject({
  gate: ChannelDecisionGate,
  definitions: z.array(DecisionToolDefinition).min(1).max(DECISION_CHAIN_MAX_STEPS)
})
export type AgentApiGateProjection = z.infer<typeof AgentApiGateProjection>
export const AgentApiGateProjections = z.record(AgentApiProtocolName, AgentApiGateProjection)
export type AgentApiGateProjections = z.infer<typeof AgentApiGateProjections>

// The daemon evaluates an API turn's gate before admitting it and refuses a negative answer as `declined`.
export const API_DECISION_GATE_V1_FEATURE = 'api-decision-gate-v1'

export function apiGateDecisionIds(gates: AgentApiGates | null | undefined): string[] {
  return [...new Set(Object.values(gates ?? {}).flatMap((gate) => (gate ? decisionChainIds(gate) : [])))]
}

// The peer records each API gate verdict and answers decision/api-gate-evaluations and decision/api-gate-evaluation.
export const API_GATE_EVALUATIONS_V1_FEATURE = 'api-gate-evaluations-v1'

const ApiGateLane = { agentId: z.string().uuid(), protocol: AgentApiProtocolName }
export const ApiGateEvaluationsRequest = z.strictObject({
  ...ApiGateLane,
  decisionId: z.string().uuid().optional(),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type ApiGateEvaluationsRequest = z.infer<typeof ApiGateEvaluationsRequest>
export type ApiGateEvaluationsRequestInput = z.input<typeof ApiGateEvaluationsRequest>
export const ApiGateEvaluationsReply = DecisionEvaluationRecordPage.refine(
  (page) => encodedBytes(page) <= DECISION_LIST_MAX_BYTES,
  { message: 'The evaluation page must fit within 32 KiB.' }
)
export type ApiGateEvaluationsReply = z.infer<typeof ApiGateEvaluationsReply>
export const ApiGateEvaluationRequest = z.strictObject({ ...ApiGateLane, seq: z.number().int().positive() })
export type ApiGateEvaluationRequest = z.infer<typeof ApiGateEvaluationRequest>
export const ApiGateEvaluationReply = z
  .strictObject({ evaluation: DecisionEvaluationRecordDetail.nullable() })
  .refine((reply) => encodedBytes(reply) <= DECISION_EVALUATION_DETAIL_MAX_BYTES, {
    message: 'The evaluation detail must fit within 64 KiB.'
  })
export type ApiGateEvaluationReply = z.infer<typeof ApiGateEvaluationReply>
