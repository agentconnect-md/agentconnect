/**
 * Linear's **command chrome surface** (§7.4).
 *
 * Linear has no message surface of its own — a session's only reply channel is the agent
 * activity feed (§4.6) — so a control reply is a `response` activity and `/status` is a
 * CommonMark line with the deep link appended. Slack's `*bold*` mrkdwn and `:emoji:`
 * shortcodes render literally here, which is why the line is rendered locally rather than
 * borrowed from `renderStatusBar`. No select card: an activity carries no interactive
 * control in v1 (§10.4), so the caller's numbered text list serves.
 *
 * `threadIdentifiesSession` is TRUE — a Linear AgentSession IS the thread coordinate (§4.5),
 * so a command arriving on one addresses exactly that session.
 */
import type { CommandChromeContext, CommandChromeSurface } from '../command-chrome.js'
import type { LinearEgressPort } from './turn-output.js'

/** The status fields Linear renders — the shared subset every platform's status line uses. */
export interface LinearStatusInfo {
  model?: string
  fastMode?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
}

function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The compact status line in CommonMark. */
export function renderLinearStatus(info: LinearStatusInfo): string {
  const parts: string[] = []
  if (info.model) parts.push(`**${info.model}**`)
  if (info.fastMode) parts.push('fast')
  if (info.contextUsed !== undefined && info.contextSize !== undefined && info.contextSize > 0) {
    const pct = Math.round((info.contextUsed / info.contextSize) * 100)
    parts.push(`ctx ${compactCount(info.contextUsed)}/${compactCount(info.contextSize)} (${pct}%)`)
  } else if (info.contextUsed !== undefined) {
    parts.push(`ctx ${compactCount(info.contextUsed)}`)
  }
  if (info.totalTokens !== undefined) parts.push(`${compactCount(info.totalTokens)} tok`)
  return parts.length ? parts.join(' · ') : '—'
}

/** The activity feed is addressed by the AgentSession id, which is the reply thread (§4.5). */
function post(conn: unknown, ctx: CommandChromeContext, body: string): void {
  void (conn as LinearEgressPort).postActivity(ctx.replyThread, { type: 'response', body }).catch(() => undefined)
}

export const linearCommandChrome: CommandChromeSurface<unknown, LinearStatusInfo> = {
  platform: 'linear',
  threadIdentifiesSession: true,

  reply(conn: unknown, _msg: unknown, ctx: CommandChromeContext, text: string): void {
    post(conn, ctx, text)
  },

  status(conn: unknown, _msg: unknown, ctx: CommandChromeContext, info: LinearStatusInfo, link?: string): void {
    post(conn, ctx, link ? `${renderLinearStatus(info)} · [View session](${link})` : renderLinearStatus(info))
  }
}
