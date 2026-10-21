// DingTalk's daemon platform module (§7.4): its reply-chain thread strategy places each message in a session.
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import type { DaemonPlatformModule } from '../contract.js'
import { canonicalizeDingTalkThread } from './threading.js'

export const dingTalkPlatformModule: DaemonPlatformModule = {
  platformId: DINGTALK_PLATFORM,
  canonicalizeThread: canonicalizeDingTalkThread
}
