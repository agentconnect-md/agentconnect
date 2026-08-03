/**
 * Feishu / Lark's **turn-output surface** (integration-plugin-architecture.md
 * §7.3, stage S2).
 *
 * This is the extraction the state slot was designed for. Feishu streams through
 * a CardKit reply ENTITY — one card created at turn start, updated as the answer
 * grows, finished or cancelled at the end — so it is the platform with real
 * per-turn state: the card handle, whether creation was attempted, and the
 * periodic element-flush timer. All three used to sit on the core turn record as
 * `feishuCard` / `feishuCardAttempted` / `feishuStreamTimer`; they now live in
 * this module's own state shape, which core stores opaquely and never reads.
 *
 * The host port grows by exactly one over Telegram's and Discord's: the card
 * carries a deep link back to the session, and only core knows how a session URL
 * is built. Everything else is Feishu's.
 */
import type { FeishuConnection, FeishuStreamingCard } from '../../feishu/connection.js'
import type { FeishuAction } from '../../feishu/render.js'

/** Feishu's opaque per-turn state (§7.3) — its CardKit reply entity and the
 *  flush timer that streams elements into it. */
export interface FeishuTurnState {
  /** The turn's one CardKit reply entity. Undefined until `card-start` succeeds;
   *  `cardAttempted` prevents duplicate initial cards. */
  card?: FeishuStreamingCard
  cardAttempted?: boolean
  /** Periodic cumulative CardKit element flush (separate from the transcript idle
   *  flush core owns). */
  streamTimer?: NodeJS.Timeout
}

/** The core turn, as Feishu's applier sees it. `Pending` satisfies it structurally. */
export interface FeishuTurn {
  conn?: unknown
  channel: string
  thread?: string
  statusThread: string
  transcriptChannel: string
  agentId: string
  sessionKey: string
  acpSessionId: string
  platform: string
  integrationId?: string
  progressTs?: string
  progressAttempted?: boolean
  planTs?: string
  planAttempted?: boolean
  reasoningTs?: string
  reasoningAttempted?: boolean
}

/** The host capabilities this applier needs: the two every platform needs, plus
 *  the session deep link a streaming card renders in its header. */
export interface FeishuTurnHost<TTurn> {
  recordReplySegment(turn: TTurn, text: string): void
  appendTranscript(row: {
    channel: string
    thread: string
    ts: string
    sender: string
    kind: 'text'
    text: string
  }): void
  /** The console URL for this turn's session — core owns link construction
   *  (deployment origin, per-platform `?source=` hint). */
  sessionUrl(turn: TTurn): string
}

/** Apply one converger action against the turn's Feishu connection. */
export async function applyFeishuAction<TTurn extends FeishuTurn>(
  host: FeishuTurnHost<TTurn>,
  turn: TTurn,
  state: FeishuTurnState,
  action: FeishuAction
): Promise<void> {
  if (action.kind === 'post' && action.recordOnly) {
    host.recordReplySegment(turn, action.text)
    return
  }
  // Routed here only for the feishu platform (see the turn-output registry), so the
  // turn's connection is a Feishu one (or a test fake) — cast, not instanceof.
  // Headless no-ops.
  const conn = turn.conn as FeishuConnection | undefined
  if (!conn) return
  switch (action.kind) {
    case 'card-start':
      if (state.cardAttempted) return
      state.cardAttempted = true
      state.card = await conn.startStreamingCard(turn.channel, turn.thread, {
        sessionKey: turn.sessionKey,
        sessionUrl: host.sessionUrl(turn),
        ...(turn.integrationId
          ? { target: { v: 1, agentId: turn.agentId, integrationId: turn.integrationId } as const }
          : {})
      })
      return
    case 'card-stream':
      if (state.card) await conn.updateStreamingCard(turn.channel, state.card, action.text)
      return
    case 'card-final': {
      if (state.card) {
        const delivered = await conn.finishStreamingCard(turn.channel, state.card, action.text, action.attribution)
        if (delivered) return
        // A final CardKit update failure must not lose the answer. Remove the stale
        // partial card where possible, then fall back to ordinary text.
        await conn.cancelStreamingCard(turn.channel, state.card)
      }
      await conn.postMessage(turn.channel, action.text, turn.thread)
      return
    }
    case 'card-cancel':
      if (state.card) await conn.cancelStreamingCard(turn.channel, state.card)
      return
    case 'typing':
      await conn.sendChatAction(turn.channel)
      return
    case 'post': {
      const id = await conn.postMessage(turn.channel, action.text, turn.thread)
      host.appendTranscript({
        channel: turn.transcriptChannel,
        thread: turn.statusThread,
        ts: id ?? `local-${Date.now()}`,
        sender: turn.agentId,
        kind: 'text',
        text: action.text
      })
      return
    }
    case 'notice':
    case 'tool-output':
      // Posted to the chat but NOT recorded — the done footer is chrome, and tool
      // output is captured independently by the recorder.
      await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      return
    case 'progress':
      if (turn.progressTs) await conn.updateMessage(turn.channel, turn.progressTs, action.text)
      else if (!turn.progressAttempted) {
        turn.progressAttempted = true
        turn.progressTs = await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      }
      return
    case 'plan':
      if (turn.planTs) await conn.updateMessage(turn.channel, turn.planTs, action.text)
      else if (!turn.planAttempted) {
        turn.planAttempted = true
        turn.planTs = await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      }
      return
    case 'reasoning':
      if (turn.reasoningTs) await conn.updateMessage(turn.channel, turn.reasoningTs, action.text)
      else if (!turn.reasoningAttempted) {
        turn.reasoningAttempted = true
        turn.reasoningTs = await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      }
      return
  }
}
