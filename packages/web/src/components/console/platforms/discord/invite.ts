// The Discord bot-invite URL, built entirely client-side — the Discord analog of the
// Slack "Add to Slack with manifest" deep link.
//
// A Discord bot token is `<base64url(applicationId)>.<...>.<...>`; its first segment
// decodes to the bot's user id, which for a bot IS its application (client) id — the
// `client_id` the OAuth2 bot-invite URL needs. So the moment the user pastes the token
// we can offer a ready-made "Add to Discord" link (correct scopes + permissions)
// instead of making them hand-build one in the Developer Portal's URL Generator (the
// step the setup checklist warns is easy to get wrong). Mirrors how
// `slackAppIdFromAppToken` parses the app id out of the pasted xapp token.

// Permissions the daemon's Discord adapter needs for text-only v1: view channels, send
// messages (+ in threads), create public threads, embed links, attach files, add
// reactions, read message history. Kept in lock-step with packages/daemon/src/discord.
// A bitfield too large for 32 bits, so computed as BigInt and stringified for the URL.
const DISCORD_BOT_PERMISSIONS = (
  (1n << 6n) | // ADD_REACTIONS
  (1n << 10n) | // VIEW_CHANNEL
  (1n << 11n) | // SEND_MESSAGES
  (1n << 14n) | // EMBED_LINKS
  (1n << 15n) | // ATTACH_FILES
  (1n << 16n) | // READ_MESSAGE_HISTORY
  (1n << 35n) | // CREATE_PUBLIC_THREADS (1 << 34 is MANAGE_THREADS)
  (1n << 38n)
) // SEND_MESSAGES_IN_THREADS
  .toString()

/** The application (client) id embedded in a bot token's first segment, or null when
 *  the shape is unexpected. Pure client-side base64url decode — no network call. A
 *  Discord snowflake is 17–20 digits, which gates out random pasted strings. */
export function discordApplicationIdFromToken(botToken: string): string | null {
  const seg = botToken.trim().split('.')[0]
  if (!seg) return null
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4))
    const id = atob(padded)
    return /^\d{17,20}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** The OAuth2 bot-invite URL requesting the `bot` + `applications.commands` scopes and
 *  the permissions above — so slash commands register (a bot-only invite 403s on
 *  `commands.set`) and replies can open threads. */
export function discordBotInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot applications.commands',
    permissions: DISCORD_BOT_PERMISSIONS
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}
