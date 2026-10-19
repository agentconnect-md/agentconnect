import type { WorkspaceFileLinkResolver } from '../messages/workspace-file-links.js'
import { observeChatTurn } from '../session/chat-observer.js'
import { emitChatUpdate, flushHeldChatText } from '../session/chat-output.js'
import type { MaskedChatEvent } from '../session/chat-events.js'
import type { ChatEvent, ChatTurnOutput } from '../session/chat-turn.js'

// A read-only output accumulator; never installed as the execution turn's human-chat context.
export class AhpRuntimeObserver {
  readonly turnId: string
  private readonly output: ChatTurnOutput
  private finished = false
  constructor(options: {
    sessionId: string
    turnId: string
    text: string
    origin: 'user' | 'agent'
    now(): number
    emit(event: MaskedChatEvent): void
    resolveFileLink?: WorkspaceFileLinkResolver
  }) {
    this.turnId = options.turnId
    this.resolveFileLink = options.resolveFileLink
    this.output = observeChatTurn(
      {
        conversationId: '',
        turnId: options.turnId,
        continuation: true,
        sink: { output: () => {}, done: () => {} },
        index: 0,
        replyText: '',
        replySegments: [],
        heldText: '',
        messageEmitted: false
      },
      { sessionId: options.sessionId, generation: 0, now: options.now, emit: options.emit }
    )
    options.emit({
      sessionId: options.sessionId,
      turnId: options.turnId,
      generation: 0,
      at: options.now(),
      kind: 'started',
      text: options.text,
      origin: options.origin
    })
  }
  private readonly resolveFileLink?: WorkspaceFileLinkResolver
  update(maskedUpdate: unknown): void {
    if (!this.finished) emitChatUpdate(this.output, maskedUpdate, this.resolveFileLink)
  }
  event(event: ChatEvent): void {
    if (!this.finished)
      this.output.sink.output({ conversationId: '', turnId: this.turnId, index: this.output.index++, event })
  }
  finish(outcome: 'complete' | 'cancelled' | 'failed', error?: string): void {
    if (this.finished) return
    this.finished = true
    flushHeldChatText(this.output, this.resolveFileLink)
    this.output.sink.done({ conversationId: '', turnId: this.turnId, outcome, ...(error ? { error } : {}) })
  }
}
