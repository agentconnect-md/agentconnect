// Where the console's managed-memory reads and a place clear go: a Control-Plane home answers from the CP's tables, any other home from the agent's daemon.
import type {
  MemoryChannelClearOk,
  MemoryChannelClearReq,
  MemoryChannelsPage,
  MemoryChannelsReq,
  MemoryListPage,
  MemoryListReq,
  MemoryReadContent,
  MemoryReadReq
} from '@agentconnect.md/protocol'
import { AgentMemoryConsoleReader } from '../agent-memory/console-reader.js'
import { memoryHomedInControlPlane } from '../agent-memory/home.js'
import { MemoryHomeUnavailableError } from '../agent-memory/unavailable.js'
import { AgentId } from '../domain/ids.js'
import type { AgentRecord } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'

export interface MemorySource {
  /** Whether it serves a newer request, a person layer or a place clear: a daemon says so in its features, the CP always does. */
  supports(feature: string): Promise<boolean>
  channels(req: MemoryChannelsReq): Promise<MemoryChannelsPage>
  list(req: MemoryListReq): Promise<MemoryListPage>
  read(req: MemoryReadReq): Promise<MemoryReadContent>
  clearChannel(req: MemoryChannelClearReq): Promise<MemoryChannelClearOk>
}

/** The source of one agent's console memory; null when its home is a daemon and none serves it. */
export function makeMemorySources(deps: HttpDeps): (agent: AgentRecord) => MemorySource | null {
  const table = new AgentMemoryConsoleReader(deps.repos.agentMemoryFile, deps.repos.agentMemoryHistory)
  return (agent) => {
    if (memoryHomedInControlPlane(agent.memory)) return controlPlaneSource(table, agent)
    const daemonId = agent.daemonId
    if (!daemonId) return null
    return {
      supports: async (feature) =>
        (await deps.registry.getAvailable(agent.orgId, daemonId))?.capabilities.features.includes(feature) === true,
      channels: (req) => deps.control.memoryChannels(daemonId, req),
      list: (req) => deps.control.memoryList(daemonId, req),
      read: (req) => deps.control.memoryRead(daemonId, req),
      clearChannel: (req) => deps.control.memoryChannelClear(daemonId, req)
    }
  }
}

function controlPlaneSource(table: AgentMemoryConsoleReader, agent: AgentRecord): MemorySource {
  const id = AgentId(agent.id)
  // The table is half-filled until the daemon reports the copy done; the daemon refuses it with this reason too.
  const settled = () => {
    if (agent.memory?.provider === 'managed' && agent.memory.homeMigration === 'pending')
      throw new MemoryHomeUnavailableError(
        'migrating',
        `agent "${agent.id}" keeps its memory in the Control Plane, which is still receiving the copy of its tree`
      )
  }
  return {
    supports: async () => true,
    async channels(req) {
      settled()
      return { agentId: agent.id, channels: await table.channels(id, req.channelKey) }
    },
    async list(req) {
      settled()
      const entries = await table.list(id, req)
      return { agentId: agent.id, exists: entries.length > 0, entries }
    },
    async read(req) {
      settled()
      return table.read(id, req)
    },
    async clearChannel(req) {
      settled()
      return { agentId: agent.id, channelKey: req.channelKey, cleared: await table.clearPlace(id, req.channelKey) }
    }
  }
}
