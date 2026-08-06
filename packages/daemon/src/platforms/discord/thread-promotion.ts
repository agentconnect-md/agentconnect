/**
 * Discord's **thread promotion** (§7.4 `openThreadForTopLevel`, stage S2).
 *
 * A top-level channel @mention opens a thread off the triggering message first,
 * then the turn dispatches INTO that thread (Slack-parity). `channel` remains
 * the enclosing configurable channel and the freshly-created id becomes only
 * `thread`, matching Slack's `{ channel, thread_ts }` coordinate semantics.
 *
 * WANT reads the generic `promoteToThread` coordinate (§6.5); Discord's legacy
 * `discordTopLevel` named twin retired with the S1b cleanup.
 */
import type { DiscordConnection } from '../../discord/connection.js'
import { rootPostThreadName } from '../thread-keys.js'
import type { ThreadPromotion, ThreadPromotionHost, ThreadPromotionMessage } from '../thread-promotion.js'

/** Name for the opened thread: the first line of the prompt, collapsed to one
 *  line and clamped under Discord's 100-char thread-name cap (createThread also
 *  clamps). Empty prompts (e.g. attachment-only) get a default. */
export function discordThreadName(text: string): string {
  return rootPostThreadName(text)
}

export const discordThreadPromotion: ThreadPromotion<ThreadPromotionMessage> = {
  platform: 'discord',

  wants(msg: ThreadPromotionMessage): boolean {
    return msg.promoteToThread === true
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
    // Keep `channel` on the enclosing conversation; only the thread coordinate
    // changes. Discord guarantees the new thread id equals the starter message id,
    // so the triggering message is still recognized as the thread root.
    msg.thread = threadId
  }
}
