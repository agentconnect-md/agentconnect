import {
  continuableSession,
  isCoordinatorCoordinate,
  isDelegatedTaskCoordinate,
  isSubsessionCoordinate,
  originKindOf
} from '@agentconnect.md/protocol'
import { webchatCoordinatorTask } from '../auto-session/webchat-task.js'
import { LifecycleCleanupBlockedError } from '../daemon/turn-types.js'
import { formatErr } from '../daemon/text.js'
import { isHeadlessCronSession } from '../scheduler/scheduler.js'
import {
  sessionChannelOf,
  sessionThreadOf,
  wakeThreadFields,
  type Attachment,
  type NormalizedMessage
} from '../messages/normalized.js'
import { sessionReceivedRoot } from '../cp/session-reader.js'
import type { UploadOutcome } from '../mcp/ops/context.js'
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
  /** Images and files sent with the message; only a coordinator's task takes them (its own thread is its composer). */
  attachments?: Attachment[]
  /** The thread written in: a webchat root a coordinator's task holds (webchat-threads.md §6.3), or a root a platform coordinator received (§7). */
  thread?: string
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
    | 'unknown_thread'
  detail?: string
}
export type ChatContinuationPreparation = { accepted: true; turn: PreparedChatContinuation } | Refusal
export type ChatContinuationVerdict = { accepted: true } | Refusal

export interface ChatContinuationHost extends Pick<
  ChatApplicationHost,
  | 'info'
  | 'warn'
  | 'store'
  | 'agents'
  | 'paused'
  | 'startFailure'
  | 'safetyDraining'
  | 'draining'
  | 'agentDraining'
  | 'keyCoordinatorMessage'
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

/** Why a continued chat thread refuses an uploaded file: only images are mirrored into it. */
export const CONTINUATION_FILES_REFUSAL = 'Files can’t be sent to a chat thread from the console yet; images can.'

/** Whether a continued turn is mirrored to the session's platform thread: hook, headless cron and delegated-task sessions run console-only. */
export function mirrorsToOrigin(local: SessionRecord): boolean {
  return !(
    originKindOf(local.platform) === 'hook' ||
    isHeadlessCronSession(local) ||
    isDelegatedTaskCoordinate(local.thread)
  )
}

