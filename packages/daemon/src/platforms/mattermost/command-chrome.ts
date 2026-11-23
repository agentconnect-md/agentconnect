// Mattermost command chrome surface (§7.4): `!` commands and rich Markdown `/status` replies in thread or flat DM.
import { nativeMessageId } from '@agentconnect.md/message'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeContext, CommandChromeSurface } from '../command-chrome.js'
import { MATTERMOST_DM_THREAD } from './module.js'

/** Telemetry subset rendered by Mattermost's `!status` / `/status` reply. */
export interface MattermostStatusInfo {
  model?: string
  fastMode?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
}

/** Narrow reply port satisfied by {@link MattermostConnection} and duck-typed test fakes. */
export interface MattermostCommandPort {
  createPost?(
    channel: string,
    text: string,
    opts?: { rootId?: string; props?: Record<string, unknown> }
  ): Promise<unknown>
  postMessage?(channel: string, text: string, threadTs?: string): Promise<string | undefined>
}

function escapeStatusMarkdown(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .replace(/([\\`*_[\]~<>])/g, '\\$1')
}

function safeStatusUrl(raw?: string): string | undefined {
  if (!raw || raw.length > 2_048 || /[\s\p{Cc}]/u.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Render the Markdown `!status` line + `[View session](...)` deep link for Mattermost. */
export function renderMattermostStatus(info: MattermostStatusInfo, link?: string): string {
  const parts: string[] = []
  const model = info.model?.trim() ? escapeStatusMarkdown(info.model) : ''
  if (model) parts.push(`**${model}**`)
  if (info.fastMode) parts.push('fast')
  if (info.contextUsed !== undefined && info.contextSize !== undefined && info.contextSize > 0) {
    const pct = Math.round((info.contextUsed / info.contextSize) * 100)
    parts.push(`ctx ${compactCount(info.contextUsed)}/${compactCount(info.contextSize)} (${pct}%)`)
  } else if (info.contextUsed !== undefined) {
    parts.push(`ctx ${compactCount(info.contextUsed)}`)
  }
  if (info.totalTokens !== undefined) parts.push(`${compactCount(info.totalTokens)} tok`)
  const line = `📊 ${parts.length ? parts.join(' · ') : '—'}`
  const safeLink = safeStatusUrl(link)
  return safeLink ? `${line} · [View session](${safeLink})` : line
}

function commandRootId(
  msg: NormalizedMessage | undefined,
  ctx: Pick<CommandChromeContext, 'channel' | 'replyThread'>
): string | undefined {
  if (msg?.isDm) return msg.replyThread
  if (ctx.replyThread && ctx.replyThread !== MATTERMOST_DM_THREAD && ctx.replyThread !== ctx.channel) {
    return ctx.replyThread
  }
  if (msg?.thread && msg.thread !== MATTERMOST_DM_THREAD) return msg.thread
  if (msg?.msgId) return nativeMessageId(msg.msgId)
  return undefined
}

async function sendChromePost(
  conn: unknown,
  channel: string,
  rootId: string | undefined,
  text: string
): Promise<boolean> {
  const port = conn as MattermostCommandPort | undefined
  if (!port) return false
  if (typeof port.createPost === 'function') {
    await port.createPost(channel, text, rootId ? { rootId } : undefined)
    return true
  }
  if (typeof port.postMessage === 'function') {
    const id = await port.postMessage(channel, text, rootId)
    return id !== undefined
  }
  return false
}

export const mattermostCommandChrome: CommandChromeSurface<NormalizedMessage, MattermostStatusInfo> = {
  platform: MATTERMOST_PLATFORM,
  // Channel sessions anchor on `root_id || id` and 1:1 DMs on `'dm'`, so the thread coordinate identifies the session.
  threadIdentifiesSession: true,

  reply(conn, msg, ctx, text): void {
    void sendChromePost(conn, ctx.channel, commandRootId(msg, ctx), text).catch(() => undefined)
  },

  status(conn, msg, ctx, info, link): void {
    this.reply(conn, msg, ctx, renderMattermostStatus(info ?? {}, link))
  },

  async notice(conn, channel, thread, text, msg): Promise<void> {
    const rootId = msg?.isDm
      ? msg.replyThread
      : thread && thread !== MATTERMOST_DM_THREAD && thread !== channel
        ? thread
        : undefined
    const sent = await sendChromePost(conn, channel, rootId, text)
    if (!sent) throw new Error('mattermost: notice could not be posted')
  }
}
