/**
 * Telegram's **thread-coordinate strategy** (integration-plugin-architecture.md
 * §7.4, stage S2) — the platform's own answer to "which session does this message
 * belong to, and what does the bot reply to".
 *
 * These left `daemon.ts` because they are platform reasoning end to end: they
 * encode Telegram's conversation model (forum topics are native threads; plain
 * supergroups auto-thread replies off a root; basic groups carry no thread id at
 * all; a DM is one continuous conversation) and nothing about how the daemon
 * dispatches. Core keeps only the call.
 */
import type { NormalizedMessage } from '../../messages/normalized.js'

/** The one host capability Telegram threading needs: resolving which session a
 *  replied-to message already belongs to. Basic groups carry no
 *  `message_thread_id`, so the transcript is the only way to place a reply. */
export interface TelegramThreadingHost {
  threadForMessage(transcriptChannel: string, messageId: string): string | undefined
}

/** The platform message id carried in the `<platform>:<chat>:<id>` msgId grammar. */
export function telegramMessageId(msg: NormalizedMessage): string {
  const parts = msg.msgId.split(':')
  return parts[parts.length - 1] ?? ''
}

/**
 * Resolve the session thread for a Telegram message and set it on `msg.thread` in
 * place (normalize leaves it unset for Telegram). Ladder:
 *   - forum topic       → the topic id (a real native thread; numeric, so it also
 *                          drives the post's `message_thread_id`)
 *   - native reply-root → `tg:<root>` from Telegram's own `message_thread_id` in a
 *                          plain supergroup (Telegram auto-threads replies to the root)
 *   - DM                → one continuous session per chat (`dm`)
 *   - reply that maps   → the session the replied-to message belongs to, resolved from
 *                          the transcript (basic groups carry no `message_thread_id`)
 *   - otherwise         → a fresh session rooted at this message (`tg:<msgId>`) — a new
 *                          @mention, or a reply we can't place
 * A fresh @mention (message N, no thread root) keys `tg:N`; every later reply in that
 * thread carries `message_thread_id = N`, so it keys `tg:N` too — the two meet with no
 * lookup. The non-topic keys are deliberately NON-numeric so posting never mistakes
 * them for a forum `message_thread_id` (see TelegramConnection.postMessage). No-op for
 * other platforms or when the thread is already set.
 */
export function canonicalizeTelegramThread(
  host: TelegramThreadingHost,
  msg: NormalizedMessage,
  transcriptChannel: string
): void {
  if (msg.platform !== 'telegram' || msg.thread !== undefined) return
  // §6.5 dual-shape reader: prefer the generic coordinates; the named per-platform
  // fields stop being emitted once the fleet reads the generic ones.
  const topicId = msg.topicId ?? msg.telegramTopicId
  if (topicId !== undefined) {
    msg.thread = topicId
    return
  }
  const threadRoot = msg.threadRoot ?? msg.telegramThreadRoot
  if (threadRoot !== undefined) {
    msg.thread = `tg:${threadRoot}`
    return
  }
  if (msg.isDm) {
    msg.thread = 'dm'
    return
  }
  if (msg.replyTo) {
    msg.thread = host.threadForMessage(transcriptChannel, msg.replyTo) ?? `tg:${msg.replyTo}`
    return
  }
  msg.thread = `tg:${telegramMessageId(msg)}`
}

/** Telegram reply target for a turn/command triggered by `msg`: the triggering
 *  message's own id, so the bot's posts reply to it (req: reply to the last message
 *  in the session, and keep the reply chain resolvable). An agent-call turn
 *  (`replyToSession` / a peer wake) synthesizes its msgId (`agentcall:<channel>:<uuid>`)
 *  so no platform id can be recovered — without a fallback its answer posts to the
 *  chat root, visually outside the reply chain the session lives in. Those turns
 *  anchor to the session's thread root instead (`tg:<root>`, see
 *  {@link canonicalizeTelegramThread}); `dm` and numeric forum-topic threads carry no
 *  reply anchor. Undefined off Telegram or when neither id resolves. */
export function telegramReplyTarget(msg: NormalizedMessage): number | undefined {
  if (msg.platform !== 'telegram') return undefined
  const n = Number(telegramMessageId(msg))
  if (Number.isInteger(n) && n > 0) return n
  const root = msg.thread !== undefined ? /^tg:(\d+)$/.exec(msg.thread) : null
  const r = root ? Number(root[1]) : NaN
  return Number.isInteger(r) && r > 0 ? r : undefined
}
