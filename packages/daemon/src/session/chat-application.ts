import type { LoadedAgent } from '../agents/load-agents.js'
import { chatSettingsAllowed } from '../agents/chat-actions.js'
import type { Attachment, NormalizedMessage } from '../messages/normalized.js'
import { routeRules } from '../router/routing-table.js'
import type { RoutingRule } from '../router/routing-rule.js'
import { sessionKey, transcriptChannelKey, type LocalStore } from '../store/local-store.js'
import { formatErr } from '../daemon/text.js'
import { attachmentMention, transcriptImageAttachments } from './attachment-block.js'
import { appendChatTextRow } from './chat-transcript.js'

// Stable CP principal and mutable presentation fields supplied by an authenticated ingress.
export interface ChatAuthor {
  id: string
  name: string
  pictureUrl?: string
  timeZone?: string
}

// Protocol adapters decode attachments before entering the shared application boundary.
export interface ChatTurnRequest {
  agentId: string
  conversationId: string
  turnId: string
  text: string
  author: ChatAuthor
  mentions?: string[]
  attachments?: Attachment[]
  post?: { postId: string; at: number }
  steer?: boolean
}

export interface PreparedChatTurn {
  agentId: string
  sessionKey: string
  message: NormalizedMessage
}

export type ChatPreparation =
  | { accepted: true; turn: PreparedChatTurn }
  | { accepted: false; reason: 'no_agent' | 'start_failed' | 'paused' | 'busy' | 'draining'; detail?: string }

// Domain state only: no protocol frames, reply streams, ACP clients, or transport replay windows.
export interface ChatApplicationHost {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
  store(): LocalStore
  agents(): Map<string, LoadedAgent>
  mergedRules(): RoutingRule[]
  paused(agentId: string): boolean
  startFailure(agentId: string): string | undefined
  safetyDraining(agentId: string): boolean
  draining(): boolean
  agentDraining(agentId: string): boolean
  queueFull(sessionKey: string): boolean
  turnFinalContextRefresh(): boolean
  holdContextForOwnTurn(sessionKey: string, ts: string): void
}

// Public protocol choice does not change the durable conversation's existing coordinates.
export function chatSessionKey(conversationId: string, agentId: string): string {
  return sessionKey('webchat', conversationId, `webchat:${conversationId}`, agentId)
}

export class ChatSessionApplication {
  constructor(private readonly host: ChatApplicationHost) {}

  async rememberAuthorName(author: ChatAuthor): Promise<void> {
    if (!author.name || author.id === author.name) return
    try {
      await this.host.store().setDisplayName(author.id, author.name, Date.now())
    } catch (err) {
      this.host.debug(`chat: author name cache write failed: ${formatErr(err)}`)
    }
  }

  canChangeRuntime(agentId: string): boolean {
    return chatSettingsAllowed(this.host.agents().get(agentId))
  }

  async prepareTurn(request: ChatTurnRequest): Promise<ChatPreparation> {
    const { agentId, conversationId, turnId, text, author, mentions, post, attachments } = request
    const result = routeRules(
      { platform: 'webchat', channel: conversationId } as NormalizedMessage,
      this.host.mergedRules(),
      () => null,
      agentId
    )
    if (!result || !this.host.agents().has(result.agentId)) {
      const startFailure = this.host.startFailure(result?.agentId ?? agentId)
      if (startFailure) {
        this.host.warn(`chat: agent "${agentId}" failed to start — rejecting turn (${startFailure})`)
        return { accepted: false, reason: 'start_failed', detail: startFailure }
      }
      this.host.warn(`chat: no agent "${agentId}" on this daemon — rejecting turn`)
      return { accepted: false, reason: 'no_agent' }
    }
    if (this.host.paused(result.agentId)) {
      this.host.info(`chat: agent "${result.agentId}" is paused — rejecting turn`)
      return { accepted: false, reason: 'paused' }
    }
    if (this.host.safetyDraining(result.agentId)) {
      this.host.info(`chat: agent "${result.agentId}" is stopping an interrupted turn — rejecting turn`)
      return { accepted: false, reason: 'busy' }
    }
    if (this.host.draining() || this.host.agentDraining(result.agentId)) {
      this.host.info(`chat: agent "${result.agentId}" is draining — rejecting turn`)
      return { accepted: false, reason: 'draining' }
    }
    await this.rememberAuthorName(author)
    const key = chatSessionKey(conversationId, result.agentId)
    // Keep the message id stable per conversation so every protocol enters the same logical session.
    const message: NormalizedMessage = {
      msgId: `webchat:${conversationId}`,
      traceId: turnId,
      source: 'user',
      platform: 'webchat',
      channel: conversationId,
      sender: { id: author.id, isBot: false, name: author.name },
      ...(author.timeZone ? { senderTimeZone: author.timeZone } : {}),
      text,
      mentionedBots: mentions ?? [],
      ...(post ? { transcriptTs: String(post.at), transcriptPostId: post.postId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      isDm: true,
      trigger: mentions?.includes(agentId) ? 'mention' : 'dm'
    }
    return { accepted: true, turn: { agentId: result.agentId, sessionKey: key, message } }
  }

  // A synchronous preflight; the existing dispatch gate still decides admission after any persistence wait.
  checkAdmission(turn: PreparedChatTurn): ChatPreparation {
    if (this.host.queueFull(turn.sessionKey)) {
      this.host.warn(`chat: queue full for session ${turn.sessionKey} — rejecting turn`)
      return { accepted: false, reason: 'busy' }
    }
    return { accepted: true, turn }
  }

  // Called after the protocol has accepted a new request, before the daemon's existing dispatch gate.
  recordAdmission(turn: PreparedChatTurn, request: ChatTurnRequest): Promise<void> | undefined {
    const { post, steer } = request
    const msg = turn.message
    const ownTurn = post !== undefined && !!msg.attachments?.some((attachment) => attachment.transfer)
    if (ownTurn) this.host.holdContextForOwnTurn(turn.sessionKey, String(post.at))
    // A steer either joins the live turn or is refused; it must not leave an independent observed row.
    if (!post || !this.host.turnFinalContextRefresh() || steer) return
    return this.recordObservedAdmission(turn, request, post)
  }

  private async recordObservedAdmission(
    turn: PreparedChatTurn,
    request: ChatTurnRequest,
    post: { postId: string; at: number }
  ): Promise<void> {
    const { author, text, conversationId } = request
    const msg = turn.message
    const ownTurn = !!msg.attachments?.some((attachment) => attachment.transfer)
    const observedMention = attachmentMention(msg.attachments)
    const observedAttachments = transcriptImageAttachments(msg.attachments)
    const observedTs = await appendChatTextRow(
      this.host.store(),
      transcriptChannelKey(conversationId, undefined),
      `webchat:${conversationId}`,
      String(post.at),
      {
        sender: author.id,
        recipient: turn.agentId,
        admission: { agentId: turn.agentId, sessionKey: turn.sessionKey },
        postId: post.postId,
        text: observedMention ? `${text}\n${observedMention}`.trim() : text,
        ...(observedAttachments.length ? { attachments: observedAttachments } : {})
      }
    )
    // Collision-bumped coordinates must follow the row so queue coalescing cannot deliver it twice.
    msg.transcriptTs = observedTs
    if (ownTurn && observedTs !== String(post.at)) this.host.holdContextForOwnTurn(turn.sessionKey, observedTs)
  }
}
