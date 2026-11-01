import {
  continuableSession,
  isDelegatedTaskCoordinate,
  isSubsessionCoordinate,
  originKindOf
} from '@agentconnect.md/protocol'
import { LifecycleCleanupBlockedError } from '../daemon/turn-types.js'
import { formatErr } from '../daemon/text.js'
import { isHeadlessCronSession } from '../scheduler/scheduler.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { SlackConnection } from '../slack/connection.js'
import type { TelegramConnection } from '../telegram/connection.js'
import type { DiscordConnection } from '../discord/connection.js'
import type { FeishuConnection } from '../feishu/connection.js'
import { sessionKey, type SessionRecord } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import type { ChatApplicationHost, ChatAuthor, ChatSessionApplication, PreparedChatTurn } from './chat-application.js'
import type { ChatDispatchOptions, ChatTurnContext } from './chat-turn.js'

export type ChatReplyConnection = SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection

export interface ChatContinuationRequest {
  agentId: string
  conversationId: string
  targetSessionId: string
  turnId: string
  text: string
  author: ChatAuthor
  post?: { postId: string; at: number }
}

type Integration = { integrationId: string; conn: ChatReplyConnection; botUserId?: string }
export interface PreparedChatContinuation extends PreparedChatTurn {
  request: ChatContinuationRequest
  local: SessionRecord
  integration: Integration | null
}

type Refusal = {
  accepted: false
  reason:
    | 'start_failed'
    | 'no_agent'
    | 'not_found'
    | 'paused'
    | 'busy'
    | 'draining'
    | 'integration_offline'
    | 'integration_delivery_failed'
  detail?: string
}
export type ChatContinuationPreparation = { accepted: true; turn: PreparedChatContinuation } | Refusal
export type ChatContinuationVerdict = { accepted: true } | Refusal

export interface ChatContinuationHost extends Pick<
  ChatApplicationHost,
  'info' | 'warn' | 'store' | 'agents' | 'paused' | 'startFailure' | 'safetyDraining' | 'draining' | 'agentDraining'
> {
  error(message: string): void
  integrationIdForSessionTransport(
    agentId: string,
    platform: string,
    transportScope?: string | null
  ): string | undefined
  connForIntegration(integrationId: string): ChatReplyConnection | undefined
  botUserIds(): Record<string, string>
  resolveCpAgent(agentId: string, platform?: string): { botUserId: string } | null
  dispatch(
    agentId: string,
    message: NormalizedMessage,
    integrationId: string | undefined,
    context: ChatTurnContext,
    options?: ChatDispatchOptions
  ): Promise<string | null>
}

/** Whether the console continues this session by its target rather than in place: any but a webchat conversation's own, whose tasks are targets too (auto-session-mode.md §10). */
export function continuedByTarget(local: { platform: string; thread?: string | null }): boolean {
  return local.platform !== 'webchat' || isSubsessionCoordinate(local.thread)
}

// Continue the existing outward session and preserve its origin mirror before admitting execution.
export class ChatSessionContinuation {
  constructor(
    private readonly host: ChatContinuationHost,
    private readonly application: ChatSessionApplication
  ) {}

  private integration(agentId: string, local: SessionRecord): Integration | undefined {
    const integrationId = this.host.integrationIdForSessionTransport(
      agentId,
      local.platform,
      local.transportScope ?? undefined
    )
    const conn = integrationId ? this.host.connForIntegration(integrationId) : undefined
    if (!integrationId || !conn) return undefined
    const botUserId =
      this.host.botUserIds()[integrationId] ?? this.host.resolveCpAgent(agentId, local.platform)?.botUserId
    return { integrationId, conn, ...(botUserId ? { botUserId } : {}) }
  }

  async prepare(request: ChatContinuationRequest): Promise<ChatContinuationPreparation> {
    const { agentId, targetSessionId, conversationId, turnId, text, author, post } = request
    if (!this.host.agents().has(agentId)) {
      const startFailure = this.host.startFailure(agentId)
      return startFailure
        ? { accepted: false, reason: 'start_failed', detail: startFailure }
        : { accepted: false, reason: 'no_agent' }
    }
    // The verified outward id must resolve on this agent; never rebuild coordinates from caller input.
    const local = await this.host.store().getSessionByOutwardId(targetSessionId, agentId)
    if (!local || !continuableSession(local)) return { accepted: false, reason: 'not_found' }
    if (this.host.paused(agentId)) return { accepted: false, reason: 'paused' }
    if (this.host.safetyDraining(agentId)) return { accepted: false, reason: 'busy' }
    if (this.host.draining() || this.host.agentDraining(agentId)) return { accepted: false, reason: 'draining' }
    // Hook and headless cron sessions have no mirror; a missing chat integration must refuse the turn.
    const synthetic = isHeadlessCronSession(local)
    // A delegated task's coordinate is no platform thread, so its page runs console-only (auto-session-mode.md §10).
    const task = isDelegatedTaskCoordinate(local.thread)
    const integration =
      originKindOf(local.platform) === 'hook' || synthetic || task ? null : this.integration(agentId, local)
    if (integration === undefined) return { accepted: false, reason: 'integration_offline' }
    await this.application.rememberAuthorName(author)
    const shared = integration === null ? post : undefined
    const message: NormalizedMessage = {
      msgId: `webchat-cont:${conversationId}:${turnId}`,
      traceId: turnId,
      source: 'user',
      platform: local.platform,
      channel: local.channel,
      ...(local.thread ? { thread: local.thread } : {}),
      ...(local.transportScope ? { transportScope: local.transportScope } : {}),
      transcriptTs: shared ? String(shared.at) : monotonicTs(),
      ...(shared ? { transcriptPostId: shared.postId } : {}),
      sender: { id: author.id, isBot: false, name: author.name },
      ...(author.timeZone ? { senderTimeZone: author.timeZone } : {}),
      text,
      mentionedBots: integration?.botUserId ? [integration.botUserId] : [],
      isDm: local.conversationKind === 'dm',
      trigger: local.conversationKind === 'dm' ? 'dm' : 'mention',
      adoptedSession: true,
      ...(synthetic ? { headless: true, syntheticChannel: true } : task ? { headless: true } : {})
    }
    const key = sessionKey(
      message.platform,
      message.channel,
      message.thread ?? message.msgId,
      agentId,
      message.transportScope
    )
    if (key !== local.key) {
      this.host.warn(`chat continuation: key mismatch for session ${targetSessionId} (${key} != ${local.key})`)
      return { accepted: false, reason: 'not_found' }
    }
    return { accepted: true, turn: { agentId, sessionKey: key, message, local, integration, request } }
  }

