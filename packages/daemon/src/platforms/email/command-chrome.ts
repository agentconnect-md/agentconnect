// Email's command chrome (§7.4): mail has no commands and sends nothing outside a turn's reply (email-integration.md §4, §6.1).
import { EMAIL_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'

export const emailCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: EMAIL_PLATFORM,
  // Every thread is its own session in a member's direct conversation, so a thread names its session.
  threadIdentifiesSession: true,
  reply() {},
  status() {},
  // A notice out of a turn would be mail the agent starts on its own, which the first step does not send.
  async notice() {
    throw new Error('email: no mail is sent outside a reply')
  }
}
