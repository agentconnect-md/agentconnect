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

/** True iff the message IS its thread's root: the thread coordinate equals the
 *  message's own native coordinate. Every normalizer that mints per-message
 *  threads anchors them on the root's native id (Slack `thread_ts`, Feishu
 *  `rootId`, Telegram topic ids), so a root — including an un-threaded Slack
 *  top-level message, whose `thread` is its own `ts` — satisfies this and a
 *  follow-up never does. */
export function isThreadRootMessage(msg: { msgId: string; thread?: string }): boolean {
  return msg.thread !== undefined && msg.thread === nativeMessageId(msg.msgId)
}
