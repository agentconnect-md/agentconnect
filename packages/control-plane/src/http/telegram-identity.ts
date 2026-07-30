/**
 * Telegram bot-token verification for the install flow.
 *
 * `getMe` validates the BotFather token, derives the bot name, and exposes
 * `can_read_all_group_messages`. The latter is Telegram's read-only signal that
 * Group Privacy Mode was disabled in @BotFather; the Bot API has no setter for it.
 * This is the only spot the CP puts the token in a Telegram URL, and it NEVER logs it.
 */
export type TelegramBotVerification =
  | { status: 'ok'; name: string | null; privacyModeDisabled: boolean }
  | { status: 'invalid' }
  | { status: 'unreachable' }

export type TelegramBotVerifier = (botToken: string) => Promise<TelegramBotVerification>

const TELEGRAM_TIMEOUT_MS = 5000

export const verifyTelegramBot: TelegramBotVerifier = async (botToken) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 404) return { status: 'invalid' }
    if (!res.ok) return { status: 'unreachable' }
    const body = (await res.json()) as {
      ok?: boolean
      error_code?: number
      result?: {
        username?: string
        first_name?: string
        can_read_all_group_messages?: boolean
      }
    }
    if (!body.ok || !body.result) {
      return body.error_code === 401 || body.error_code === 404 ? { status: 'invalid' } : { status: 'unreachable' }
    }
    return {
      status: 'ok',
      name: body.result.username ?? body.result.first_name ?? null,
      privacyModeDisabled: body.result.can_read_all_group_messages === true
    }
  } catch {
    return { status: 'unreachable' }
  }
}
