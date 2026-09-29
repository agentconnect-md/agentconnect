import type { AgentApiProtocol } from './agent-api.js'
import type {
  ChannelDecisionBinding,
  ChannelDecisionGate,
  CodeHostRoutingFamily,
  CodeHostRoutingProvider,
  DecisionChannelSettings,
  DecisionDefinition,
  DecisionDraft,
  DecisionDraftInput,
  DecisionEvaluation,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage,
  DecisionPreviewSample,
  DecisionQuestion,
  DecisionRoutingEvaluationRecordDetail,
  DecisionRoutingEvaluationRecordPage,
  DecisionValidationIssue,
  RoutingTargetEffect,
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
  reason?: string
  issues?: DecisionValidationIssue[]
}

// Daemons project provider capabilities and the resolved organization-key or Cloud source, never credentials.
export interface DecisionProviderOption {
  id: string
  daemonId: string
  daemonName?: string
  pool?: boolean
  memberSetId?: string | null
  name: string
  kind: string
  source: 'byok' | 'ac_credits' | null
  readiness: DecisionReadiness
  models: Array<{ id: string; label: string; questionTypes: DecisionQuestion['type'][] }>
}

export interface DecisionUsage {
  kind: 'gate' | 'shared_bot_routing' | 'code_host_routing' | 'agent_tool' | 'model_selection' | 'api_gate'
  id: string
  label: string
  rootDecisionId?: string
  integrationId?: string
  channelId?: string
  provider?: CodeHostRoutingProvider
  repoId?: string
  family?: CodeHostRoutingFamily
  // kind=api_gate: the agent's chat API the gate sits on.
  protocol?: AgentApiProtocol
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
  // `agentId` optionally names the removed channel's replacement default agent.
  removals: Array<{
    channelId: string
    settings: Exclude<DecisionChannelSettings, { trigger: 'decision' }>
    agentId?: string
  }>
}

export interface DecisionRoutingDetail {
  botId: string
  config: SharedBotDecisionRouting | null
  // The complete effective scope: every conversation bound to this bot's router.
  channelIds: string[]
  readiness: DecisionReadiness
  // The bot-level host (message-intake.md §6 rule 1, else rule 2 over every candidate); null when none is live.
  evaluationHost: {
    daemonId: string
    name: string | null
    source: 'default_agent' | 'earliest_candidate'
    status: 'ready' | 'daemon_offline' | 'unsupported'
  } | null
  channels: Array<{
    channelId: string
    name: string | null
    defaultAgent: { id: string; name: string | null } | null
    evaluationDaemonId: string | null
    readiness: DecisionReadiness
  }>
  updatedAt: string | null
}

// `participantAgentIds` marks recipients already participating in the thread, a subset of `agentIds`.
export type DecisionTargetConstraint =
  { type: 'new' } | { type: 'mention' | 'thread'; agentIds: string[]; participantAgentIds?: string[] }

export type DecisionPreviewTarget =
  { kind: 'daemon'; daemonId: string } | { kind: 'pool' } | { kind: 'set'; setId: string }

export type DecisionPreviewInput = {
  decision: DecisionDraftInput
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
} & ({ target: DecisionPreviewTarget; daemonId?: never } | { daemonId: string; target?: never })

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

/** One live conversation: the integration install and its platform channel id. */
export interface DecisionConversationRef {
  integrationId: string
  channelId: string
}

export interface DecisionGatePreviewInput {
  decisionBinding: ChannelDecisionGate
  state: DecisionPreviewSample
}

// Gate Try on the conversation's serving daemon; `unavailable` continues to the target and is never a skip.
export interface DecisionGatePreviewResult {
  chain?: import('./decision.js').DecisionChainTrace
  mode: 'mock' | 'live'
  readiness: DecisionReadiness
  evaluation: DecisionEvaluation | null
  consumer: {
    type: 'gate'
    outcome: 'trigger' | 'skip' | 'unavailable' | 'not_applied'
    notAppliedReason?: 'off' | 'unsupported' | 'needs_review'
    reason?: string
    matched: boolean
    matchedKeys: string[]
    target: { agentId: string; name: string }
  }
}

/** Try a draft chat API gate on the agent's serving daemon; the result reads like a conversation gate's. */
export interface ApiGatePreviewInput {
  gate: ChannelDecisionGate
  state: import('./decision.js').ApiGateTryState
}

