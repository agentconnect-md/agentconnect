import type { AgentRecord } from '../persistence/ports.js'
import { renderAgentIconPng } from '../agents/agent-icon-render.js'
import { agentIconKey, type IconStore } from '../icons/icon-store.js'

const STORED_ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export type BotProfileIconAgent = Pick<AgentRecord, 'id' | 'icon' | 'runtime'>

export interface BotProfileIcon {
  bytes: Uint8Array
  contentType: string
}

/** Load the Agent icon as raster bytes for an external platform profile.
 * Uploaded images come from the configured store; glyph/runtime descriptors
 * reuse the public icon endpoint's PNG renderer at the consumer's target size. */
export async function loadBotProfileIcon(
  agent: BotProfileIconAgent,
  iconStore?: IconStore,
  renderWidth = 128
): Promise<BotProfileIcon> {
  if (agent.icon?.kind === 'image') {
    if (!iconStore) throw new Error('uploaded agent icon store is unavailable')
    const stored = await iconStore.get(agentIconKey(agent.id))
    if (!stored) throw new Error('uploaded agent icon is missing')
    if (!STORED_ICON_TYPES.has(stored.contentType)) {
      throw new Error(`uploaded agent icon has unsupported content type ${stored.contentType}`)
    }
    return stored
  }

  return {
    bytes: await renderAgentIconPng(agent.icon, agent.runtime, renderWidth),
    contentType: 'image/png'
  }
}
