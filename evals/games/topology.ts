/**
 * Alias → concrete-identifier topology compiler
 * (docs/designs/collaboration-arena.md §5.1).
 *
 * Resolves every manifest alias into protocol-valid concrete identifiers —
 * UUID agent/integration/daemon ids, platform-shaped channel and thread
 * coordinates, per-integration transport-scope seeds — deterministically from
 * the game seed, and compiles the room graph into a production
 * `CollabRoutesSnapshot`. The alias map travels into `topology.json`.
 */
import { createHash } from 'node:crypto'
import { CollabRoutesSnapshot } from '../../packages/protocol/src/index.js'
import type { CompiledIntegrationSpec, CompiledRoom, CompiledTopology, GameTopologyManifest } from './types.js'

/** RFC-4122-shaped (version 4 / variant 10) uuid derived from a stable name —
 *  deterministic per (seed, name), valid for every wire schema `uuid()` check. */
export function deterministicUuid(seed: number, name: string): string {
  const digest = createHash('sha256').update(`agentconnect-arena:${seed}:${name}`).digest('hex')
  const hex = (start: number, length: number) => digest.slice(start, start + length)
  const variantNibble = ((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex(0, 8)}-${hex(8, 4)}-4${hex(13, 3)}-${variantNibble}${hex(17, 3)}-${hex(20, 12)}`
}

function slackChannelId(seed: number, alias: string): string {
  const digest = createHash('sha256').update(`channel:${seed}:${alias}`).digest('hex')
  return `C${digest.slice(0, 10).toUpperCase()}`
}

function numericChannelId(seed: number, alias: string): string {
  const digest = createHash('sha256').update(`channel:${seed}:${alias}`).digest()
  return String(100_000_000_000 + (digest.readUInt32BE(0) % 900_000_000_000))
}

/** Slack-shaped thread ts (`<epoch>.<6 digits>`); Discord threads key the
 *  channel itself; Telegram reply-threads use the `tg:` root namespace. */
function threadCoordinate(platform: string, channel: string, seed: number, alias: string): string {
  const digest = createHash('sha256').update(`thread:${seed}:${alias}`).digest()
  if (platform === 'slack')
    return `${1_700_000_000 + (digest.readUInt32BE(0) % 99_999_999)}.${String(digest.readUInt32BE(4) % 1_000_000).padStart(6, '0')}`
  if (platform === 'discord') return channel
  return `tg:${100_000 + (digest.readUInt32BE(0) % 900_000)}`
}

function slackBotUserId(seed: number, alias: string): string {
  const digest = createHash('sha256').update(`bot:${seed}:${alias}`).digest('hex')
  return `UB${digest.slice(0, 8).toUpperCase()}`
}

export function compileTopology(manifest: GameTopologyManifest): CompiledTopology {
  const seed = manifest.seed
  const orgId = `org_arena_${String(seed)}`
  const daemonId = deterministicUuid(seed, 'daemon')
  const agents = manifest.agents.map((agent) => ({
    alias: agent.id,
    agentId: deterministicUuid(seed, `agent:${agent.id}`)
  }))
  const agentIdByAlias = new Map(agents.map((agent) => [agent.alias, agent.agentId]))
  for (const room of manifest.rooms) {
    for (const member of [...room.members, ...(room.observers ?? [])]) {
      if (!agentIdByAlias.has(member)) throw new Error(`room "${room.id}" names unknown agent alias "${member}"`)
    }
  }

  // One integration per agent per platform it appears on (a bridge identity in
  // two same-platform rooms holds ONE integration reaching both channels).
  const integrationByKey = new Map<string, CompiledIntegrationSpec>()
  const rooms: CompiledRoom[] = manifest.rooms.map((room) => {
    const channel = room.platform === 'slack' ? slackChannelId(seed, room.id) : numericChannelId(seed, room.id)
    const thread = threadCoordinate(room.platform, channel, seed, room.id)
    const resolveIntegration = (agentAlias: string): CompiledIntegrationSpec => {
      const key = `${agentAlias}/${room.platform}`
      let integration = integrationByKey.get(key)
      if (!integration) {
        integration = {
          alias: key,
          integrationId: deterministicUuid(seed, `integration:${key}`),
          agentId: agentIdByAlias.get(agentAlias)!,
          agentAlias,
          platform: room.platform,
          transportScope: `arena-${seed}-${key}`,
          ...(room.platform === 'slack' ? { tenant: { workspaceId: `TARENA${seed}` } } : {}),
          botUserId: slackBotUserId(seed, key),
          bindChannels: [],
          visibleChannels: []
        }
        integrationByKey.set(key, integration)
      }
      return integration
    }
    const memberIntegrationIds = room.members.map((alias) => {
      const integration = resolveIntegration(alias)
      if (!integration.bindChannels.includes(channel)) integration.bindChannels.push(channel)
      if (!integration.visibleChannels.includes(channel)) integration.visibleChannels.push(channel)
      return integration.integrationId
    })
    const observerIntegrationIds = (room.observers ?? []).map((alias) => {
      const integration = resolveIntegration(alias)
      if (!integration.visibleChannels.includes(channel)) integration.visibleChannels.push(channel)
      return integration.integrationId
    })
    return {
      alias: room.id,
      platform: room.platform,
      channel,
      thread,
      memberAgentIds: room.members.map((alias) => agentIdByAlias.get(alias)!),
      memberIntegrationIds,
      observerIntegrationIds
    }
  })
  const integrations = [...integrationByKey.values()]
  const integrationByAgentPlatform = new Map(integrations.map((i) => [`${i.agentAlias}/${i.platform}`, i]))

  const collabRoutes = CollabRoutesSnapshot.parse({
    generation: 1,
    channels: manifest.rooms.map((room, index) => ({
      orgId,
      platform: room.platform,
      channelId: rooms[index]!.channel,
      agents: room.members.map((alias) => ({
        agentId: agentIdByAlias.get(alias)!,
        daemonId,
        integrationId: integrationByAgentPlatform.get(`${alias}/${room.platform}`)!.integrationId,
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'all',
        allowedTargetAgentIds: [],
        name: alias
      }))
    })),
    agents: agents.map((agent) => ({
      orgId,
      agentId: agent.agentId,
      daemonId,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      name: agent.alias
    }))
  })

  return {
    game: manifest.game,
    seed,
    orgId,
    daemonId,
    agents,
    integrations,
    rooms,
    collabRoutes,
    aliasMap: {
      agents: Object.fromEntries(agents.map((agent) => [agent.alias, agent.agentId])),
      integrations: Object.fromEntries(integrations.map((i) => [i.alias, i.integrationId])),
      rooms: Object.fromEntries(rooms.map((room) => [room.alias, { channel: room.channel, thread: room.thread }]))
    }
  }
}
