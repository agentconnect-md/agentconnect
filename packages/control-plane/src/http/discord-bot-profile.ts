import type { IconStore } from '../icons/icon-store.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from './bot-profile-icon.js'
import { PLATFORM_APP_DESCRIPTION } from './platform-app-description.js'

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_TIMEOUT_MS = 5000
const DISCORD_ICON_SIZE = 512
const DISCORD_ICON_BACKGROUND = '#ffffff'

export type DiscordBotProfileAgent = BotProfileIconAgent
export type DiscordBotProfileSyncer = (botToken: string, agent: DiscordBotProfileAgent) => Promise<void>

async function iconData(agent: BotProfileIconAgent, iconStore?: IconStore): Promise<string> {
  const icon = await loadBotProfileIcon(agent, iconStore, DISCORD_ICON_SIZE)
  const { default: sharp } = await import('sharp')
  const png = await sharp(icon.bytes)
    .resize(DISCORD_ICON_SIZE, DISCORD_ICON_SIZE, { fit: 'cover' })
    .flatten({ background: DISCORD_ICON_BACKGROUND })
    .png()
    .toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

async function patchProfile(botToken: string, path: string, body: Record<string, string>): Promise<void> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bot ${botToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS)
  })
  await res.arrayBuffer()
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
}

/** Apply an Agent profile to both Discord identities: the bot-user avatar used
 * in messages/member lists, plus the application icon and generic public
 * description shown on install/profile surfaces. Both calls are attempted;
 * callers treat any failure as cosmetic and keep the integration. */
export function createDiscordBotProfileSyncer(iconStore?: IconStore): DiscordBotProfileSyncer {
  return async (botToken, agent) => {
    const data = await iconData(agent, iconStore)
    const results = await Promise.allSettled([
      patchProfile(botToken, '/users/@me', { avatar: data }),
      patchProfile(botToken, '/applications/@me', { icon: data, description: PLATFORM_APP_DESCRIPTION })
    ])
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : 'unknown error'] : []
    )
    if (failures.length > 0) throw new Error(`Discord profile sync failed: ${failures.join('; ')}`)
  }
}
