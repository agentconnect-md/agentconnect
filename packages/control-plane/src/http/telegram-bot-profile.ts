import type { IconStore } from '../icons/icon-store.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from './bot-profile-icon.js'

const TELEGRAM_API = 'https://api.telegram.org'
const TELEGRAM_TIMEOUT_MS = 5000
const TELEGRAM_ICON_SIZE = 512

export type TelegramBotIconSyncer = (botToken: string, agent: BotProfileIconAgent) => Promise<void>

async function telegramJpeg(agent: BotProfileIconAgent, iconStore?: IconStore): Promise<Buffer> {
  const source = await loadBotProfileIcon(agent, iconStore, TELEGRAM_ICON_SIZE)
  const { default: sharp } = await import('sharp')
  return sharp(source.bytes)
    .resize(TELEGRAM_ICON_SIZE, TELEGRAM_ICON_SIZE, { fit: 'cover' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/** Apply the Agent icon to a newly registered Telegram bot through Bot API 9.4's
 * `setMyProfilePhoto`. Telegram requires a fresh JPG multipart upload; the route
 * treats conversion or API failure as cosmetic and keeps the integration. */
export function createTelegramBotIconSyncer(iconStore?: IconStore): TelegramBotIconSyncer {
  return async (botToken, agent) => {
    const jpeg = await telegramJpeg(agent, iconStore)
    const form = new FormData()
    form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://profile_photo' }))
    form.set('profile_photo', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'agent-icon.jpg')

    let res: Response
    try {
      res = await fetch(`${TELEGRAM_API}/bot${botToken}/setMyProfilePhoto`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
      })
    } catch {
      // A fetch error may retain request internals. Replace it so the BotFather
      // token embedded in Telegram's URL can never reach application logs.
      throw new Error('Telegram icon sync request failed')
    }

    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
    if (!res.ok || body?.ok !== true) throw new Error(`setMyProfilePhoto returned ${res.status}`)
  }
}
