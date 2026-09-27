// Google Chat's command chrome surface (§7.4): a control reply is a plain Markdown message in the reply thread.
import type { CommandChromeContext, CommandChromeSurface } from '../command-chrome.js'

/** The status fields Google Chat renders — the shared subset every platform's status line uses. */
export interface GoogleChatStatusInfo {
  model?: string
  fastMode?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
}

/** The chrome half of the egress port: a plain create with a per-call request id, no client id. */
export interface GoogleChatChromePort {
  postChrome(space: string, thread: string | undefined, text: string): Promise<void>
}

function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The compact status line in Markdown. */
export function renderGoogleChatStatus(info: GoogleChatStatusInfo): string {
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

/** In a DM the reply thread IS the Space, and a DM create carries no thread option (§5). */
export function googleChatReplyThread(ctx: Pick<CommandChromeContext, 'channel' | 'replyThread'>): string | undefined {
  return ctx.replyThread === ctx.channel ? undefined : ctx.replyThread
}

function post(conn: unknown, ctx: CommandChromeContext, text: string): void {
  void (conn as GoogleChatChromePort).postChrome(ctx.channel, googleChatReplyThread(ctx), text).catch(() => undefined)
}

export const googleChatCommandChrome: CommandChromeSurface<unknown, GoogleChatStatusInfo> = {
  platform: 'googlechat',
  // A command inside a Space thread targets that thread's session; a DM's thread is the conversation itself.
  threadIdentifiesSession: true,

  reply(conn: unknown, _msg: unknown, ctx: CommandChromeContext, text: string): void {
    post(conn, ctx, text)
  },

  status(conn: unknown, _msg: unknown, ctx: CommandChromeContext, info: GoogleChatStatusInfo, link?: string): void {
    const line = renderGoogleChatStatus(info)
    post(conn, ctx, link ? `${line} · [View session](${link})` : line)
  }
}
