/**
 * The daemon's webchat transport surface: turn admission (ordinary and
 * session-targeted continuation), the bounded reconnectable reply streams, the
 * agent-wake post context, cancel/close, and the peer-post continuation ladder
 * (webchat-multi-agents.md §5). Callers hold this class directly; everything here
 * reaches back through the narrow {@link WebchatHost} port.
 */
import { randomUUID } from 'node:crypto'
import type {
  RdChatEvent,
  RdWebchatPost,
  WebchatAck,
  WebchatImageAttachment,
  WebchatPost,
  WebchatRemoteMcpEntitlement,
  WebchatRuntimeConfig
} from '@agentconnect.md/protocol'
import { originKindOf } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../agents/load-agents.js'
import { sessionKey, transcriptChannelKey, type LocalStore } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { attachmentMention, transcriptImageAttachments } from '../session/attachment-block.js'
import { routeRules, webchatContinuationDecision } from '../router/routing-table.js'
import type { RoutingRule } from '../router/routing-rule.js'
import { SlackConnection, type SlackPostOptions } from '../slack/connection.js'
import type { TelegramConnection } from '../telegram/connection.js'
import type { DiscordConnection } from '../discord/connection.js'
import type { FeishuConnection } from '../feishu/connection.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { activationKey, ACTIVATION_PAIRING_TTL_MS } from '../daemon/helpers.js'
import { MAX_QUEUED_PER_SESSION } from '../daemon/constants.js'
import { formatErr } from '../daemon/text.js'
import { LifecycleCleanupBlockedError, type CallMeta, type Pending, type QueueEntry } from '../daemon/turn-types.js'
import { appendWebchatTextRow } from './turn-output.js'
import {
  UUID_RE,
  WEBCHAT_REPLAY_MAX_BYTES,
  WEBCHAT_REPLAY_MAX_EVENTS,
  WEBCHAT_REPLAY_MAX_STREAMS,
  WEBCHAT_REPLAY_TTL_MS,
  type WebchatSink,
  type WebchatTurnContext,
  type WebchatTurnStream
} from './types.js'

/** Who authored a webchat turn. `id` is the caller's STABLE control-plane principal and is
 *  what the durable transcript row records, so renaming a profile never re-identifies past
 *  rows; `name` is the mutable display handle for the author line, the branch a session
 *  worktree is cut under, and the console mirror. */
export interface WebchatAuthor {
  id: string
  name: string
}

/** The author a webchat `turn` op names. A relay older than the stable-principal claim sends
 *  only the display handle; falling back to it keeps that relay working, at the cost of the
 *  handle-shaped sender this pairing exists to remove. */
export function webchatAuthorOf(op: { user?: string; userId?: string }): WebchatAuthor {
  const name = op.user ?? 'webchat'
  return { id: op.userId ?? name, name }
}

/** Any platform connection a continuation mirror can post through. */
export type WebchatReplyConnection = SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection

/** Extra dispatch options the webchat transport needs; a subset of the daemon's own. */
export interface WebchatDispatchOptions {
  /** A rendezvous-backed activation must not go terminal without a durable row. */
  requireDurable?: boolean
  /** Stable target-scoped inbox id for one physical event delivered to several local agents. */
  deliveryId?: string
  /** Synchronous admission barrier, settled before any turn can start. */
  onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
  /** Hold an admitted entry before execution; false drops only that entry. */
  admissionWait?: Promise<boolean>
  /** Delay observed-inbound persistence until admissionWait succeeds. */
  deferObservedInbound?: boolean
}

/** Exactly what the webchat transport touches on the Daemon — nothing wider. */
export interface WebchatHost {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
  error(message: string): void
  now(): number
  store(): LocalStore
  agents(): Map<string, LoadedAgent>
  /** Local + CP routing rules, so a named webchat target resolves like any other. */
  mergedRules(): RoutingRule[]
  paused(agentId: string): boolean
  /** The bounded cause when this agent's runtime failed to start, so a refusal can name it
   *  instead of reporting the agent as absent. Undefined ⇒ no known start failure. */
  startFailure(agentId: string): string | undefined
  /** This agent is stopping an interrupted turn and cannot admit another. */
  safetyDraining(agentId: string): boolean
  /** The daemon as a whole is draining. */
  draining(): boolean
  agentDraining(agentId: string): boolean
  /** `features.turnFinalContextRefresh` — gates the admission-time observed inbound row. */
  turnFinalContextRefresh(): boolean
  inflight(): Set<string>
  serialQueue(): Map<string, QueueEntry[]>
  pending(): Map<string, Pending>
  /** Accepted heads that own the logical gate but have not reached Pending yet. */
  activeGateEntries(): Map<string, QueueEntry>
  interruptTurn(agentId: string, key: string, reason: 'cancel', acpSessionId?: string): Promise<void>
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: WebchatDispatchOptions
  ): Promise<string | null>
  integrationIdForSessionTransport(
    agentId: string,
    platform: string,
    transportScope?: string | null
  ): string | undefined
  connForIntegration(integrationId: string): WebchatReplyConnection | undefined
  botUserIds(): Record<string, string>
  resolveCpAgent(agentId: string, platform?: string): { botUserId: string } | null
  /** Fan a completed reply out to every relay this daemon holds. */
  sendWebchatPost(post: RdWebchatPost): void
  /** The directional call policy for an agent → agent edge. */
  collabAdmits(fromAgentId: string, toAgentId: string): boolean
}

export class WebchatTransport {
  /** Bounded, ephemeral reconnect state keyed by (turnId, agentId). */
  private readonly webchatStreams = new Map<string, WebchatTurnStream>()

