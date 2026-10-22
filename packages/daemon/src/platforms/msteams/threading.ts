// Teams' thread strategy (teams-integration.md §4.1): a 1:1 chat is one session, a channel thread is its root, a group chat follows the reply chain.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import { isAppendCoordinate } from '../../session/append-coordinate.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { ThreadingHost } from '../contract.js'

/** The thread prefix of a group-chat session rooted at a message; non-numeric, so it never reads as a channel thread's root. */
export const MSTEAMS_THREAD_PREFIX = 'msteams:'

/** The activity ID from the `msteams:<conversation>:<activityId>` msgId grammar; the conversation ID holds colons, the activity ID none. */
export function msTeamsActivityId(msg: Pick<NormalizedMessage, 'msgId'>): string {
  return msg.msgId.slice(msg.msgId.lastIndexOf(':') + 1)
}

/** Set `msg.thread`: a 1:1 chat is one session, a quote joins the session its message was recorded in, anything else roots a fresh one. */
export async function canonicalizeMsTeamsThread(
  host: ThreadingHost,
  msg: NormalizedMessage,
  transcriptChannel: string
): Promise<void> {
  // A channel post already carries its root as the thread, which stands.
  if (msg.platform !== MSTEAMS_PLATFORM || msg.thread !== undefined) return
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
  msg.thread = `${MSTEAMS_THREAD_PREFIX}${msTeamsActivityId(msg)}`
}