/** Try a draft code-host routing on the scope's evaluation host. */
export interface CodeHostRoutingPreviewInput {
  config: SharedBotDecisionRouting
  state: import('./decision.js').CodeHostTryState
}

// `unavailable` fires every member, as the live router fails open; `skip` fires none.
export interface CodeHostRoutingPreviewResult {
  chain?: import('./decision.js').DecisionChainTrace
  mode: 'mock' | 'live'
  evaluation: DecisionEvaluation | null
  consumer: {
    type: 'code_host_routing'
    outcome: 'activate' | 'skip' | 'unavailable' | 'not_applied'
    notAppliedReason?: 'paused' | 'needs_review' | 'unsupported'
    reason?: string
    matchedRuleIds: string[]
    matchedKeys: string[]
    usedOtherwise: boolean
    targets: Array<{ agentId: string; name: string | null }>
  }
}

export interface DecisionRoutingPreviewInput {
  /** The draft configuration and draft scope; neither is saved. */
  config: SharedBotDecisionRouting
  channelIds: string[]
  /** The sample channel. */
  channelId: string
  targets: DecisionTargetConstraint
  state: DecisionPreviewSample
}

export type DecisionRoutingNotAppliedReason = 'off' | 'outside_scope' | 'paused' | 'needs_review' | 'unsupported'

// Routing Try on the bot's evaluation host; `unavailable` names its continuation and is never a skip.
export interface DecisionRoutingPreviewResult {
  chain?: import('./decision.js').DecisionChainTrace
  mode: 'mock' | 'live'
  readiness: DecisionReadiness
  evaluation: DecisionEvaluation | null
  consumer: {
    type: 'shared_bot_routing'
    outcome: 'activate' | 'continue' | 'skip' | 'unavailable' | 'not_applied'
    notAppliedReason?: DecisionRoutingNotAppliedReason
    reason?: string
    /** False when every recipient participates, so the set settled with no model call. */
    evaluated: boolean
    rules: Array<{ ruleId: string; matched: boolean; matchedKeys: string[] }>
    matchedRuleIds: string[]
    matchedKeys: string[]
    matchedAgentIds: string[]
    usedOtherwise: boolean
    fallback: 'constrained' | 'default' | 'none' | null
    defaultAgent: { id: string; name: string | null } | null
    targetConstraint: DecisionTargetConstraint
    targets: Array<{
      agentId: string
      name: string | null
      effect: RoutingTargetEffect
      participant: boolean
      via: 'mention' | 'implicit'
      status: 'available' | 'unavailable' | 'removed'
    }>
  }
}

export interface DecisionApi {
  mode: 'mock' | 'live'
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
  previewGate(ref: DecisionConversationRef, input: DecisionGatePreviewInput): Promise<DecisionGatePreviewResult>
  listEvaluations(
    ref: DecisionConversationRef,
    page?: { cursor?: number; limit?: number; decisionId?: string }
  ): Promise<DecisionEvaluationRecordPage>
  getEvaluation(ref: DecisionConversationRef, seq: number): Promise<DecisionEvaluationRecordDetail>
  previewRouting(botId: string, input: DecisionRoutingPreviewInput): Promise<DecisionRoutingPreviewResult>
  listRoutingEvaluations(
    botId: string,
    page?: { channelId?: string; cursor?: number; limit?: number; decisionId?: string }
  ): Promise<DecisionRoutingEvaluationRecordPage>
  getRoutingEvaluation(
    botId: string,
    ref: { channelId: string; seq: number }
  ): Promise<DecisionRoutingEvaluationRecordDetail>
}

export interface DecisionApiErrorBody {
  error: 'invalid_input' | 'not_found' | 'conflict' | 'unavailable'
  message: string
  // The machine code the live API sends, such as DAEMON_OFFLINE.
  code?: string
  issues?: DecisionValidationIssue[]
  // A delete refused while in use lists the visible usages and counts the hidden ones.
  usages?: DecisionUsage[]
  hiddenUsageCount?: number
}

export type DecisionPreviewEvaluator = (
  decision: DecisionDraft,
  state: Record<string, unknown>
) => DecisionEvaluation | Promise<DecisionEvaluation>