/** The author's member id in the session's own platform tenant, when one of their linked identities is there. */
export function memberIdOn(
  author: Pick<ChatAuthor, 'identities'>,
  local: Pick<SessionRecord, 'platform' | 'transportScope'>
): string | undefined {
  if (!local.transportScope) return undefined
  const prefix = `${local.platform}:${local.transportScope}:`
  const key = author.identities?.find((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':'))
  return key?.slice(prefix.length) || undefined
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
    const { agentId, targetSessionId, conversationId, turnId, text, author, post, attachments, thread } = request
    if (!this.host.agents().has(agentId)) {
      const startFailure = this.host.startFailure(agentId)
      return startFailure
        ? { accepted: false, reason: 'start_failed', detail: startFailure }
        : { accepted: false, reason: 'no_agent' }
    }
    // The verified outward id must resolve on this agent; never rebuild coordinates from caller input.
    const local = await this.host.store().getSessionByOutwardId(targetSessionId, agentId)
    if (!local) return { accepted: false, reason: 'not_found' }
    // A webchat coordinator's task keyed on its thread takes messages in the threads it holds, as their replies.
    const threadTask = await this.webchatThreadTask(agentId, local)
    // A platform coordinator takes a message in a thread of a root it received, mirrored there and routed as any reply in it (webchat-threads.md §7).
    const coordinatorThread =
      thread !== undefined &&
      !threadTask &&
      isCoordinatorCoordinate(local.thread) &&
      (await sessionReceivedRoot(this.host.store(), local, thread))
    const writesIn = thread ?? (threadTask ? local.thread : undefined)
    if (writesIn !== undefined && !coordinatorThread && !threadTask?.held.includes(writesIn))
      return { accepted: false, reason: 'unknown_thread' }
    if (!continuableSession({ ...local, taskParentSessionId: threadTask?.parentSessionId }))
      return { accepted: false, reason: 'not_found' }
    if (this.host.paused(agentId)) return { accepted: false, reason: 'paused' }
    if (this.host.safetyDraining(agentId)) return { accepted: false, reason: 'busy' }
    if (this.host.draining() || this.host.agentDraining(agentId)) return { accepted: false, reason: 'draining' }
    // Hook and headless cron sessions have no mirror; a missing chat integration must refuse the turn.
    const synthetic = isHeadlessCronSession(local)
    // A delegated task's coordinate is no platform thread, and a webchat thread has no mirror, so both run console-only (auto-session-mode.md §10).
    const page = isDelegatedTaskCoordinate(local.thread)
    const integration = mirrorsToOrigin(local) && !threadTask ? this.integration(agentId, local) : null
    if (integration === undefined) return { accepted: false, reason: 'integration_offline' }
    await this.application.rememberAuthorName(author)
    const shared = integration === null ? post : undefined
    const senderMemberId = integration ? memberIdOn(author, local) : undefined
    const message: NormalizedMessage = {
      msgId: `webchat-cont:${conversationId}:${turnId}`,
      traceId: turnId,
      source: 'user',
      platform: local.platform,
      channel: local.channel,
      // An append or coordinator coordinate is no platform thread: the turn posts at the conversation's top level.
      ...wakeThreadFields(local.thread, writesIn),
      ...(local.transportScope ? { transportScope: local.transportScope } : {}),
      transcriptTs: shared ? String(shared.at) : monotonicTs(),
      ...(shared ? { transcriptPostId: shared.postId } : {}),
      sender: { id: author.id, isBot: false, name: author.name },
      ...(author.timeZone ? { senderTimeZone: author.timeZone } : {}),
      text,
      ...(attachments?.length ? { attachments } : {}),
      mentionedBots: integration?.botUserId ? [integration.botUserId] : [],
      isDm: local.conversationKind === 'dm',
      trigger: local.conversationKind === 'dm' ? 'dm' : 'mention',
      adoptedSession: true,
      ...(senderMemberId ? { senderMemberId } : {}),
      ...(synthetic ? { headless: true, syntheticChannel: true } : page ? { headless: true } : {})
    }
    const key = sessionKey(message.platform, message.channel, sessionThreadOf(message), agentId, message.transportScope)
    if (key !== local.key) {
      this.host.warn(`chat continuation: key mismatch for session ${targetSessionId} (${key} != ${local.key})`)
      return { accepted: false, reason: 'not_found' }
    }
    // A task that holds the thread by now takes the message, as it takes any reply there (webchat-threads.md §4).
    if (coordinatorThread) await this.host.keyCoordinatorMessage?.(agentId, message)
    const routed = sessionKey(
      message.platform,
      sessionChannelOf(message),
      sessionThreadOf(message),
      agentId,
      message.transportScope
    )
    return { accepted: true, turn: { agentId, sessionKey: routed, message, local, integration, request } }
  }

  /** The live coordinator task `local` is keyed on its webchat thread for, with the webchat threads it holds; undefined for any other session. */
  private async webchatThreadTask(
    agentId: string,
    local: SessionRecord
  ): Promise<{ parentSessionId: string; held: string[] } | undefined> {
    if (local.platform !== 'webchat' || !local.thread || isSubsessionCoordinate(local.thread)) return undefined
    const store = this.host.store()
    const task = await webchatCoordinatorTask(store, agentId, local.key, local.thread)
    if (!task) return undefined
    const threads = await store.assistantSubsessions.threadsOf(agentId, local.key)
    const held = threads.filter((one) => one.platform === 'webchat' && one.channel === local.channel)
    return { parentSessionId: task.parentSessionId, held: held.map((one) => one.thread) }
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
    const images = (message.attachments ?? []).filter((a) => a.inlineData && a.mimeType.startsWith('image/'))
    // A message that is only attachments still mirrors a line naming them, which anchors the turn.
    const body = text.trim() ? text : (message.attachments ?? []).map((a) => a.name).join(', ')
    const attributedText = `[${author.name} via console] ${body}`
    let authorMirror: { conn: SlackConnection; ts: string; text: string } | undefined
    try {
      let mirrorId: string | undefined
      if ('postAsAuthor' in integration.conn) {
        const conn = integration.conn
        const landed = await conn.postAsAuthor(
          local.channel,
          message.thread,
          { text: body, attributedText },
          { name: author.name, ...(author.pictureUrl ? { iconUrl: author.pictureUrl } : {}) },
          { agentAuthorId: agentId }
        )
        mirrorId = landed?.ts
        if (landed) authorMirror = { conn, ts: landed.ts, text: landed.text }
      } else {
        mirrorId = await integration.conn.postMessage(local.channel, attributedText, message.thread)
      }
      if (!mirrorId) throw new Error('provider returned no message id')
      // The copy in the conversation is the message, as channel ingress names it: its transcript row, and a coordinator's task thread.
      message.transcriptTs = mirrorId
    } catch (error) {
      this.host.warn(`chat continuation: mirror post failed for ${local.key}: ${formatErr(error)}`)
      onRefused()
      settleMirror(false)
      return { accepted: false, reason: 'integration_delivery_failed' }
    }
    // Images land in the thread before the turn runs, so its reply never reads above them.
    if (images.length) await this.mirrorImages(integration, local, message.thread, images, author, agentId)
    settleMirror(true)
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
      `chat continuation: ${author.name} → session ${turn.sessionKey} (conversation ${conversationId}, turn ${turnId})`
    )
    return { accepted: true }
  }

  // Best effort once the text landed: the agent still receives every image, and the thread says which one it could not show.
  private async mirrorImages(
    integration: Integration,
    local: SessionRecord,
    thread: string | undefined,
    images: Attachment[],
    author: ChatAuthor,
    agentId: string
  ): Promise<void> {
    const conn = integration.conn
    // Where the platform renders no per-message author, the caption names who sent the image.
    const caption = 'postAsAuthor' in conn ? undefined : `[${author.name} via console]`
    const identity = {
      username: author.name,
      ...(author.pictureUrl ? { icon_url: author.pictureUrl } : {}),
      agentAuthorId: agentId
    }
    for (const image of images) {
      let outcome: UploadOutcome
      try {
        outcome = await conn.uploadFile(
          local.channel,
          { bytes: image.inlineData!, name: image.name, mimeType: image.mimeType },
          caption,
          thread !== undefined ? { thread } : undefined,
          identity
        )
      } catch (error) {
        outcome = { ok: false, reason: 'platform_error', detail: formatErr(error) }
      }
      if (outcome.ok) continue
      this.host.warn(`chat continuation: image mirror failed for ${local.key} (${outcome.reason}): ${image.name}`)
      // A share that may still land must not be contradicted by a note saying it failed.
      if (outcome.reason === 'indeterminate') continue
      await conn
        .postMessage(local.channel, `[${author.name} via console] ${image.name} could not be shared here.`, thread)
        .catch((error: unknown) => this.host.warn(`chat continuation: image mirror note failed: ${formatErr(error)}`))
    }
  }
}
