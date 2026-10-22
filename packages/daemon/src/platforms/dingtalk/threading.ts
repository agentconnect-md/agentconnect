// DingTalk's thread strategy (dingtalk-integration.md §4.1): DingTalk has no threads, so sessions follow the reply chain.
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import { isAppendCoordinate } from '../../session/append-coordinate.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { ThreadingHost } from '../contract.js'

/** The thread prefix of a session rooted at a message; non-numeric, so it never reads as a native coordinate. */
export const DINGTALK_THREAD_PREFIX = 'dt:'

/** The DingTalk message id from the `dingtalk:<conversation>:<msgId>` msgId grammar. */
export function dingTalkMessageId(msg: NormalizedMessage): string {
  return msg.msgId.split(':').slice(2).join(':')
}

/** The raw conversation and message ids from the msgId grammar; undefined for a message DingTalk did not deliver. */
export function dingTalkMessageRef(
  msg: NormalizedMessage
): { openConversationId: string; openMsgId: string } | undefined {
  const [platform, conversation, ...rest] = msg.msgId.split(':')
  const id = rest.join(':')
  return platform === DINGTALK_PLATFORM && conversation && id
    ? { openConversationId: conversation, openMsgId: id }
    : undefined
}

/** Set `msg.thread`: a DM is one session, a quote joins the session its message was recorded in, anything else roots a fresh one. */
export async function canonicalizeDingTalkThread(
  host: ThreadingHost,
  msg: NormalizedMessage,
  transcriptChannel: string
): Promise<void> {
  if (msg.platform !== DINGTALK_PLATFORM || msg.thread !== undefined) return
  if (msg.isDm) {
    msg.thread = 'dm'
    return
  }
  if (msg.replyTo) {
    // An append coordinate is a session key, not a delivery thread, so it is never adopted (channel-session-mode.md §6.2).
    const recorded = await host.threadForMessage(transcriptChannel, msg.replyTo)
    if (recorded !== undefined && !isAppendCoordinate(recorded)) {
      msg.thread = recorded
      return
    }
  }
  msg.thread = `${DINGTALK_THREAD_PREFIX}${dingTalkMessageId(msg)}`
}
