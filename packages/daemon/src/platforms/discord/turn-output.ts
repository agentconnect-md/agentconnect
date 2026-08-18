/**
 * Discord's **turn-output surface** (integration-plugin-architecture.md §7.3,
 * stage S2).
 *
 * Same host port as Telegram's — record a reply segment, append a transcript row
 * — which is the point: the second extraction reuses the shape the first one
 * settled rather than inventing its own. What differs is entirely Discord's:
 * native markdown (no parse mode to carry), and a status bar with a button row
 * that must register its message against the session key so interactions resolve.
 *
 * Discord carries NO per-turn platform state: its chrome ids live on the generic
 * turn fields every platform uses, and there is no card handle or reply anchor to
 * keep. Its `initialTurnState` returns an empty object rather than nothing, so the
 * slot is uniformly present.
 */
import type { DiscordConnection } from '../../discord/connection.js'
import type { DiscordAction } from '../../discord/render.js'

/** The core turn, as Discord's applier sees it — the fields it renders with and
 *  nothing more. `Pending` satisfies this structurally. */
export interface DiscordTurn {
  conn?: unknown
  channel: string
  thread?: string
  statusThread: string
  transcriptChannel: string
  agentId: string
  sessionKey: string
  progressTs?: string
  progressAttempted?: boolean
  planTs?: string
  planAttempted?: boolean
  reasoningTs?: string
  reasoningAttempted?: boolean
  statusBarTs?: string
  statusBarAttempted?: boolean
  liveReplyTs?: string
  liveReplyText?: string
  liveReplyAttempted?: boolean
}

/** The host capabilities this applier needs — the same two Telegram's does. */
export interface DiscordTurnHost<TTurn> {
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

/** Apply one converger action against the turn's Discord connection. */
export async function applyDiscordAction<TTurn extends DiscordTurn>(
  host: DiscordTurnHost<TTurn>,
  turn: TTurn,
  action: DiscordAction
): Promise<void> {
  // minimal mode records each reply segment WITHOUT sending it — the channel shows only the
  // single `live-reply` (see the Slack applier / recordReplySegment).
  if (action.kind === 'post' && action.recordOnly) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  // Routed here only for the discord platform (see the turn-output registry), so the
  // turn's connection is a Discord one (or a test fake) — cast, not instanceof.
  // Headless no-ops.
  const conn = turn.conn as DiscordConnection | undefined
  if (!conn) return
  switch (action.kind) {
    case 'typing':
      await conn.sendChatAction(turn.channel, turn.thread)
      return
    case 'post': {
      const id = await conn.postMessage(turn.channel, action.text, turn.thread)
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
    case 'live-reply': {
      // minimal mode's single agent reply: send once then edit in place as the turn
      // streams. Skip an update when unchanged; not recorded (the `recordOnly` posts do).
      if (turn.liveReplyText === action.text) return
      turn.liveReplyText = action.text
      if (turn.liveReplyTs)
        await conn.updateMessage(turn.channel, turn.liveReplyTs, action.text, { threadTs: turn.thread })
      else if (!turn.liveReplyAttempted) {
        turn.liveReplyAttempted = true
        turn.liveReplyTs = await conn.postMessage(turn.channel, action.text, turn.thread)
      }
      return
    }
    case 'notice':
    case 'tool-output':
      // Posted to the channel but NOT recorded — the done footer is chrome, and tool
      // output is captured independently by the recorder.
      await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      return
    case 'progress':
      if (turn.progressTs)
        await conn.updateMessage(turn.channel, turn.progressTs, action.text, { threadTs: turn.thread })
      else if (!turn.progressAttempted) {
        turn.progressAttempted = true
        turn.progressTs = await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      }
      return
    case 'plan':
      if (turn.planTs) await conn.updateMessage(turn.channel, turn.planTs, action.text, { threadTs: turn.thread })
      else if (!turn.planAttempted) {
        turn.planAttempted = true
        turn.planTs = await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      }
      return
    case 'reasoning':
      if (turn.reasoningTs)
        await conn.updateMessage(turn.channel, turn.reasoningTs, action.text, { threadTs: turn.thread })
      else if (!turn.reasoningAttempted) {
        turn.reasoningAttempted = true
        turn.reasoningTs = await conn.postChrome(turn.channel, action.text, { threadTs: turn.thread })
      }
      return
    case 'status-bar':
      // Per-turn status line + button row: post once (registering the message →
      // sessionKey so its button interactions resolve), then edit in place.
      if (turn.statusBarTs)
        await conn.updateMessage(turn.channel, turn.statusBarTs, action.text, {
          threadTs: turn.thread,
          keyboard: action.keyboard
        })
      else if (!turn.statusBarAttempted) {
        turn.statusBarAttempted = true
        turn.statusBarTs = await conn.postChrome(turn.channel, action.text, {
          threadTs: turn.thread,
          keyboard: action.keyboard,
          sessionKey: turn.sessionKey
        })
      }
      return
  }
}
