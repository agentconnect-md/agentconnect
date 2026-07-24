/**
 * Discord bot-token verification for the install flow — the Discord analog of
 * slack-identity.ts / telegram-identity.ts.
 *
 * `POST /integrations` calls this to (a) VALIDATE the pasted bot token against
 * Discord before storing it — so a stale / wrong / swapped token fails the request
 * with a 400 instead of silently producing an integration whose Gateway login never
 * succeeds (and whose only symptom is a daemon-log error nobody sees) — and (b)
 * derive the bot's display name from `GET /users/@me` when the install omits one
 * (one call does both, so we don't re-fetch just to name the bot).
 *
 * Best-effort about *reachability*: a network error / timeout / non-2xx OTHER than a
 * definitive 401 is reported as `unreachable` (inconclusive) and MUST NOT block the
 * install — the CP momentarily failing to reach Discord is not evidence the token is
 * bad. Only a 401 Unauthorized is treated as `invalid`.
 *
 * This is the only spot the CP touches the token to reach Discord; it NEVER logs it.
 */

/** `GET /users/@me` outcome: a valid token (with the derived bot name), a token
 *  Discord rejected (401), or an inconclusive reachability failure. */
export type DiscordBotVerification =
  | { status: 'ok'; name: string | null } // valid; name = username(+discriminator), else global_name, else null
  | { status: 'invalid' } // Discord replied 401 — bad / expired / reset token
  | { status: 'unreachable' } // network / timeout / non-401 non-2xx — inconclusive, do not block

export type DiscordBotVerifier = (botToken: string) => Promise<DiscordBotVerification>

/** The application (client) id embedded in a bot token's first segment, or undefined
 *  when the shape is unexpected. A Discord bot token is `<base64url(appId)>.<ts>.<hmac>`
 *  and the first segment base64url-decodes to the bot's user id — which for a bot IS its
 *  application id. Public metadata (the client_id every invite URL carries), NOT secret;
 *  we parse it so the console can hand out a ready-made invite link without the token.
 *  Mirrors `slackAppIdFromAppToken` (install-slack.ts) and the client-side
 *  `discordApplicationIdFromToken` (packages/web/src/lib/discord-invite.ts). */
export function discordAppIdFromBotToken(botToken: string): string | undefined {
  const seg = botToken.trim().split('.')[0]
  if (!seg) return undefined
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4))
    const id = Buffer.from(padded, 'base64').toString('utf8')
    return /^\d{17,20}$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

const DISCORD_TIMEOUT_MS = 5000

/** `GET /users/@me` with the bot token → validity + the derived name (`username`,
 *  with `#discriminator` for legacy bots, else `global_name`). */
export const verifyDiscordBot: DiscordBotVerifier = async (botToken) => {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS)
    })
    if (res.status === 401) return { status: 'invalid' }
    if (!res.ok) return { status: 'unreachable' }
    const body = (await res.json()) as { username?: string; discriminator?: string; global_name?: string }
    const disc = body.discriminator && body.discriminator !== '0' ? `#${body.discriminator}` : ''
    const name = body.username ? `${body.username}${disc}` : (body.global_name ?? null)
    return { status: 'ok', name }
  } catch {
    return { status: 'unreachable' }
  }
}
