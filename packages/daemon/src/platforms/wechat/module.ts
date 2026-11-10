// WeChat's daemon platform module (§7.4): the bot's one chat is one continuous session (wechat-integration.md §4.1).
import { WECHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { DaemonPlatformModule } from '../contract.js'

/** The thread of the bot's one chat. */
export const WECHAT_DM_THREAD = 'dm'

export const weChatPlatformModule: DaemonPlatformModule = {
  platformId: WECHAT_PLATFORM,
  canonicalizeThread: async (_host, msg: NormalizedMessage) => {
    if (msg.platform === WECHAT_PLATFORM && msg.thread === undefined) msg.thread = WECHAT_DM_THREAD
  }
}
