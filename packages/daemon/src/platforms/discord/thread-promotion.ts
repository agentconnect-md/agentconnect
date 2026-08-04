/**
 * Discord's **thread promotion** (§7.4 `openThreadForTopLevel`, stage S2).
 *
 * A top-level channel @mention opens a thread off the triggering message first,
 * then the turn dispatches INTO that thread (Slack-parity). The re-keying rules
 * are Discord's conversation model: channel == thread == session
 * (see discord/normalize.ts), so the freshly created thread id becomes all
 * three coordinates, and the original message id — whose ts equals the thread
 * id — makes the session treat that message as the thread root.
 *
 * WANT is a dual-shape read: the generic `promoteToThread` coordinate (§6.5)
 * first, Discord's legacy `discordTopLevel` named field as the fallback until
 * the legacy emission flip retires it.
 */
import type { DiscordConnection } from '../../discord/connection.js'
import type { ThreadPromotion, ThreadPromotionHost, ThreadPromotionMessage } from '../thread-promotion.js'

/** Name for the opened thread: the first line of the prompt, collapsed to one
 *  line and clamped under Discord's 100-char thread-name cap (createThread also
 *  clamps). Empty prompts (e.g. attachment-only) get a default. */
export function discordThreadName(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return oneLine || 'Agent thread'
}

export const discordThreadPromotion: ThreadPromotion<ThreadPromotionMessage> = {
  platform: 'discord',

  wants(msg: ThreadPromotionMessage): boolean {
    return (msg.promoteToThread ?? (msg as { discordTopLevel?: boolean }).discordTopLevel) === true
  },

  async promote(host: ThreadPromotionHost, conn: unknown, msg: ThreadPromotionMessage): Promise<void> {
    const dc = conn as DiscordConnection | undefined
    const messageId = msg.msgId.split(':').pop() ?? ''
    const threadId = dc ? await dc.createThread(msg.channel, messageId, discordThreadName(msg.text)) : undefined
    if (!threadId) {
      host.debug(`discord: no thread opened for ch=${msg.channel} — replying in channel`)
      return
    }
    host.info(`discord: opened thread ${threadId} for ch=${msg.channel} msg=${messageId}`)
    // The session is about to key on the thread; record the channel it belongs to
    // (and its space) NOW, while `msg.channel` still names the parent — channel
    // discovery then reports this one channel instead of a row per thread we open
    // under it.
    host.setChannelScope(threadId, { parentId: msg.channel })
    // Re-key the turn onto the thread channel (channel == thread == session; see
    // discord/normalize.ts). msgId keeps the original message id → its `ts`, which
    // equals the thread id, so the session treats this message as the thread root.
    msg.parentChannel = msg.channel
    msg.channel = threadId
    msg.thread = threadId
    // The session now keys on the thread id, not the parent channel the inbound
    // resolver already noted — label the thread too so the console shows its name.
    // `conn` is non-null here (threadId is only set when createThread ran on it).
    host.noteChannel(conn, threadId)
  }
}
