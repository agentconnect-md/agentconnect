import {
  ActionType,
  chatReducer,
  SessionStatus,
  MessageKind,
  ResponsePartKind,
  ToolCallStatus,
  ToolCallConfirmationReason,
  ToolCallCancellationReason,
  ToolResultContentType,
  ConfirmationOptionKind,
  ChatInputResponseKind,
  type ChatAction,
  type ChatState
} from '@microsoft/agent-host-protocol'
import type { MaskedChatEvent } from '../session/chat-events.js'
import type { ToolEdit } from '../session/tool-edits.js'
import { ahpInputRequest, ahpSubmittedAnswers } from './chat-input.js'
import { fileEditContent } from './file-edits.js'

export class AhpChatProjection {
  private value: ChatState
  private generation = -1
  private partSequence = 0
  private part?: { id: string; kind: 'text' | 'reasoning' }
  private readonly edits = new Map<string, ToolEdit[]>()

  constructor(
    private readonly sessionId: string,
    resource: string,
    title: string,
    at: number,
    private readonly publish: (action: ChatAction) => void,
    initial?: ChatState
  ) {
    if (initial && initial.resource !== resource) throw new Error('AHP checkpoint resource mismatch')
    this.value = initial
      ? structuredClone(initial)
      : { resource, title, modifiedAt: new Date(at).toISOString(), status: SessionStatus.Idle, turns: [] }
    if (this.value.activeTurn) this.generation = 0
    for (const part of this.value.activeTurn?.responseParts ?? []) {
      if ('id' in part) this.partSequence = Math.max(this.partSequence, Number(part.id.split(':').at(-1)) || 0)
    }
  }

  bindResource(resource: string): void {
    this.value = { ...this.value, resource }
  }

  snapshot(): ChatState {
    return structuredClone(this.value)
  }

  apply(action: ChatAction): void {
    if (action.type === ActionType.ChatTurnStarted && !this.value.activeTurn) {
      this.generation = 0
      this.part = undefined
    }
    if (
      action.type === ActionType.ChatTurnComplete ||
      action.type === ActionType.ChatTurnCancelled ||
      action.type === ActionType.ChatError
    ) {
      if (this.value.activeTurn?.id === action.turnId) this.settlePending()
    }
    this.emit(action)
  }

