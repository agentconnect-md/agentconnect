import type { AgentRecord } from '../persistence/ports.js'
import { renderAgentIconPng } from '../agents/agent-icon-render.js'
import { agentIconKey, type IconStore } from '../icons/icon-store.js'

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_TIMEOUT_MS = 5000
const STORED_ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type DiscordIconAgent = Pick<AgentRecord, 'id' | 'icon' | 'runtime'>

export type DiscordBotIconSyncer = (botToken: string, agent: DiscordIconAgent) => Promise<void>

async function iconData(agent: DiscordIconAgent, iconStore?: IconStore): Promise<string> {
  if (agent.icon?.kind === 'image') {
    if (!iconStore) throw new Error('uploaded agent icon store is unavailable')
    const stored = await iconStore.get(agentIconKey(agent.id))
    if (!stored) throw new Error('uploaded agent icon is missing')
    if (!STORED_ICON_TYPES.has(stored.contentType)) {
      throw new Error(`uploaded agent icon has unsupported content type ${stored.contentType}`)
    }
    return `data:${stored.contentType};base64,${Buffer.from(stored.bytes).toString('base64')}`
  }

  const png = await renderAgentIconPng(agent.icon, agent.runtime)
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

/** Apply the Agent icon to both Discord identities: the bot user (messages and
 * member lists) and the application (install/profile surfaces). Both calls are
 * attempted; the route treats any failure as cosmetic and keeps the integration. */
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
