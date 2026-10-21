// Telegram's daemon platform module (§7.4): its reply-chain thread strategy places each message in a session.
import type { DaemonPlatformModule } from '../contract.js'
import { canonicalizeTelegramThread } from './threading.js'

export const telegramPlatformModule: DaemonPlatformModule = {
  platformId: 'telegram',
  canonicalizeThread: canonicalizeTelegramThread
}
