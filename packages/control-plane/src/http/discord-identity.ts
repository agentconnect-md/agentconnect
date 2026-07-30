/**
 * Discord bot-token verification and required application setup for the install
 * flow — the Discord analog of slack-identity.ts / telegram-identity.ts.
 *
 * `verifyDiscordBot` validates the pasted token and derives the bot's display name.
 * `ensureDiscordMessageContentIntent` idempotently enables the limited Message
 * Content application flag before the integration is stored. Neither logs the token.
 */

/** `GET /users/@me` outcome: a valid token (with the derived bot name), a token
 *  Discord rejected (401), or an inconclusive reachability failure. */
export type DiscordBotVerification =
  | { status: 'ok'; name: string | null } // valid; name = username(+discriminator), else global_name, else null
  | { status: 'invalid' } // Discord replied 401 — bad / expired / reset token
  | { status: 'unreachable' } // network / timeout / non-401 non-2xx — inconclusive, do not block

export type DiscordBotVerifier = (botToken: string) => Promise<DiscordBotVerification>
export type DiscordMessageContentIntentEnsurer = (botToken: string) => Promise<boolean>

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
const DISCORD_API = 'https://discord.com/api/v10'
const GATEWAY_PRESENCE_LIMITED = 1 << 13
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15
const GATEWAY_MESSAGE_CONTENT = 1 << 18
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19
const EDITABLE_LIMITED_INTENTS =
  GATEWAY_PRESENCE_LIMITED | GATEWAY_GUILD_MEMBERS_LIMITED | GATEWAY_MESSAGE_CONTENT_LIMITED

function applicationFlags(body: unknown): number | null {
  if (!body || typeof body !== 'object' || !('flags' in body)) return null
  const flags = body.flags
  return typeof flags === 'number' && Number.isSafeInteger(flags) ? flags : null
}

function hasMessageContentIntent(flags: number): boolean {
  return (flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0
}

/** `GET /users/@me` with the bot token → validity + the derived name (`username`,
 *  with `#discriminator` for legacy bots, else `global_name`). */
export const verifyDiscordBot: DiscordBotVerifier = async (botToken) => {
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
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

/** Ensure the app can expose message bodies before its integration goes live.
 *  Discord lets bot authentication update only the three LIMITED privileged-intent
 *  flags, so preserve that editable subset and leave Discord-owned flags alone. */
export const ensureDiscordMessageContentIntent: DiscordMessageContentIntentEnsurer = async (botToken) => {
  const headers = { authorization: `Bot ${botToken}` }
  try {
    const current = await fetch(`${DISCORD_API}/applications/@me`, {
      headers,
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS)
    })
    if (!current.ok) return false

    const currentFlags = applicationFlags(await current.json())
    if (currentFlags === null) return false
    if (hasMessageContentIntent(currentFlags)) return true

    const flags = (currentFlags & EDITABLE_LIMITED_INTENTS) | GATEWAY_MESSAGE_CONTENT_LIMITED
    const updated = await fetch(`${DISCORD_API}/applications/@me`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ flags }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS)
    })
    if (!updated.ok) return false

    const updatedFlags = applicationFlags(await updated.json())
    return updatedFlags !== null && hasMessageContentIntent(updatedFlags)
  } catch {
    return false
  }
}
