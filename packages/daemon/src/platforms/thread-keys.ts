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
 *  - A Discord guild root post keys on its own message id. If a native thread is
 *    opened from that post, Discord gives the thread channel the same id, so the
 *    first in-thread reply reaches the initialized session. Discord DMs remain
 *    one continuous conversation keyed by their channel id.
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

interface ThreadKeyStrategy {
  key(channel: string, ts: string, isDm: boolean): string
  /** Whether callers must classify a root target as DM before deriving its key. */
  dmSensitive: boolean
  /** Whether a non-DM root post must be turned into a native thread before its
   *  session can be initialized. */
  materializeRootThread?: boolean
}

const STRATEGIES = new Map<string, ThreadKeyStrategy>([
  // Guild threads use the starter message id; DMs are continuous.
  ['discord', { key: (channel, ts, isDm) => (isDm ? channel : ts), dmSensitive: true, materializeRootThread: true }],
  // Reply-based threading: numeric message ids enter the `tg:` reply-root
  // namespace; DMs are one continuous conversation.
  ['telegram', { key: (_channel, ts, isDm) => (isDm ? 'dm' : /^\d+$/.test(ts) ? `tg:${ts}` : ts), dmSensitive: true }],
  // Group chats thread off the post; a DM is keyed by the chat itself.
  ['feishu', { key: (channel, ts, isDm) => (isDm ? channel : ts), dmSensitive: true }]
])

/** Whether the platform's root-post session key depends on DM classification. */
export function threadKeyNeedsDmClassification(platform: string): boolean {
  return STRATEGIES.get(platform)?.dmSensitive ?? false
}

/** Whether a non-DM root post needs a provider thread before it can own a session. */
export function rootPostNeedsThreadMaterialization(platform: string): boolean {
  return STRATEGIES.get(platform)?.materializeRootThread ?? false
}

/** Provider-safe title for a native thread opened from a root post. */
export function rootPostThreadName(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return oneLine || 'Agent thread'
}

/** The session-thread key for a message this daemon just posted at a channel
 *  ROOT. Total by construction: an unregistered platform threads off the post's
 *  own ts, the Slack/core rule. */
export function threadKeyForPost(platform: string, channel: string, ts: string, isDm = false): string {
  return STRATEGIES.get(platform)?.key(channel, ts, isDm) ?? ts
}
