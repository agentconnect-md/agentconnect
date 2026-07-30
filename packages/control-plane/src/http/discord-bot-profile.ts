import type { IconStore } from '../icons/icon-store.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from './bot-profile-icon.js'

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_TIMEOUT_MS = 5000
const DISCORD_ICON_SIZE = 512
const DISCORD_ICON_BACKGROUND = '#ffffff'

export type DiscordBotIconSyncer = (botToken: string, agent: BotProfileIconAgent) => Promise<void>

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

async function patchIcon(botToken: string, path: string, field: 'avatar' | 'icon', data: string): Promise<void> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bot ${botToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ [field]: data }),
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS)
  })
  await res.arrayBuffer()
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
}

/** Apply an opaque high-resolution Agent icon to both Discord identities: the
 * bot user (messages and member lists) and the application (install/profile
 * surfaces). The white plate keeps transparent icons consistent instead of
 * exposing Discord's dark avatar backdrop. Both calls are attempted; the route
 * treats any failure as cosmetic and keeps the integration. */
export function createDiscordBotIconSyncer(iconStore?: IconStore): DiscordBotIconSyncer {
  return async (botToken, agent) => {
    const data = await iconData(agent, iconStore)
    const results = await Promise.allSettled([
      patchIcon(botToken, '/users/@me', 'avatar', data),
      patchIcon(botToken, '/applications/@me', 'icon', data)
    ])
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : 'unknown error'] : []
    )
    if (failures.length > 0) throw new Error(`Discord icon sync failed: ${failures.join('; ')}`)
  }
}
