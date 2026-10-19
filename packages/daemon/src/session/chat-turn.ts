import type {
  ElicitCard,
  McpAppCard,
  McpAppOutcome,
  McpAppRpcResult,
  PlanEntry,
  SessionImageAttachment,
  SharedImage,
  SharedImageDownload
} from '@agentconnect.md/protocol'

// Masked application updates; protocol adapters own their envelopes, replay, and subscription state.
export type ChatEvent =
  | { kind: 'message'; text: string; segmentId?: string; postId?: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; toolCallId: string; title: string; status: string }
  | { kind: 'tool_update'; toolCallId: string; status: string; title?: string }
  | { kind: 'session_info'; title: string }
  | { kind: 'superseded'; generation: number }
  | { kind: 'notice'; text: string; standing?: boolean }
  | { kind: 'plan'; entries: PlanEntry[] }
  | ({ kind: 'elicitation' } & ElicitCard)
  | {
      kind: 'elicitation_resolved'
      requestId: string
      outcome: 'accepted' | 'dismissed' | 'cancelled' | 'completed'
      label?: string
    }
  | { kind: 'permission'; requestId: string; tool: string; detail: string }
  | ({ kind: 'app' } & McpAppCard)
  | { kind: 'app_template'; appId: string; seq: number; chunk: string }
  | { kind: 'app_resolved'; appId: string; outcome: McpAppOutcome }
  | { kind: 'app_rpc_result'; appId: string; callId: string; outcome: McpAppRpcResult }
  | ({ kind: 'image'; postId: string; at: number; text: string; download?: SharedImageDownload } & SharedImage)

export interface ChatRuntimeSettings {
  runtime?: string
  model?: string
  effort?: string
  permissionMode?: string
  fastMode?: boolean
}

export interface ChatStatus extends ChatRuntimeSettings {
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
  costAmount?: number
  costCurrency?: string
  models?: string[]
  efforts?: string[]
  permissionModes?: string[]
  fastModeAvailable?: boolean
  steerable?: boolean
  sessionId?: string
}

export interface ChatOutput {
  conversationId: string
  turnId: string
  // An emission ordinal inside this turn, never an AHP subscription or recovery cursor.
  index: number
  event?: ChatEvent
  status?: ChatStatus
}

export interface ChatCompletion {
  conversationId: string
  turnId: string
  stopReason?: string
  usage?: { used?: number; cost?: number }
  error?: string
}

export interface ChatSink {
  output(update: ChatOutput): void
  done(completion: ChatCompletion): void
}

export interface ChatPost {
  conversationId: string
  agentId: string
  initiator?: 'agent'
  post: {
    postId: string
    conversationId: string
    author:
      | { kind: 'user'; user?: string; userId?: string }
      | { kind: 'agent'; agentId: string; hopCount?: number; addressedAgentIds?: string[] }
    text: string
    at: number
    attachments?: SessionImageAttachment[]
    image?: SharedImage
  }
}

// Execution context shared by human chat services; no connection, replay, or wire SDK ownership.
export interface ChatTurnContext {
  conversationId: string
  turnId: string
  sink: ChatSink
  postSink?: (post: ChatPost) => void
  initiator?: 'agent'
  // A continuation also retains its original platform's output and delivery barriers.
  continuation?: true
  runtime?: ChatRuntimeSettings
  worktree?: boolean
  // Verified authority is never model input and grants no permissions beyond its existing lifetime.
  remoteMcp?: { authorityId: string; authorityGeneration: number; expiresAt: string }
  doneSent?: boolean
  apiProtocol?: string
  evaluation?: boolean
}

// One execution's reply accumulator is independent of how each service transports its updates.
export interface ChatTurnOutput extends ChatTurnContext {
  index: number
  replyText: string
  replySegments: { postId: string; text: string; committing?: Promise<void> }[]
  segmentIndex?: number
  heldText: string
  heldTextOffset?: number
  messageId?: string
  messageEmitted: boolean
}

// The existing daemon admission gate remains the sole owner of queueing, steering, and execution.
export interface ChatDispatchOptions {
  requireDurable?: boolean
  deliveryId?: string
  steerOnly?: boolean
  onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean; steered?: boolean }) => void
  admissionWait?: Promise<boolean>
  deferObservedInbound?: boolean
}
