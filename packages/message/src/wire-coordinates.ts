/**
 * Wire message-coordinate helpers — the INVERSE of the `msgId` minting done by
 * every normalizer in this package (`slack:${channel}:${ts}`,
 * `telegram:${chatId}:${messageId}`, `discord:${channelId}:${id}`,
 * `feishu:${chatId}:${messageId}`). The format is this package's invariant, so
 * the parse lives beside the minting instead of being re-derived by wire
 * consumers (integration-plugin-architecture.md §8: thread-root detection is a
 * coordinate read, not a platform branch).
 */

/** The platform-native message coordinate — the tail of the
 *  `platform:channel:native` id every normalizer mints (split on the LAST ':',
 *  since channel ids may themselves contain colons). */
export function nativeMessageId(msgId: string): string {
  return msgId.slice(msgId.lastIndexOf(':') + 1)
}

/**
 * The platform-native (container, message) pair a PER-MESSAGE platform call needs — a
 * reaction, an edit, a fetch by id.
 *
 * Not interchangeable with `NormalizedMessage.channel`, which is the CONFIGURABLE enclosing
 * conversation: a Discord message posted inside a thread reports its parent channel there
 * and its own thread id here, and only the latter can address the message at all. Every
 * other platform's two coincide, which is exactly why reading the wrong one is invisible
 * until Discord.
 *
 * Undefined when `msgId` is not a normalizer-minted coordinate — a hook delivery's
 * `<hookId>:<deliveryKey>` is not, and names no platform message to address.
 */
export function nativeMessageCoordinates(msg: {
  platform: string
  msgId: string
}): { channel: string; messageId: string } | undefined {
  const prefix = `${msg.platform}:`
  if (!msg.msgId.startsWith(prefix)) return undefined
  const rest = msg.msgId.slice(prefix.length)
  const split = rest.lastIndexOf(':')
  if (split <= 0 || split === rest.length - 1) return undefined
  return { channel: rest.slice(0, split), messageId: rest.slice(split + 1) }
}

/** True iff the message IS its thread's root: the thread coordinate equals the
 *  message's own native coordinate. Every normalizer that mints per-message
 *  threads anchors them on the root's native id (Slack `thread_ts`, Feishu
 *  `rootId`, Telegram topic ids), so a root — including an un-threaded Slack
 *  top-level message, whose `thread` is its own `ts` — satisfies this and a
 *  follow-up never does. */
export function isThreadRootMessage(msg: { msgId: string; thread?: string }): boolean {
  return msg.thread !== undefined && msg.thread === nativeMessageId(msg.msgId)
}