  constructor(private readonly host: WebchatHost) {}

  dispose(): void {
    for (const [streamKey, stream] of this.webchatStreams) this.removeWebchatStream(streamKey, stream)
  }

  /** Cache the author's display handle under their stable principal, so session read-back
   *  (`senderName`), the permission card's requester line, and a session worktree's branch
   *  label all resolve a name from a row that stores only the id. Best-effort, like every
   *  other name-cache write: a failed write costs a label, never a turn. Skipped when the
   *  two are the same string — an older relay sent no principal to key on. */
  private async rememberAuthorName(author: WebchatAuthor): Promise<void> {
    if (!author.name || author.id === author.name) return
    try {
      await this.host.store().setDisplayName(author.id, author.name, Date.now())
    } catch (err) {
      this.host.debug(`webchat: author name cache write failed: ${formatErr(err)}`)
    }
  }

  /**
   * Dispatch one webchat turn onto the named agent and return the ack — transport-neutral:
   * the reply stream flows to `sink`. A webchat turn is a REAL session (recorded to the
   * transcript, visible in session/list); only its transport differs. The op names its
   * target agent explicitly (no trigger matching). Fed by the relay path (`rd/msg`).
   */
  async dispatchWebchatTurn(
    agentId: string,
    chatId: string,
    text: string,
    author: WebchatAuthor,
    sink: WebchatSink,
    requestedTurnId?: string,
    inlineImages?: WebchatImageAttachment[],
    requestedRuntime?: WebchatRuntimeConfig,
    remoteMcp?: WebchatRemoteMcpEntitlement,
    mentions?: string[],
    post?: { postId: string; at: number },
    postSink?: (p: RdWebchatPost) => void,
    requestedWorktree?: boolean
  ): Promise<WebchatAck> {
    const turnId = requestedTurnId ?? randomUUID()
    // Route directly to the named agent (bypasses arbitration); null when it isn't a
    // servable agent on this daemon.
    const result = routeRules(
      { platform: 'webchat', channel: chatId } as NormalizedMessage,
      this.host.mergedRules(),
      () => null,
      agentId
    )
    if (!result || !this.host.agents().has(result.agentId)) {
      // A failed ACP start drops the agent from the roster, so distinguish "its runtime did not
      // start" from "no daemon serves it" — the two read identically to a client otherwise.
      const startFailure = this.host.startFailure(result?.agentId ?? agentId)
      if (startFailure) {
        this.host.warn(`webchat: agent "${agentId}" failed to start — rejecting turn (${startFailure})`)
        return { accepted: false, turnId, reason: 'start_failed', detail: startFailure }
      }
      this.host.warn(`webchat: no agent "${agentId}" on this daemon — rejecting turn`)
      return { accepted: false, turnId, reason: 'no_agent' }
    }
    // Pause gate (#288): reject up-front with a specific reason. dispatch() would also
    // skip it, but the webchat ack is returned synchronously (before the fire-and-forget
    // dispatch), so a silent accept would leave the client waiting on a turn that never runs.
    if (this.host.paused(result.agentId)) {
      this.host.info(`webchat: agent "${result.agentId}" is paused — rejecting turn`)
      return { accepted: false, turnId, reason: 'paused' }
    }
    if (this.host.safetyDraining(result.agentId)) {
      this.host.info(`webchat: agent "${result.agentId}" is stopping an interrupted turn — rejecting turn`)
      return { accepted: false, turnId, reason: 'busy' }
    }
    // Drain gate: same reasoning as pause. dispatch() drops a draining agent's turn and
    // resolves null, but the ack is already returned — a silent accept would leave the
    // browser spinning with no reply and no terminal frame. Reject synchronously instead.
    if (this.host.draining() || this.host.agentDraining(result.agentId)) {
      this.host.info(`webchat: agent "${result.agentId}" is draining — rejecting turn`)
      return { accepted: false, turnId, reason: 'draining' }
    }
    await this.rememberAuthorName(author)
    // platform:'webchat', channel:conversationId, no thread (the wire SessionKey omits
    // it — §5), source:'user'. The trigger is a direct address (dm-equivalent) — webchat
    // always targets one agent. msgId is stable per-conversation (NOT per-turn) so every
    // turn in a conversation maps to the ONE local session (statusThread falls back to
    // msgId), giving the conversation continuity a real session — recorded, resumable,
    // listable — like any other. Fresh turnIds still correlate each reply stream.
    const msg: NormalizedMessage = {
      msgId: `webchat:${chatId}`,
      traceId: turnId,
      source: 'user',
      platform: 'webchat',
      channel: chatId,
      sender: { id: author.id, isBot: false, name: author.name },
      text,
      // Structured composer mentions (agent ids). This agent seeing ITSELF in
      // the list is the explicit-address fact (`trigger:'mention'` below); the
      // rest are prompt context (who else was addressed on this turn).
      mentionedBots: mentions ?? [],
      // The canonical post timestamp minted once at the relay — every
      // participant copy of this turn records the SAME transcript ts, which is
      // what lets co-hosted participants share one text row and cross-daemon
      // transcripts merge by (at, postId) (webchat-multi-agents.md §5.1).
      ...(post ? { transcriptTs: String(post.at), transcriptPostId: post.postId } : {}),
      ...(inlineImages?.length
        ? {
            attachments: inlineImages.map((image, index) => {
              const inlineData = Buffer.from(image.data, 'base64')
              return {
                id: `webchat:${turnId}:${index}`,
                name: image.name,
                mimeType: image.mimeType,
                size: inlineData.byteLength,
                inlineData
              }
            })
          }
        : {}),
      isDm: true,
      trigger: mentions?.includes(agentId) ? 'mention' : 'dm'
    }
    // dispatch() claims/enqueues synchronously inside its Promise executor, so this
    // exact-key preflight cannot race another admission on this event-loop tick. Without
    // it a queue-full rejection happens before a QueueEntry exists, leaving an accepted
    // webchat turn with no terminal `done` frame.
    const key = this.webchatSessionKey(chatId, result.agentId)
    if (this.host.inflight().has(key) && (this.host.serialQueue().get(key)?.length ?? 0) >= MAX_QUEUED_PER_SESSION) {
      this.host.warn(`webchat: queue full for session ${key} — rejecting turn`)
      return { accepted: false, turnId, reason: 'busy' }
    }
    this.pruneWebchatStreams()
    if (this.webchatStreams.has(this.webchatStreamKey(turnId, result.agentId))) {
      return { accepted: false, turnId, reason: 'busy' }
    }
    const initialRuntime =
      this.host.agents().get(result.agentId)?.allowRuntimeChangesInChat === true ? requestedRuntime : undefined
    const stream = this.createWebchatTurnStream(
      result.agentId,
      chatId,
      turnId,
      sink,
      initialRuntime,
      remoteMcp,
      requestedWorktree
    )
    if (postSink) stream.postSink = postSink
    // Observed-inbound analogue for webchat (turn-final refresh, §5.4): record the
    // user message at ADMISSION — not only when its turn eventually runs — so a
    // generation already in flight for this agent can see it at the final fence
    // and coalesce the queued activation. The identical later append from
    // SessionManager.handle dedups in place (same canonical ts, sender, text).
    if (post && this.host.turnFinalContextRefresh()) {
      const observedMention = attachmentMention(msg.attachments)
      // The bounded inline image must ride the ADMISSION write: it wins the slot,
      // and SessionManager's later identical append dedups via INSERT OR IGNORE —
      // an attachment-less row here would pin attachmentsJson to NULL, so the
      // session reader could neither strip the `[attached: …]` suffix nor hand
      // the console back the image.
      const observedAttachments = transcriptImageAttachments(msg.attachments)
      const observedTs = await appendWebchatTextRow(
        this.host.store(),
        transcriptChannelKey(chatId, undefined),
        `webchat:${chatId}`,
        String(post.at),
        {
          sender: author.id,
          recipient: result.agentId,
          // The canonical identity must ride the ADMISSION write too — without
          // it the probe falls back to (sender, text) and a distinct same-ms
          // same-text post from another tab would reuse this row instead of
          // bumping (§6).
          postId: post.postId,
          text: observedMention ? `${text}\n${observedMention}`.trim() : text,
          ...(observedAttachments.length ? { attachments: observedAttachments } : {})
        }
      )
      // The slot may have been collision-bumped (a self-authored row can occupy
      // the canonical millisecond). The message must carry the ts its row
      // ACTUALLY landed on: queue coalescing matches activations by
      // transcriptCoords ts, and a mismatch would run the follow-up again as a
      // separate turn after the regeneration already answered it.
      msg.transcriptTs = observedTs
    }
    void this.host.dispatch(result.agentId, msg, undefined, stream).catch((err) => {
      if (!(err instanceof LifecycleCleanupBlockedError))
        this.host.error(`webchat dispatch failed for agent "${result.agentId}": ${formatErr(err)}`)
    })
    return { accepted: true, turnId }
  }

