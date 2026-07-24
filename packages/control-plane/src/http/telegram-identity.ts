/**
 * Best-effort Telegram bot-name lookup for the install flow — the Telegram analog
 * of slack-identity.ts.
 *
 * When `POST /integrations` omits a name, the CP calls Telegram `getMe` with the
 * BotFather token to derive the bot's @username, so the operator doesn't re-type a
 * name the bot already has. One install-time HTTPS call, short-timeout,
 * best-effort: returns null on ANY failure and the route falls back to the owning
 * agent's name. This is the only spot the CP touches the token to reach Telegram;
 * it NEVER logs it.
 */
export type TelegramBotNameResolver = (botToken: string) => Promise<string | null>

/** The live resolver: `getMe` → the bot's @username, else its first name. */
export const resolveTelegramBotName: TelegramBotNameResolver = async (botToken) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string; first_name?: string } }
    if (!body.ok || !body.result) return null
    return body.result.username ?? body.result.first_name ?? null
  } catch {
    return null
  }
}
