/**
 * The **outbound thread-key strategy** (`threadKeyForPost` in §7.4, stage S2) —
 * the outbound mirror of inbound thread canonicalization, and the ONE place that
 * conversion lives.
 *
 * A post whose key does not match what the next inbound reply resolves to opens
 * a session that reply can never reach, so this has to follow each platform's
 * own conversation model:
 *
 *  - Slack, and Feishu group chats, thread off a message: the post's own ts IS
 *    the segment.
 *  - Telegram groups have no native threads, so a reply resolves to
 *    `tg:<root message id>`. The `tg:` prefix also keeps reply roots out of the
 *    numeric forum-TOPIC namespace. (A root post into a forum lands in General,
 *    whose messages carry no `is_topic_message`, so replies there resolve
 *    through the same `tg:` ladder rather than to a topic id.)
 *  - Discord conversations are the CHANNEL — every inbound message there keys
 *    the channel id, so a post cannot open a thread of its own.
 *  - A DM is one continuous conversation, keyed `dm` on Telegram and by the
 *    chat on Feishu. A post into one joins it; it never starts a second.
 *
 * Whether the target is a DM is not derivable from the id, so callers pass what
 * the platform reports (`isIm` from `getChannelInfo`), defaulting to a non-DM
 * conversation.
 *
 * The DEFAULT arm — the post's own ts — is Slack's rule and the core one:
 * webchat/hook/dream anchors and any unknown platform key exactly as before
 * this seam, when the function was three platform literals in
 * `messages/normalized.ts`. Each arm must agree with its platform's inbound
 * canonicalization (`platforms/<id>/threading.ts`), which is why they are
 * registered per platform rather than inferred.
 */

type ThreadKeyStrategy = (channel: string, ts: string, isDm: boolean) => string

const STRATEGIES = new Map<string, ThreadKeyStrategy>([
  // Conversations ARE the channel; a post cannot open a thread of its own.
  ['discord', (channel) => channel],
  // Reply-based threading: numeric message ids enter the `tg:` reply-root
  // namespace; DMs are one continuous conversation.
  ['telegram', (_channel, ts, isDm) => (isDm ? 'dm' : /^\d+$/.test(ts) ? `tg:${ts}` : ts)],
  // Group chats thread off the post; a DM is keyed by the chat itself.
  ['feishu', (channel, ts, isDm) => (isDm ? channel : ts)]
])

/** The session-thread key for a message this daemon just posted at a channel
 *  ROOT. Total by construction: an unregistered platform threads off the post's
 *  own ts, the Slack/core rule. */
export function threadKeyForPost(platform: string, channel: string, ts: string, isDm = false): string {
  return STRATEGIES.get(platform)?.(channel, ts, isDm) ?? ts
}