  /**
   * Session-targeted continuation turn (webchat-cross-integration-continuation.md
   * §5.2/§6.4): dispatch one browser turn INTO an existing chat-origin session on
   * its own local coordinates — the `replyToSession` local shape with a human
   * sender — with the webchat stream attached as an additional sink. The human
   * turn is mirrored to the origin thread BEFORE dispatch, so platform
   * participants never miss input that changed the agent's context; a failed
   * mirror refuses the turn. The crash window between a delivered mirror and the
   * committed dispatch is the ordinary projection-failure boundary (not atomic).
   */
  async dispatchWebchatContinuationTurn(
    agentId: string,
    chatId: string,
    targetSessionId: string,
    text: string,
    author: WebchatAuthor,
    sink: WebchatSink,
    requestedTurnId?: string
  ): Promise<WebchatAck> {
    const turnId = requestedTurnId ?? randomUUID()
    if (!this.host.agents().has(agentId)) {
      const startFailure = this.host.startFailure(agentId)
      if (startFailure) return { accepted: false, turnId, reason: 'start_failed', detail: startFailure }
      return { accepted: false, turnId, reason: 'no_agent' }
    }
    // The console names the target session outwardly (session-concept.md §1.1). Resolve
    // agent-scoped, and use ONLY the local row's coordinates. A miss means the CP verdict is
    // stale (retention GC / metadata replacement) — fail closed.
    const local = await this.host.store().getSessionByOutwardId(targetSessionId, agentId)
    if (!local || originKindOf(local.platform) !== 'chat') return { accepted: false, turnId, reason: 'not_found' }
    if (this.host.paused(agentId)) return { accepted: false, turnId, reason: 'paused' }
    if (this.host.safetyDraining(agentId)) return { accepted: false, turnId, reason: 'busy' }
    if (this.host.draining() || this.host.agentDraining(agentId)) return { accepted: false, turnId, reason: 'draining' }
    const integrationId = this.host.integrationIdForSessionTransport(agentId, local.platform, local.transportScope)
    const conn = integrationId ? this.host.connForIntegration(integrationId) : undefined
    if (!integrationId || !conn) return { accepted: false, turnId, reason: 'integration_offline' }
    const botUserId =
      this.host.botUserIds()[integrationId] ?? this.host.resolveCpAgent(agentId, local.platform)?.botUserId
    await this.rememberAuthorName(author)
    const msg: NormalizedMessage = {
      msgId: `webchat-cont:${chatId}:${turnId}`,
      traceId: turnId,
      source: 'user',
      platform: local.platform,
      channel: local.channel,
      ...(local.thread ? { thread: local.thread } : {}),
      ...(local.transportScope ? { transportScope: local.transportScope } : {}),
      // Ordered as NEW content in the origin session (the replyToSession rule).
      transcriptTs: monotonicTs(),
      sender: { id: author.id, isBot: false, name: author.name },
      text,
      mentionedBots: botUserId ? [botUserId] : [],
      isDm: local.conversationKind === 'dm',
      trigger: local.conversationKind === 'dm' ? 'dm' : 'mention'
    }
    // The synthesized coordinates must rebuild the EXACT stored key, or dispatch
    // would mint a sibling session instead of continuing this one.
    const key = sessionKey(msg.platform, msg.channel, msg.thread ?? msg.msgId, agentId, msg.transportScope)
    if (key !== local.key) {
      this.host.warn(`webchat continuation: key mismatch for session ${targetSessionId} (${key} != ${local.key})`)
      return { accepted: false, turnId, reason: 'not_found' }
    }
    // Serial/queue preflight on the TARGET session's own key.
    if (this.host.inflight().has(key) && (this.host.serialQueue().get(key)?.length ?? 0) >= MAX_QUEUED_PER_SESSION) {
      return { accepted: false, turnId, reason: 'busy' }
    }
    this.pruneWebchatStreams()
    if (this.webchatStreams.has(this.webchatStreamKey(turnId, agentId))) {
      return { accepted: false, turnId, reason: 'busy' }
    }
    const stream = this.createWebchatTurnStream(agentId, chatId, turnId, sink)
    stream.continuation = true
    let settleMirror!: (mirrored: boolean) => void
    const mirrorAdmission = new Promise<boolean>((resolve) => {
      settleMirror = resolve
    })
    let settleAdmission!: (result: { accepted: boolean; reason?: string }) => void
    const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
      settleAdmission = resolve
    })
    const turn = this.host.dispatch(agentId, msg, integrationId, stream, undefined, {
      admissionWait: mirrorAdmission,
      deferObservedInbound: true,
      onAdmission: (result) => settleAdmission(result)
    })
    void turn.catch((err) => {
      if (!(err instanceof LifecycleCleanupBlockedError))
        this.host.error(`webchat continuation dispatch failed for agent "${agentId}": ${formatErr(err)}`)
      // A dispatch that rejected before admission settled must still release this barrier.
      settleAdmission({ accepted: false, reason: 'error' })
    })
    const admission = await admitted
    if (!admission.accepted) {
      settleMirror(false)
      this.removeWebchatStream(this.webchatStreamKey(turnId, agentId), stream)
      return { accepted: false, turnId, reason: admission.reason === 'draining' ? 'draining' : 'busy' }
    }
    // Admission owns a serial-queue slot before mirroring and waits for its result before execution.
    const mirrorText = `[${author.name} via console] ${text}`
    // The mirror takes the SAME two-step shape an ordinary agent reply does:
    // an attributed body post, then a finalizing chat.update stamping the
    // trusted routing claim (author = the target agent, root depth, unaddressed
    // final). The `message_changed` finalization is the ONE event every Slack
    // ingress admits before its own-bot echo suppression, so same-app/shared-bot
    // participants route it exactly like different-app observers do: thread
    // peers activate exactly-once via the durable rendezvous under their own
    // connection-fenced rules, and the author is excluded (it gets the targeted
    // dispatch). Platforms without a metadata claim degrade to transcript-only
    // peers, like agent replies there.
    let slackMirror: { conn: SlackConnection; ts: string } | undefined
    try {
      // postMessage resolves undefined when the provider swallows a send failure
      // (Discord/Feishu) or lands nothing (Slack) — only a returned message id
      // proves the mirror is visible, so undefined takes the failure path too.
      const mirrorId =
        local.platform === 'slack'
          ? await (conn as SlackConnection).postMessage(local.channel, mirrorText, local.thread || undefined, {
              agentAuthorId: agentId
            } satisfies SlackPostOptions)
          : await conn.postMessage(local.channel, mirrorText, local.thread || undefined)
      if (!mirrorId) throw new Error('provider returned no message id')
      if (local.platform === 'slack') slackMirror = { conn: conn as SlackConnection, ts: mirrorId }
      settleMirror(true)
    } catch (err) {
      this.host.warn(`webchat continuation: mirror post failed for ${local.key}: ${formatErr(err)}`)
      this.removeWebchatStream(this.webchatStreamKey(turnId, agentId), stream)
      settleMirror(false)
      return { accepted: false, turnId, reason: 'integration_delivery_failed' }
    }
    // Routing finalization is best-effort AFTER the proven post, mirroring
    // turn-output's contract: a failed update degrades to unrouted peers,
    // never to a hidden or mis-routed input. Duck-typed for test fakes.
    if (slackMirror && typeof slackMirror.conn.finalizeResponse === 'function') {
      const finalized = await slackMirror.conn.finalizeResponse(
        local.channel,
        slackMirror.ts,
        [{ type: 'markdown', text: mirrorText }],
        mirrorText,
        agentId,
        { responseId: msg.msgId, deliveryState: 'final', hopCount: 0, mentionedAgentIds: [] }
      )
      if (!finalized)
        this.host.warn(`webchat continuation: mirror finalization failed for ${local.key} (peers unrouted)`)
    }
    this.host.info(
      `webchat continuation: ${author.name} → session ${local.key} (conversation ${chatId}, turn ${turnId})`
    )
    return { accepted: true, turnId }
  }

  /** Handle a webchat conversation close (relay `close` op). No live resources are
   *  bound per-conversation (the session TTL-closes like any other), so this is
   *  currently just observability — the in-flight turn, if any, runs to completion. */
  handleWebchatClose(conversationId: string): void {
    this.host.debug(`webchat: conversation ${conversationId} closed by client`)
  }

  /** The local session key a webchat conversation maps to — mirrors `dispatchWebchatTurn`
   *  (channel = conversationId, statusThread = the stable `webchat:<id>` msgId, no thread). */
  webchatSessionKey(conversationId: string, agentId: string): string {
    return sessionKey('webchat', conversationId, `webchat:${conversationId}`, agentId)
  }

  /** Replay-window key: one browser turn fans out to N participants, and two of
   *  them may be co-hosted on THIS daemon — each (turnId, agentId) pair owns its
   *  own stream (webchat-multi-agents.md §5.3). */
  webchatStreamKey(turnId: string, agentId: string): string {
    return `${turnId}:${agentId}`
  }

  /** Wrap the turn's relay-bound transport with daemon-owned bounded replay. The
   * turn engine keeps calling the stable wrapper while resume swaps only the raw
   * transport underneath it. */
  createWebchatTurnStream(
    agentId: string,
    conversationId: string,
    turnId: string,
    transport: WebchatSink,
    runtime?: WebchatRuntimeConfig,
    remoteMcp?: WebchatRemoteMcpEntitlement,
    worktree?: boolean
  ): WebchatTurnStream {
    this.pruneWebchatStreams()
    const stream: WebchatTurnStream = {
      agentId,
      conversationId,
      turnId,
      transport,
      ...(runtime ? { runtime } : {}),
      ...(worktree !== undefined ? { worktree } : {}),
      ...(remoteMcp ? { remoteMcp } : {}),
      resumeGeneration: 0,
      sink: {
        output: (output) => this.publishWebchatStreamEvent(stream, { kind: 'output', output }),
        done: (done) => this.publishWebchatStreamEvent(stream, { kind: 'done', done })
      },
      replay: [],
      replayBytes: 0,
      replayFloor: 0,
      replayDisabled: false,
      lastOutputIndex: -1
    }
    this.webchatStreams.set(this.webchatStreamKey(turnId, agentId), stream)
    this.pruneWebchatStreams()
    return stream
  }

  /**
   * A post-only `WebchatTurnContext` for a turn that wakes an agent INSIDE a webchat
   * conversation from another agent — `sendMessage`/lineage-reply, same-daemon or
   * cross-daemon (#753). Such a wake has no browser turn of its own (no turnId, no
   * `rd/chat` socket) to stream through, so `sink` is a no-op; only the
   * completed-reply boundary needs a live transport, and `postSink` fans that out to
   * every relay this daemon holds via {@link RelayManager.sendWebchatPost} (any relay
   * without this conversation's browser connection or roster cache just drops it).
   *
   * `conversationId` must be the browser's real UUID chatId, not just any webchat-
   * platform channel: `CpCollabRoutes.coordsDecision` never finds a webchat conversation
   * "known" (the CP's collab snapshot has no notion of one), so a fresh `toAgent`+
   * `channel` wake ALWAYS substitutes the synthetic, caller-derived `a2a:<callerId>`
   * channel (`a2aCoordChannel`) regardless of what channel was asserted — that private
   * pairwise session has no browser watching it at all. Only a REPLY routed back into an
   * existing origin session (`origin.channel`/`local.channel`, read from the session row
   * directly rather than re-derived through `coordsDecision`) can carry the genuine
   * conversationId. `RdWebchatPost.conversationId` is schema-validated `.uuid()` too —
   * this guard is what keeps a synthetic channel from ever reaching the wire.
   */
  webchatWakeContext(platform: string, conversationId: string): WebchatTurnContext | undefined {
    if (platform !== 'webchat' || !UUID_RE.test(conversationId)) return undefined
    return {
      conversationId,
      turnId: randomUUID(),
      sink: { output: () => undefined, done: () => undefined },
      initiator: 'agent',
      postSink: (post) => this.host.sendWebchatPost(post)
    }
  }

  /** The inbound half of an agent-initiated webchat wake: post the SENDER's message live
   *  at admission (#807 posted only the woken reply, so this message reached the browser
   *  only via a page refresh). Shares `msg.transcriptPostId` with the transcript row the
   *  turn writes, so the browser drops the live step once the canonical row lands. */
  postAgentWakeInbound(webchat: WebchatTurnContext | undefined, msg: NormalizedMessage): void {
    if (webchat?.initiator !== 'agent' || !webchat.postSink) return
    // #966: a child's report resumes its parent session only — never a room-visible post.
    if (msg.parentReport === true) return
    if (!msg.transcriptPostId || !UUID_RE.test(msg.sender.id)) return
    msg.transcriptTs ??= monotonicTs() // every wake site sets it; keep row ts == post.at regardless
    webchat.postSink({
      conversationId: webchat.conversationId,
      agentId: msg.sender.id,
      post: {
        postId: msg.transcriptPostId,
        conversationId: webchat.conversationId,
        author: { kind: 'agent', agentId: msg.sender.id },
        text: msg.text,
        at: Number(msg.transcriptTs)
      },
      initiator: 'agent'
    })
  }

  /** Buffer before sending so a transport gap is recoverable even when the live
   * write is lost. The terminal frame carries the final output index for browser
   * gap detection. */
  publishWebchatStreamEvent(stream: WebchatTurnStream, event: RdChatEvent): void {
    // Every frame is attributed to the streaming participant here — the one
    // choke point all turn events flow through — so a multi-agent conversation
    // renders one lane per (turnId, agentId) without touching each emit site.
    const normalized: RdChatEvent =
      event.kind === 'output'
        ? { kind: 'output', output: { ...event.output, agentId: stream.agentId } }
        : { kind: 'done', done: { ...event.done, agentId: stream.agentId, lastIndex: stream.lastOutputIndex } }
    if (normalized.kind === 'output') {
      stream.lastOutputIndex = Math.max(stream.lastOutputIndex, normalized.output.index)
    }
    if (!stream.replayDisabled) this.bufferWebchatStreamEvent(stream, normalized)
    this.deliverWebchatStreamEvent(stream.transport, normalized)
    if (normalized.kind === 'done') {
      stream.completedAt = this.host.now()
      this.pruneWebchatStreams()
    }
  }

  bufferWebchatStreamEvent(stream: WebchatTurnStream, event: RdChatEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    stream.replay.push({ event, bytes })
    stream.replayBytes += bytes
    while (stream.replay.length > WEBCHAT_REPLAY_MAX_EVENTS || stream.replayBytes > WEBCHAT_REPLAY_MAX_BYTES) {
      const dropped = stream.replay.shift()
      if (!dropped) break
      stream.replayBytes -= dropped.bytes
      if (dropped.event.kind === 'output') {
        stream.replayFloor = Math.max(stream.replayFloor, dropped.event.output.index + 1)
      } else {
        // A terminal frame is tiny and should never be the overflow victim. Fail
        // closed if a future payload shape violates that assumption.
        stream.replayDisabled = true
        stream.replay = []
        stream.replayBytes = 0
        break
      }
    }
  }

  deliverWebchatStreamEvent(sink: WebchatSink, event: RdChatEvent): void {
    if (event.kind === 'output') sink.output(event.output)
    else sink.done(event.done)
  }

  /** Cold-load discovery (`attach`, webchat-attach-v1): name the live stream for
   *  (conversation, agent) so a browser that reloaded mid-turn can resume it from
   *  scratch. Read-only — the follow-up `resume` does the rebind + replay. */
  probeWebchatStream(
    agentId: string,
    conversationId: string
  ): { accepted: boolean; turnId?: string; generation?: number; reason?: string } {
    this.pruneWebchatStreams()
    let match: WebchatTurnStream | undefined
    for (const stream of this.webchatStreams.values()) {
      if (stream.agentId !== agentId || stream.conversationId !== conversationId) continue
      // A completed turn is already in the transcript; nothing live to reattach.
      if (stream.completedAt !== undefined || stream.replayDisabled) continue
      match = stream // insertion order: the last match is the newest admitted turn
    }
    if (!match) return { accepted: false, reason: 'stream_not_found' }
    // A trimmed replay head cannot rebuild the reply from scratch — refuse; the
    // transcript covers it at turn end.
    if (match.replayFloor > 0) return { accepted: false, turnId: match.turnId, reason: 'stream_gap' }
    return { accepted: true, turnId: match.turnId, generation: match.resumeGeneration }
  }

  resumeWebchatStream(
    agentId: string,
    conversationId: string,
    turnId: string,
    generation: number,
    afterIndex: number,
    transport: WebchatSink
  ): { accepted: boolean; turnId?: string; reason?: string } {
    this.pruneWebchatStreams()
    const stream = this.webchatStreams.get(this.webchatStreamKey(turnId, agentId))
    if (!stream || stream.agentId !== agentId || stream.conversationId !== conversationId) {
      return { accepted: false, reason: 'stream_not_found' }
    }
    if (generation <= stream.resumeGeneration) {
      return { accepted: false, turnId: stream.turnId, reason: 'stream_stale' }
    }
    // Claim the newer connection generation before validating its cursor. Even a
    // failed newer resume must fence an older request that is still in flight.
    stream.resumeGeneration = generation
    if (stream.replayDisabled || afterIndex < stream.replayFloor - 1) {
      return { accepted: false, turnId: stream.turnId, reason: 'stream_gap' }
    }
    if (afterIndex > stream.lastOutputIndex) {
      return { accepted: false, turnId: stream.turnId, reason: 'stream_cursor_invalid' }
    }

    // Rebind first: outputs produced after this synchronous replay leave through
    // the same new relay connection. Replay bypasses the stable buffering wrapper
    // so retained frames are not inserted twice.
    stream.transport = transport
    for (const buffered of stream.replay) {
      if (buffered.event.kind === 'output' && buffered.event.output.index <= afterIndex) continue
      this.deliverWebchatStreamEvent(transport, buffered.event)
    }
    return { accepted: true, turnId: stream.turnId }
  }

  removeWebchatStream(streamKey: string, stream: WebchatTurnStream): void {
    this.webchatStreams.delete(streamKey)
    stream.replayDisabled = true
    stream.replay = []
    stream.replayBytes = 0
  }

  pruneWebchatStreams(): void {
    const now = this.host.now()
    for (const [streamKey, stream] of this.webchatStreams) {
      if (stream.completedAt !== undefined && now - stream.completedAt > WEBCHAT_REPLAY_TTL_MS) {
        this.removeWebchatStream(streamKey, stream)
      }
    }
    while (this.webchatStreams.size > WEBCHAT_REPLAY_MAX_STREAMS) {
      const completed =
        [...this.webchatStreams].find(([, stream]) => stream.completedAt !== undefined) ??
        this.webchatStreams.entries().next().value
      if (!completed) break
      this.removeWebchatStream(completed[0], completed[1])
    }
  }

  /** Handle a webchat cancel (the relay `cancel` op / status-bar "Cancel"). Interrupts
   *  the conversation's in-flight turn like `!cancel` (no mute; follow-ups still dispatch).
   *  `agentId` scopes the cancel to one participant's turn (multi-agent conversations —
   *  the relay addresses each participant daemon with its own agent); absent cancels
   *  every matching turn on this daemon. No-op when idle. */
  async handleWebchatCancel(conversationId: string, agentId?: string): Promise<void> {
    const matches = (a: string, convId?: string): boolean =>
      convId === conversationId && (agentId === undefined || a === agentId)
    const interrupted = new Set<string>()
    for (const p of this.host.pending().values()) {
      if (matches(p.plan.agentId, p.webchat?.conversationId) && !interrupted.has(p.plan.sessionKey)) {
        interrupted.add(p.plan.sessionKey)
        await this.host.interruptTurn(p.plan.agentId, p.plan.sessionKey, 'cancel', p.acpSessionId)
      }
    }
    // Cold accepted head: it owns the logical gate but has not reached Pending yet.
    for (const [key, entry] of this.host.activeGateEntries()) {
      if (matches(entry.agentId, entry.webchat?.conversationId) && !interrupted.has(key)) {
        interrupted.add(key)
        await this.host.interruptTurn(entry.agentId, key, 'cancel')
      }
    }
    if (interrupted.size > 0) return
    // No live turn — the conversation may still have messages queued behind the gate
    // (§6.9 #390): drain+reject them by their sessionKey so the client's turns settle.
    for (const [key, entries] of this.host.serialQueue()) {
      const hit = entries.find((e) => matches(e.agentId, e.webchat?.conversationId))
      if (hit) {
        await this.host.interruptTurn(hit.agentId, key, 'cancel')
        return
      }
    }
    this.host.debug(`webchat cancel: no in-flight turn for conversation ${conversationId}`)
  }

  /**
   * Record a conversation post another participant produced (relay `context` op —
   * webchat-multi-agents.md §5.2): the row lands in the shared conversation log with
   * the carried canonical `at`, and the §8.5 catch-up replay presents it as
   * `[<author>] <text>` context at this agent's next activation. The relay excludes
   * the authoring participant from the fan-out; the self-drop here is the fail-safe
   * mirror of `isAgentBotMessage` on the IM path.
   *
   * Recording is unconditional and activation-free. Whether the recorded post ALSO
   * continues the conversation for this participant is a separate decision
   * ({@link maybeActivateWebchatContinuation}, §5.2a) taken by the caller with the
   * landed ts this returns — `undefined` means nothing was recorded (self copy,
   * conversation mismatch, or an empty body) and nothing may activate either.
   */
  async recordWebchatContextPost(
    agentId: string,
    chatId: string,
    contextPost: WebchatPost
  ): Promise<string | undefined> {
    if (contextPost.conversationId !== chatId) return undefined
    if (contextPost.author.kind === 'agent' && contextPost.author.agentId === agentId) return undefined
    if (!contextPost.text.trim() && !contextPost.attachments?.length) return undefined
    const sender =
      contextPost.author.kind === 'agent'
        ? contextPost.author.agentId
        : (contextPost.author.userId ?? contextPost.author.user ?? 'webchat')
    // Same display-name cache the targeted turn writes, so a fanned-out copy the
    // recipient recorded FIRST still labels its author by name on read-back.
    if (contextPost.author.kind === 'user' && contextPost.author.userId && contextPost.author.user) {
      await this.rememberAuthorName({ id: contextPost.author.userId, name: contextPost.author.user })
    }
    // The canonical origin-minted ts. A re-fanned identical copy dedups in place
    // (the recipient tag still records the delivery for THIS agent when the text
    // row was already written by a co-hosted participant's turn); a foreign post
    // occupying the slot bumps by 1 ms instead of being silently dropped.
    return appendWebchatTextRow(
      this.host.store(),
      transcriptChannelKey(chatId, undefined),
      `webchat:${chatId}`,
      String(contextPost.at),
      {
        sender,
        recipient: agentId,
        postId: contextPost.postId,
        text: contextPost.text,
        ...(contextPost.author.kind === 'agent' ? { trustedAgentBot: true } : {}),
        ...(contextPost.attachments?.length
          ? {
              attachments: contextPost.attachments.map((a) => ({
                name: a.name,
                mimeType: a.mimeType,
                data: a.data
              }))
            }
          : {})
      }
    )
  }

  /**
   * The webchat analogue of the §6 verified-agent continuation ladder (#549 parity —
   * webchat-multi-agents.md §5.2a, issue #904): a peer agent's COMMITTED conversation
   * post, fanned to this pre-addressed participant as a `context` frame, wakes it
   * instead of staying transcript-only. The relay's roster fan-out already excluded the
   * author and chose the targets, so no arbitration happens here — only the checks the
   * platform ladder applies to an implicitly selected edge, because those are
   * properties of the EDGE and an implicit edge is still an agent call:
   *
   *  - author exclusion is absolute (fail-safe re-check; the relay already skips the
   *    author, and `recordWebchatContextPost` drops self copies before this runs);
   *  - the hop transition: ONE +1 against the SAME `MAX_AGENT_CALL_HOPS` budget an
   *    internal call spends, computed from the depth the author's daemon stamped on
   *    the post. A post with no usable depth (a pre-parity daemon) must never coerce
   *    to zero — it stays transcript-only, mirroring §4.1 rule 1;
   *  - final-events-only is structural: `rd/webchat-post` (and therefore `context`)
   *    exists only for a committed reply — streaming rides `rd/chat` and cannot
   *    reach here, and a silent `AC_NO_RESPONSE` decline commits no post at all;
   *  - the directional call policy (`cpCollab.admits`), per edge;
   *  - exactly-once per (post, target) through the durable activation rendezvous, so
   *    a relay retry, doubly-connected relays, and a restart replay cannot
   *    double-wake;
   *  - the coarse loop guard is deliberately NOT charged, mirroring `usesLoopGuard`:
   *    agent continuations have an exact trusted hop cap, and webchat has no in-band
   *    `!resume` surface to reset a latch with.
   *
   * The woken turn carries the depth on its CallMeta, so the reply IT commits stamps
   * `hopCount + …` and advances the chain by one — an alternating A↔B conversation
   * now terminates by reaching the hop cap (with the refusal recorded below) rather
   * than by an agent declining to address anyone. A woken agent that answers with the
   * no-response sentinel stays silent — no post, so nothing further fans out — but its
   * wake still spent the hop like any other admitted turn.
   *
   * Scope: this seam only ever sees relay `context` frames, which exist solely for
   * MULTI-AGENT webchat conversations — single-agent conversations, the platform
   * ladders, and playground sessions are structurally unreachable from here.
   */
  async maybeActivateWebchatContinuation(
    targetAgentId: string,
    chatId: string,
    contextPost: WebchatPost,
    landedTs: string
  ): Promise<void> {
    // The PURE edge decision is package policy (`webchatContinuationDecision`):
    // user-post/self/fail-closed-depth exclusions and the §4.1 hop transition.
    // This adapter supplies the facts and owns the impure remainder below —
    // liveness, call policy, the exactly-once rendezvous, logging, dispatch.
    const decision = webchatContinuationDecision(contextPost.author, targetAgentId)
    if (!decision.activate) {
      if (decision.reason === 'no_usable_depth') {
        this.host.debug(
          `webchat: peer post ${contextPost.postId} carries no usable depth — transcript-only (pre-parity author daemon)`
        )
      } else if (decision.reason === 'hop_limit') {
        this.host.info(
          `webchat: continuation refused for "${targetAgentId}" in conversation ${chatId} ` +
            `(hop_limit: source depth ${decision.sourceHopCount} + 1 reaches ${decision.cap}); ` +
            `peer post ${contextPost.postId} stays transcript-only`
        )
      }
      return
    }
    const { authorAgentId, deliveryHopCount } = decision
    if (!this.host.agents().has(targetAgentId) || this.host.agentDraining(targetAgentId)) return
    if (!this.host.collabAdmits(authorAgentId, targetAgentId)) {
      this.host.debug(`webchat: agent edge ${authorAgentId} → ${targetAgentId} denied by call policy`)
      return
    }
    const webchat = this.webchatWakeContext('webchat', chatId)
    if (!webchat) return
    // TARGET-SCOPED, like the platform ladder's key: one post fans to several
    // participants and each must be admitted once, independently of the others.
    const key = activationKey('webchat', undefined, contextPost.postId, targetAgentId)
    const deliveryId = `${contextPost.postId}#${targetAgentId}`
    const envelope = JSON.stringify({
      kind: 'webchat-continuation',
      callFrom: authorAgentId,
      hopCount: deliveryHopCount
    })
    const claimed = await this.host
      .store()
      .attachActivationEnvelope(key, envelope, this.host.now() + ACTIVATION_PAIRING_TTL_MS, deliveryId)
    if (!claimed.dispatch) {
      this.host.debug(
        `webchat: peer post ${contextPost.postId} → "${targetAgentId}" already admitted (${claimed.record.state})`
      )
      return
    }
    const msg: NormalizedMessage = {
      msgId: `webchat:${chatId}`, // the conversation-stable id, so the wake lands in the ONE conversation session
      traceId: deliveryId,
      source: 'agent',
      platform: 'webchat',
      channel: chatId,
      sender: { id: authorAgentId, isBot: true },
      // A `source:'agent'` trigger is delivered bare (no `[sender]` wrapping in prompt
      // assembly), so carry the author label in the text — the same `[<author>] <text>`
      // shape the §8.5 context replay uses for peer rows.
      text: `[${authorAgentId}] ${contextPost.text}`,
      mentionedBots: [],
      // The canonical coordinates its context row landed on, so SessionManager's
      // trigger append dedups onto the recorded row (by postId) and the turn-final
      // refresh queue-coalescing can match this activation to its transcript event.
      transcriptTs: landedTs,
      transcriptPostId: contextPost.postId,
      isDm: true
    }
    const callMeta: CallMeta = {
      callFrom: authorAgentId,
      // §4.1 step 3/5: install the computed depth as trusted active-turn metadata, so
      // the reply this target commits stamps it as the NEXT post's source depth —
      // across queue replay and restart, since it persists with the inbox row.
      hopCount: deliveryHopCount,
      deliveryId,
      // §8.6: settled centrally in `dispatch` — live, queued, and startup replay alike.
      activationKey: key,
      conversationContinuation: true
    }
    void this.host
      .dispatch(targetAgentId, msg, undefined, webchat, callMeta, {
        // `accepted` must imply a replayable row, or the rendezvous goes terminal for a
        // turn that can never be replayed — same contract as the platform ladder.
        requireDurable: true,
        deliveryId
      })
      .catch((err) =>
        this.host.error(`webchat continuation dispatch failed for agent "${targetAgentId}": ${formatErr(err)}`)
      )
    this.host.info(
      `routing: webchat peer post ch=${chatId} "${authorAgentId}" → "${targetAgentId}" (hop ${deliveryHopCount})`
    )
  }
}
