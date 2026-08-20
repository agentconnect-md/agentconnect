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
  plan: {
    channel: string
    thread?: string
    statusThread: string
    transcriptChannel: string
    agentId: string
    sessionKey: string
  }
  chrome: {
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
      await conn.sendChatAction(turn.plan.channel, turn.plan.thread)
      return
    case 'post': {
      const id = await conn.postMessage(turn.plan.channel, action.text, turn.plan.thread)
      await host.appendTranscript({
        channel: turn.plan.transcriptChannel,
        thread: turn.plan.statusThread,
        ts: id ?? `local-${Date.now()}`,
        sender: turn.plan.agentId,
        kind: 'text',
        text: action.text
      })
      return
    }
    case 'live-reply': {
      // minimal mode's single agent reply: send once then edit in place as the turn
      // streams. Skip an update when unchanged; not recorded (the `recordOnly` posts do).
      if (turn.chrome.liveReplyText === action.text) return
      turn.chrome.liveReplyText = action.text
      if (turn.chrome.liveReplyTs)
        await conn.updateMessage(turn.plan.channel, turn.chrome.liveReplyTs, action.text, {
          threadTs: turn.plan.thread
        })
      else if (!turn.chrome.liveReplyAttempted) {
        turn.chrome.liveReplyAttempted = true
        turn.chrome.liveReplyTs = await conn.postMessage(turn.plan.channel, action.text, turn.plan.thread)
      }
      return
    }
    case 'notice':
    case 'tool-output':
      // Posted to the channel but NOT recorded — the done footer is chrome, and tool
      // output is captured independently by the recorder.
      await conn.postChrome(turn.plan.channel, action.text, { threadTs: turn.plan.thread })
      return
    case 'progress':
      if (turn.chrome.progressTs)
        await conn.updateMessage(turn.plan.channel, turn.chrome.progressTs, action.text, { threadTs: turn.plan.thread })
      else if (!turn.chrome.progressAttempted) {
        turn.chrome.progressAttempted = true
        turn.chrome.progressTs = await conn.postChrome(turn.plan.channel, action.text, { threadTs: turn.plan.thread })
      }
      return
    case 'plan':
      if (turn.chrome.planTs)
        await conn.updateMessage(turn.plan.channel, turn.chrome.planTs, action.text, { threadTs: turn.plan.thread })
      else if (!turn.chrome.planAttempted) {
        turn.chrome.planAttempted = true
        turn.chrome.planTs = await conn.postChrome(turn.plan.channel, action.text, { threadTs: turn.plan.thread })
      }
      return
    case 'reasoning':
      if (turn.chrome.reasoningTs)
        await conn.updateMessage(turn.plan.channel, turn.chrome.reasoningTs, action.text, {
          threadTs: turn.plan.thread
        })
      else if (!turn.chrome.reasoningAttempted) {
        turn.chrome.reasoningAttempted = true
        turn.chrome.reasoningTs = await conn.postChrome(turn.plan.channel, action.text, { threadTs: turn.plan.thread })
      }
      return
    case 'status-bar':
      // Per-turn status line + button row: post once (registering the message →
      // sessionKey so its button interactions resolve), then edit in place.
      if (turn.chrome.statusBarTs)
        await conn.updateMessage(turn.plan.channel, turn.chrome.statusBarTs, action.text, {
          threadTs: turn.plan.thread,
          keyboard: action.keyboard
        })
      else if (!turn.chrome.statusBarAttempted) {
        turn.chrome.statusBarAttempted = true
        turn.chrome.statusBarTs = await conn.postChrome(turn.plan.channel, action.text, {
          threadTs: turn.plan.thread,
          keyboard: action.keyboard,
          sessionKey: turn.plan.sessionKey
        })
      }
      return
  }
}
