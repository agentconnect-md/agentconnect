// WeCom's daemon platform module (§7.4): a direct chat is one session per person, a group one session per group, as on QQ.
import { WECOM_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { DaemonPlatformModule } from '../contract.js'

/** The thread of a direct chat, which is one continuous session. */
export const WECOM_DM_THREAD = 'dm'
/** The thread of a group: WeCom has no threads and its quote names no message, so a group holds one session. */
export const WECOM_GROUP_THREAD = 'group'

/** Set `msg.thread`; a group delivers only mentions, so each mention continues the group's session or, in append mode, its append session. */
export async function canonicalizeWeComThread(_host: unknown, msg: NormalizedMessage): Promise<void> {
  if (msg.platform !== WECOM_PLATFORM || msg.thread !== undefined) return
  msg.thread = msg.isDm ? WECOM_DM_THREAD : WECOM_GROUP_THREAD
}

export const weComPlatformModule: DaemonPlatformModule = {
  platformId: WECOM_PLATFORM,
  canonicalizeThread: (host, msg) => canonicalizeWeComThread(host, msg)
}
