/**
 * Collaboration Arena game types (docs/designs/collaboration-arena.md §5.1/§13).
 *
 * Game manifests use human-readable ALIASES; the topology compiler resolves
 * every alias into protocol-valid concrete identifiers before anything reaches
 * the daemon. Aliases exist only in manifests and reports; the daemon and the
 * artifacts operate on concrete identifiers, with the alias map recorded in
 * `topology.json`.
 */
import type { CollabRoutesSnapshot } from '../../packages/protocol/src/index.js'

export type GamePlatform = 'slack' | 'discord' | 'telegram'

export interface GameRoomSpec {
  /** Room alias, e.g. `counting-room`. */
  id: string
  platform: GamePlatform
  /** Member agent aliases — may post and are fanned into by injections. */
  members: string[]
  /** Observer agent aliases — the channel is VISIBLE to their integrations but
   *  they are not members (§7.2 distinguishes `channel_not_visible` from
   *  `not_a_member`). */
  observers?: string[]
  /** Direct-message conversation (referee↔agent private channel). */
  dm?: boolean
  /** Private group room (e.g. the werewolves' den) — visible only to members. */
  isPrivate?: boolean
}

export interface GameAgentSpec {
  /** Agent alias, e.g. `agent-a`. */
  id: string
}

export interface GameTopologyManifest {
  game: string
  seed: number
  agents: GameAgentSpec[]
  rooms: GameRoomSpec[]
}

export interface CompiledRoom {
  alias: string
  platform: GamePlatform
  channel: string
  /** Platform-shaped thread coordinate the room conversation lives in. */
  thread: string
  isDm: boolean
  isPrivate: boolean
  memberAgentIds: string[]
  memberIntegrationIds: string[]
  observerIntegrationIds: string[]
}

export interface CompiledIntegrationSpec {
  /** `<agent alias>/<platform>` — one integration per agent per platform. */
  alias: string
  integrationId: string
  agentId: string
  agentAlias: string
  platform: GamePlatform
  /** Transport-scope seed (collaboration-arena §5): distinct per integration. */
  transportScope: string
  tenant?: { workspaceId?: string }
  botUserId: string
  /** Public Slack app id (`A…`) — the identity `cpCollab.isAgentBotApp` checks. */
  botAppId?: string
  /** Channels this integration is routed for (compiled from room membership). */
  bindChannels: string[]
  /** Channels visible without membership (compiled from `observers`). */
  visibleChannels: string[]
}

export interface CompiledTopology {
  game: string
  seed: number
  orgId: string
  daemonId: string
  agents: { alias: string; agentId: string }[]
  integrations: CompiledIntegrationSpec[]
  rooms: CompiledRoom[]
  collabRoutes: CollabRoutesSnapshot
  aliasMap: {
    agents: Record<string, string>
    integrations: Record<string, string>
    rooms: Record<string, { channel: string; thread: string }>
  }
}

/** One line of `world-events.jsonl` (§11): referee events + ordered outbound
 *  effects share one monotonic `sequence`, so game actions and messages have a
 *  single causal order. */
export interface WorldEventRecord extends Record<string, unknown> {
  sequence: number
  type: string
  origin: 'referee' | 'agent_effect' | 'world'
}
