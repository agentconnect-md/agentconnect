/**
 * Telegram's **turn-output surface** (integration-plugin-architecture.md §7.3,
 * stage S2) — the first platform body to move out of `daemon.ts` against the
 * seam published there.
 *
 * What it proves: the seam supports an applier living outside core. This one
 * needs exactly two host capabilities — recording a reply segment and appending
 * a transcript row — and a structural view of the turn. Everything else it
 * touches is Telegram's own (`TelegramConnection`, the reply anchor, the
 * message-edit ceiling), which is what "platform-shaped" means in §7.3.
 *
 * The turn is taken STRUCTURALLY, not as the core `Pending` type: a platform
 * borrows the fields it renders with and cannot reach the rest of core's turn
 * machinery. That is the boundary — if a future action needs more, the addition
 * is visible here rather than smuggled in through a wide type.
 */
import type { TelegramConnection } from '../../telegram/connection.js'
import { TELEGRAM_MESSAGE_LIMIT, type TelegramAction } from '../../telegram/render.js'

/**
 * Telegram's opaque per-turn state (§7.3). Core stores it and never reads it.
 *
 * `lastBody` used to be `Pending.tgLastBody` — a platform-named field on the core
 * turn record, the same accretion the state slot exists to stop.
 */
export interface TelegramTurnState {
  /** The message id every post this turn replies to (the triggering message —
   *  "the last message in the session" at turn start), so the bot's answer threads
   *  under it and a human reply-to-bot stitches back to this session. */
  replyTo?: number
  /** The turn's newest body message, so a turn-end `continue-hint` can annotate
   *  the message users are actually told to reply to. */
  lastBody?: { id: string; text: string }
}

/** The core turn, as Telegram's applier sees it — the fields it renders with and
 *  nothing more. `Pending` satisfies this structurally. */
export interface TelegramTurn {
  conn?: unknown
  channel: string
  thread?: string
  statusThread: string
  transcriptChannel: string
  agentId: string
  progressTs?: string
  progressAttempted?: boolean
  planTs?: string
  planAttempted?: boolean
  reasoningTs?: string
  reasoningAttempted?: boolean
  liveReplyTs?: string
  liveReplyText?: string
  liveReplyAttempted?: boolean
}

/** The host capabilities this applier needs. Two — both about recording what was
 *  said, which core owns because the transcript is not platform-shaped. */
export interface TelegramTurnHost<TTurn> {
  /** `minimal` mode records each reply segment WITHOUT sending it (the chat shows
   *  only the single `live-reply`). */
  recordReplySegment(turn: TTurn, text: string): Promise<void>
  appendTranscript(row: {
    channel: string
    thread: string
    ts: string
    sender: string
    kind: 'text'
    text: string
  }): Promise<void>
}

/** Apply one converger action against the turn's Telegram connection. */
export async function applyTelegramAction<TTurn extends TelegramTurn>(
  host: TelegramTurnHost<TTurn>,
  turn: TTurn,
  state: TelegramTurnState,
  action: TelegramAction
): Promise<void> {
  // minimal mode records each reply segment WITHOUT sending it — the chat shows only the
  // single `live-reply` (see the Slack applier / recordReplySegment).
  if (action.kind === 'post' && action.recordOnly) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  // Routed here only for the telegram platform (see the turn-output registry), so the
  // turn's connection is a Telegram one (or a test fake) — cast, not instanceof.
  // Headless no-ops.
  const conn = turn.conn as TelegramConnection | undefined
  if (!conn) return
  switch (action.kind) {
    case 'typing':
      await conn.sendChatAction(turn.channel)
      return
    case 'post': {
      // The continue-the-topic hint is chrome: sent with the reply (so it lands on the very
      // message users are told to reply to) but kept out of the recorded text below.
      const sent = action.hint ? `${action.text}\n\n${action.hint}` : action.text
      const id = await conn.postMessage(turn.channel, sent, turn.thread, { replyTo: state.replyTo })
      // Remember the newest body message so a turn-end `continue-hint` can annotate it.
      if (id) state.lastBody = { id, text: sent }
      await host.appendTranscript({
        channel: turn.transcriptChannel,
        thread: turn.statusThread,
        ts: id ?? `local-${Date.now()}`,
        sender: turn.agentId,
        kind: 'text',
        text: action.text
      })
      return
    }
    case 'continue-hint': {
      // The turn's last body went out earlier (idle flush / tool boundary), so the hint
      // lands by editing that message. Skipped when its id is unknown (a failed send) or
      // when the suffix would not fit — the converger reserves room for it in the body
      // budget, so this guard only fires for text that predates the reservation.
      const last = state.lastBody
      if (!last || last.text.endsWith(action.hint)) return
      const sent = `${last.text}\n\n${action.hint}`
      if (sent.length > TELEGRAM_MESSAGE_LIMIT) return
      state.lastBody = { id: last.id, text: sent }
      await conn.updateMessage(turn.channel, last.id, sent)
      return
    }
    case 'live-reply': {
      // minimal mode's single agent reply: send once (plain text) then edit in place as the
      // turn streams. Skip an update when unchanged; not recorded (the `recordOnly` posts do).
      if (turn.liveReplyText === action.text) return
      turn.liveReplyText = action.text
      if (turn.liveReplyTs) await conn.updateMessage(turn.channel, turn.liveReplyTs, action.text)
      else if (!turn.liveReplyAttempted) {
        turn.liveReplyAttempted = true
        turn.liveReplyTs = await conn.postMessage(turn.channel, action.text, turn.thread, {
          replyTo: state.replyTo
        })
      }
      return
    }
    case 'notice':
    case 'tool-output':
      // Posted to the chat but NOT recorded — the done footer is chrome, and tool
      // output is captured independently by the recorder.
      await conn.postChrome(turn.channel, action.text, {
        parseMode: action.parseMode,
        threadTs: turn.thread,
        replyTo: state.replyTo
      })
      return
    case 'progress':
      if (turn.progressTs)
        await conn.updateMessage(turn.channel, turn.progressTs, action.text, { parseMode: action.parseMode })
      else if (!turn.progressAttempted) {
        turn.progressAttempted = true
        turn.progressTs = await conn.postChrome(turn.channel, action.text, {
          parseMode: action.parseMode,
          threadTs: turn.thread,
          replyTo: state.replyTo
        })
      }
      return
    case 'plan':
      if (turn.planTs) await conn.updateMessage(turn.channel, turn.planTs, action.text, { parseMode: action.parseMode })
      else if (!turn.planAttempted) {
        turn.planAttempted = true
        turn.planTs = await conn.postChrome(turn.channel, action.text, {
          parseMode: action.parseMode,
          threadTs: turn.thread,
          replyTo: state.replyTo
        })
      }
      return
    case 'reasoning':
      if (turn.reasoningTs)
        await conn.updateMessage(turn.channel, turn.reasoningTs, action.text, { parseMode: action.parseMode })
      else if (!turn.reasoningAttempted) {
        turn.reasoningAttempted = true
        turn.reasoningTs = await conn.postChrome(turn.channel, action.text, {
          parseMode: action.parseMode,
          threadTs: turn.thread,
          replyTo: state.replyTo
        })
      }
      return
  }
}
