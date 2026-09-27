// The daemon internals a platform's §7.4 relay-ingress strategy reaches: one port, parameterized by the platform's connection.
import type { LoadedAgent } from '../agents/load-agents.js'
import type { Logger } from '../log.js'
import type { ChannelInfoSource } from '../messages/channel-name-resolver.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { LocalStore } from '../store/local-store.js'
import type { ObservedChat } from './observed-channels.js'

/** Shared by every relay-ingress implementer; `connection` is the only per-platform member. */
export interface RelayIngressHost<TConnection extends ChannelInfoSource> {
  log(): Logger
  store(): Pick<LocalStore, 'hasInbox' | 'appendInbox' | 'getDisplayNames' | 'getOutputModeOverride'>
  now(): number
  /** The platform's live egress connection for `integrationId`, or undefined while none is bound. */
  connection(integrationId: string): TConnection | undefined
  agent(agentId: string): Pick<LoadedAgent, 'name' | 'displayName' | 'output'> | undefined
  /** Resolve the sender and conversation names off the hot path through the connection's read port. */
  noteMessage(conn: TConnection, msg: NormalizedMessage): void
  /** Report one conversation the delivery proves the bot reaches, ahead of any session row. */
  observePlatformChat(platform: string, chat: ObservedChat, integrationIds: readonly string[]): Promise<void>
}
