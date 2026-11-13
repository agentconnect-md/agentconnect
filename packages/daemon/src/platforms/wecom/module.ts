// WeCom's daemon platform module (§7.4): a direct chat is one session per person; a group's every message sits at its root (auto-session-mode.md §6.10).
import { THREADLESS_GROUP_ROOT, WECOM_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { DaemonPlatformModule } from '../contract.js'

/** The thread of a direct chat, which is one continuous session. */
export const WECOM_DM_THREAD = 'dm'
/** A group's fixed thread key, the root its manifest declares: WeCom has no threads and its quote names no message (auto-session-mode.md §6.10). */
export const WECOM_GROUP_THREAD = THREADLESS_GROUP_ROOT

/** Set `msg.thread`; a group delivers only mentions, each at the group's root, which keys its one session, its append session or its coordinator by mode. */
export async function canonicalizeWeComThread(_host: unknown, msg: NormalizedMessage): Promise<void> {
  if (msg.platform !== WECOM_PLATFORM || msg.thread !== undefined) return
  msg.thread = msg.isDm ? WECOM_DM_THREAD : WECOM_GROUP_THREAD
}

export const weComPlatformModule: DaemonPlatformModule = {
  platformId: WECOM_PLATFORM,
  canonicalizeThread: (host, msg) => canonicalizeWeComThread(host, msg)
}