  accept(event: MaskedChatEvent): void {
    if (event.sessionId !== this.sessionId) return
    if (event.kind === 'started') {
      if (this.value.activeTurn || this.value.turns.some((turn) => turn.id === event.turnId)) return
      this.generation = event.generation
      this.part = undefined
      this.emit({
        type: ActionType.ChatTurnStarted,
        turnId: event.turnId,
        startedAt: new Date(event.at).toISOString(),
        message: { text: event.text, origin: { kind: event.origin === 'agent' ? MessageKind.Agent : MessageKind.User } }
      })
      return
    }
    const active = this.value.activeTurn
    if (!active || active.id !== event.turnId || event.generation !== this.generation) return
    const turnId = active.id
    switch (event.kind) {
      case 'discarded':
        if (event.nextGeneration <= this.generation) return
        this.emit({ type: ActionType.ChatTruncated, turnId: this.value.turns.at(-1)?.id })
        this.generation = event.nextGeneration
        this.part = undefined
        this.emit({
          type: ActionType.ChatTurnStarted,
          turnId,
          startedAt: new Date(event.at).toISOString(),
          message: active.message
        })
        return
      case 'boundary':
        this.part = undefined
        return
      case 'text':
      case 'reasoning': {
        if (!this.part || this.part.kind !== event.kind) {
          this.part = { id: `${turnId}:${this.generation}:${++this.partSequence}`, kind: event.kind }
          this.emit({
            type: ActionType.ChatResponsePart,
            turnId,
            part: {
              kind: event.kind === 'text' ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning,
              id: this.part.id,
              content: ''
            }
          })
        }
        this.emit({
          type: event.kind === 'text' ? ActionType.ChatDelta : ActionType.ChatReasoning,
          turnId,
          partId: this.part.id,
          content: event.text
        })
        return
      }
      case 'tool': {
        this.part = undefined
        const toolCallId = `runtime:${event.id}`
        if (event.edits) this.edits.set(toolCallId, event.edits)
        let tool = this.tool(toolCallId)
        if (!tool) {
          this.emit({
            type: ActionType.ChatToolCallStart,
            turnId,
            toolCallId,
            toolName: event.title,
            displayName: event.title
          })
          tool = this.tool(toolCallId)
        }
        if (event.status !== 'pending' && tool?.status === ToolCallStatus.Streaming) {
          this.emit({
            type: ActionType.ChatToolCallReady,
            turnId,
            toolCallId,
            invocationMessage: event.title,
            toolInput: event.input,
            confirmed: ToolCallConfirmationReason.NotNeeded
          })
        }
        if (
          (event.status === 'completed' || event.status === 'failed') &&
          this.tool(toolCallId)?.status === ToolCallStatus.Running
        ) {
          const edits =
            event.status === 'completed'
              ? (this.edits.get(toolCallId) ?? []).map((edit) => fileEditContent(this.sessionUri(), event.id, edit))
              : []
          this.edits.delete(toolCallId)
          const content = [
            ...(event.output !== undefined ? [{ type: ToolResultContentType.Text as const, text: event.output }] : []),
            ...edits
          ]
          this.emit({
            type: ActionType.ChatToolCallComplete,
            turnId,
            toolCallId,
            result: {
              success: event.status === 'completed',
              pastTenseMessage: event.title,
              ...(content.length ? { content } : {})
            }
          })
        }
        return
      }
      case 'permission':
        this.part = undefined
        if (this.tool(event.requestId)) return
        this.emit({
          type: ActionType.ChatToolCallStart,
          turnId,
          toolCallId: event.requestId,
          toolName: 'agentconnect.permission',
          displayName: `Approve ${event.tool}`
        })
        this.emit({
          type: ActionType.ChatToolCallReady,
          turnId,
          toolCallId: event.requestId,
          invocationMessage: event.detail,
          options: event.options?.map((option) => ({
            id: option.id,
            label: option.label,
            kind: option.allow ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny
          }))
        })
        return
      case 'permission_resolved': {
        const tool = this.tool(event.requestId)
        if (!tool || tool.toolName !== 'agentconnect.permission') return
        if (tool.status === ToolCallStatus.PendingConfirmation) {
          this.emit(
            event.outcome === 'allowed'
              ? {
                  type: ActionType.ChatToolCallConfirmed,
                  turnId,
                  toolCallId: event.requestId,
                  approved: true,
                  confirmed: ToolCallConfirmationReason.UserAction,
                  selectedOptionId: event.selectedOptionId
                }
              : {
                  type: ActionType.ChatToolCallConfirmed,
                  turnId,
                  toolCallId: event.requestId,
                  approved: false,
                  reason:
                    event.outcome === 'denied' ? ToolCallCancellationReason.Denied : ToolCallCancellationReason.Skipped,
                  selectedOptionId: event.selectedOptionId
                }
          )
        }
        if (event.outcome === 'allowed' && this.tool(event.requestId)?.status === ToolCallStatus.Running)
          this.emit({
            type: ActionType.ChatToolCallComplete,
            turnId,
            toolCallId: event.requestId,
            result: { success: true, pastTenseMessage: 'Permission granted' }
          })
        return
      }
      case 'elicitation':
        this.part = undefined
        this.emit({ type: ActionType.ChatInputRequested, request: ahpInputRequest(event) })
        return
      case 'elicitation_resolved': {
        const input = active.responseParts.find(
          (part) => part.kind === ResponsePartKind.InputRequest && part.request.id === event.requestId
        )
        if (input?.kind !== ResponsePartKind.InputRequest || input.response) return
        this.emit({
          type: ActionType.ChatInputCompleted,
          requestId: event.requestId,
          response:
            event.outcome === 'accepted' || event.outcome === 'completed'
              ? ChatInputResponseKind.Accept
              : event.outcome === 'dismissed'
                ? ChatInputResponseKind.Decline
                : ChatInputResponseKind.Cancel,
          ...(event.answers ? { answers: ahpSubmittedAnswers(input.request, event.answers) } : {})
        })
        return
      }
      case 'finished': {
        this.edits.clear()
        const duration = Math.max(0, event.at - Date.parse(active.startedAt))
        this.settlePending()
        if (event.outcome === 'failed')
          this.emit({
            type: ActionType.ChatError,
            turnId,
            duration,
            part: {
              kind: ResponsePartKind.Error,
              error: { errorType: 'agentconnect.runtime', message: event.error ?? 'Turn interrupted' }
            }
          })
        else
          this.emit({
            type: event.outcome === 'cancelled' ? ActionType.ChatTurnCancelled : ActionType.ChatTurnComplete,
            turnId,
            duration
          })
        this.part = undefined
      }
    }
  }

  retainCompleted(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid AHP snapshot budget')
    let removed = false
    while (this.value.turns.length > 1 && Buffer.byteLength(JSON.stringify(this.value)) > maxBytes) {
      this.value = { ...this.value, turns: this.value.turns.slice(1) }
      removed = true
    }
    if (removed)
      this.value = {
        ...this.value,
        turnsNextCursor: `archive:${Buffer.from(this.value.turns[0]!.id).toString('base64url')}`
      }
  }

  private settlePending(): void {
    const active = this.value.activeTurn
    if (!active) return
    for (const part of active.responseParts) {
      if (part.kind === ResponsePartKind.InputRequest && !part.response)
        this.emit({
          type: ActionType.ChatInputCompleted,
          requestId: part.request.id,
          response: ChatInputResponseKind.Cancel
        })
      if (part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.PendingConfirmation)
        this.emit({
          type: ActionType.ChatToolCallConfirmed,
          turnId: active.id,
          toolCallId: part.toolCall.toolCallId,
          approved: false,
          reason: ToolCallCancellationReason.Skipped
        })
    }
  }

  private sessionUri(): string {
    return `ahp-session:${this.value.resource.slice('ahp-chat:'.length, -'/main'.length)}`
  }

  private tool(id: string) {
    const part = this.value.activeTurn?.responseParts.find(
      (part) => part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === id
    )
    return part?.kind === ResponsePartKind.ToolCall ? part.toolCall : undefined
  }

  private emit(action: ChatAction): void {
    this.value = chatReducer(this.value, action)
    this.publish(action)
  }
}
