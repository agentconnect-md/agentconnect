import type {
  ChannelDecisionBinding,
  DecisionChannelSettings,
  DecisionDefinition,
  DecisionDraft,
  DecisionDraftInput,
  DecisionEvaluation,
  DecisionQuestion,
  DecisionValidationIssue,
  SharedBotDecisionRouting
} from './decision.js'

export interface DecisionReadiness {
  status:
    | 'ready'
    | 'pending_sync'
    | 'needs_review'
    | 'missing_credentials'
    | 'daemon_offline'
    | 'unsupported'
    | 'insufficient_credits'
  issues?: DecisionValidationIssue[]
}

// Provider configuration is daemon-owned; this catalog contains no credentials or endpoint editor.
export interface DecisionProviderOption {
  id: string
  daemonId: string
  name: string
  kind: string
  source: 'byok' | 'ac_credits'
  readiness: DecisionReadiness
  models: Array<{ id: string; label: string; questionTypes: DecisionQuestion['type'][] }>
}

export interface DecisionUsage {
  kind: 'gate' | 'shared_bot_routing'
  id: string
  label: string
}

export interface DecisionDetail {
  decision: DecisionDefinition
  usages: DecisionUsage[]
}

export type DecisionSummary = DecisionDefinition & { usageCount: number }

export interface DecisionChannel {
  id: string
  botId: string
  name: string
  kind: 'channel' | 'dm'
  agentId: string
  daemonId: string
  settings: DecisionChannelSettings
  readiness: DecisionReadiness
}

export interface DecisionBot {
  id: string
  name: string
  shared: boolean
  daemonId: string
  defaultAgentId: string
  agents: Array<{ id: string; name: string; available: boolean }>
}

export interface DecisionRoutingSave {
  config: SharedBotDecisionRouting
  channelIds: string[]
  removals: Array<{ channelId: string; settings: Exclude<DecisionChannelSettings, { trigger: 'decision' }> }>
}

export interface DecisionRoutingDetail {
  botId: string
  config: SharedBotDecisionRouting | null
  channelIds: string[]
  readiness: DecisionReadiness
}

export type DecisionTargetConstraint = { type: 'new' } | { type: 'mention' | 'thread'; agentIds: string[] }

export interface DecisionPreviewInput {
  decision: DecisionDraftInput
  daemonId: string
  state: Record<string, unknown>
  consumer:
    | { type: 'none' }
    | {
        type: 'gate'
        channelId: string
        when: Extract<ChannelDecisionBinding, { type: 'gate' }>['when']
        targets?: DecisionTargetConstraint
      }
    | {
        type: 'shared_bot_routing'
        botId: string
        channelId: string
        channelIds: string[]
        config: SharedBotDecisionRouting
        targets: DecisionTargetConstraint
      }
}

export interface DecisionPreviewResult {
  mode: 'mock' | 'live'
  readiness: DecisionReadiness
  evaluation: DecisionEvaluation | null
  consumer: null | {
    outcome: 'activate' | 'skip' | 'continue' | 'blocked' | 'not_applied'
    notAppliedReason?: 'off' | 'outside_scope' | 'paused'
    matchedRuleIds: string[]
    matchedKeys: string[]
    matchedAgentIds: string[]
    effectiveAgentIds: string[]
    unavailableAgentIds: string[]
    usedOtherwise: boolean
    targetConstraint: DecisionTargetConstraint
  }
}

export interface DecisionApi {
  listProviders(daemonId?: string): Promise<DecisionProviderOption[]>
  listDecisions(): Promise<DecisionSummary[]>
  getDecision(id: string): Promise<DecisionDetail>
  createDecision(draft: DecisionDraftInput): Promise<DecisionDefinition>
  // Omitted sharing fields retain the saved audience; only creation applies the defaults.
  updateDecision(id: string, draft: DecisionDraftInput): Promise<DecisionDefinition>
  deleteDecision(id: string): Promise<void>
  listBots(): Promise<DecisionBot[]>
  listChannels(botId?: string): Promise<DecisionChannel[]>
  saveChannel(id: string, settings: DecisionChannelSettings): Promise<DecisionChannel>
  getRouting(botId: string): Promise<DecisionRoutingDetail>
  saveRouting(botId: string, input: DecisionRoutingSave): Promise<DecisionRoutingDetail>
  preview(input: DecisionPreviewInput): Promise<DecisionPreviewResult>
}

export interface DecisionApiErrorBody {
  error: 'invalid_input' | 'not_found' | 'conflict' | 'unavailable'
  message: string
  issues?: DecisionValidationIssue[]
}

export type DecisionPreviewEvaluator = (
  decision: DecisionDraft,
  state: Record<string, unknown>
) => DecisionEvaluation | Promise<DecisionEvaluation>