  async dispatch(
    turn: PreparedChatContinuation,
    context: ChatTurnContext,
    onRefused: () => void,
    options?: Pick<ChatDispatchOptions, 'requireDurable' | 'receiptId' | 'deliveryId' | 'onAdmission' | 'startOnly'>
  ): Promise<ChatContinuationVerdict> {
    const { agentId, message, local, integration, request } = turn
    const { author, text, conversationId, turnId } = request
    const logFailure = (error: unknown): void => {
      if (!(error instanceof LifecycleCleanupBlockedError))
        this.host.error(`chat continuation dispatch failed for agent "${agentId}": ${formatErr(error)}`)
    }
    // Mirror-less output commits into the same transcript once and never uses a platform renderer.
    if (!integration) {
      if (options) {
        let settle!: (result: { accepted: boolean; reason?: string }) => void
        let fail!: (error: unknown) => void
        const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve, reject) => {
          settle = resolve
          fail = reject
        })
        void this.host
          .dispatch(agentId, message, undefined, context, {
            ...options,
            onAdmission: async (result) => {
              await options.onAdmission?.(result)
              settle(result)
            }
          })
          .catch(fail)
        const result = await admitted
        if (!result.accepted) {
          onRefused()
          return { accepted: false, reason: result.reason === 'draining' ? 'draining' : 'busy' }
        }
      } else {
        void this.host.dispatch(agentId, message, undefined, context).catch(logFailure)
      }
      this.host.info(
        `chat continuation: ${author.name} → unmirrored session ${local.key} (conversation ${conversationId}, turn ${turnId})`
      )
      return { accepted: true }
    }
    context.continuation = true
    let settleMirror!: (mirrored: boolean) => void
    const mirrorAdmission = new Promise<boolean>((resolve) => {
      settleMirror = resolve
    })
    let committed: Promise<void> = Promise.resolve()
    let settleAdmission!: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
    const admitted = new Promise<{ accepted: boolean; reason?: string; duplicate?: boolean }>((resolve) => {
      settleAdmission = resolve
    })
    void this.host
      .dispatch(agentId, message, integration.integrationId, context, {
        ...options,
        admissionWait: mirrorAdmission,
        deferObservedInbound: true,
        onAdmission: (result) => {
          settleAdmission(result)
          committed = (async () => {
            if (result.accepted && !result.duplicate && !(await mirrorAdmission)) return
            await options?.onAdmission?.(result)
          })()
          return committed
        }
      })
      .catch((error) => {
        logFailure(error)
        settleAdmission({ accepted: false, reason: 'error' })
      })
    const admission = await admitted
    if (!admission.accepted) {
      settleMirror(false)
      onRefused()
      await committed
      return { accepted: false, reason: admission.reason === 'draining' ? 'draining' : 'busy' }
    }
    if (admission.duplicate) {
      settleMirror(false)
      await committed
      return { accepted: true }
    }
    // Reserve a queue slot first, then prove that the attributed human message reached its origin.
    const attributedText = `[${author.name} via console] ${text}`
    let authorMirror: { conn: SlackConnection; ts: string; text: string } | undefined
    try {
      let mirrorId: string | undefined
      if ('postAsAuthor' in integration.conn) {
        const conn = integration.conn
        const landed = await conn.postAsAuthor(
          local.channel,
          local.thread || undefined,
          { text, attributedText },
          { name: author.name, ...(author.pictureUrl ? { iconUrl: author.pictureUrl } : {}) },
          { agentAuthorId: agentId }
        )
        mirrorId = landed?.ts
        if (landed) authorMirror = { conn, ts: landed.ts, text: landed.text }
      } else {
        mirrorId = await integration.conn.postMessage(local.channel, attributedText, local.thread || undefined)
      }
      if (!mirrorId) throw new Error('provider returned no message id')
      settleMirror(true)
    } catch (error) {
      this.host.warn(`chat continuation: mirror post failed for ${local.key}: ${formatErr(error)}`)
      onRefused()
      settleMirror(false)
      return { accepted: false, reason: 'integration_delivery_failed' }
    }
    await committed
    // Once delivery is proven, a failed routing finalization leaves transcript-only peers.
    if (authorMirror && typeof authorMirror.conn.finalizeResponse === 'function') {
      const finalized = await authorMirror.conn.finalizeResponse(
        local.channel,
        authorMirror.ts,
        [{ type: 'markdown', text: authorMirror.text }],
        authorMirror.text,
        agentId,
        { responseId: message.msgId, deliveryState: 'final', hopCount: 0, mentionedAgentIds: [] }
      )
      if (!finalized) this.host.warn(`chat continuation: mirror finalization failed for ${local.key} (peers unrouted)`)
    }
    this.host.info(
      `chat continuation: ${author.name} → session ${local.key} (conversation ${conversationId}, turn ${turnId})`
    )
    return { accepted: true }
  }
}
