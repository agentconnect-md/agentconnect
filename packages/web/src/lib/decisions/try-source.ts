// Where a gate's Try runs: a live conversation, or an agent's chat API (decisions.md §9.3).

import type { ApiGateTryState, ChannelDecisionGate, ConversationTryState } from '@agentconnect.md/protocol/decision'
import type {
  DecisionApi,
  DecisionConversationRef,
  DecisionGatePreviewResult
} from '@agentconnect.md/protocol/decision-api'
import { previewAgentApiGate, type AgentApiProtocol } from '@/lib/api'
import { conversationSample } from './try-state'

export type GateTrySource =
  | {
      lane: 'conversation'
      preview(gate: ChannelDecisionGate, state: ConversationTryState): Promise<DecisionGatePreviewResult>
    }
  | { lane: 'api'; preview(gate: ChannelDecisionGate, state: ApiGateTryState): Promise<DecisionGatePreviewResult> }

export function conversationGateTry(api: DecisionApi, ref: DecisionConversationRef): GateTrySource {
  return {
    lane: 'conversation',
    preview: (gate, state) => api.previewGate(ref, { decisionBinding: gate, state: conversationSample(state) })
  }
}

// The mock API answers an API gate as a conversation addressed `api:<agent>:<protocol>`, like its evaluations.
export function apiGateTry(
  api: DecisionApi,
  orgId: string,
  agentId: string,
  protocol: AgentApiProtocol
): GateTrySource {
  const lane = `api:${agentId}:${protocol}`
  return {
    lane: 'api',
    preview: (gate, state) =>
      api.mode === 'mock'
        ? api.previewGate(
            { integrationId: lane, channelId: lane },
            {
              decisionBinding: gate,
              state: { history: [], currentMessage: { text: state.currentMessage.text.trim() } }
            }
          )
        : previewAgentApiGate(agentId, protocol, { gate, state }, orgId)
  }
}
