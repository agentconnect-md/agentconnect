/**
 * The daemon-side observed-channels SYNC ENGINE: rebuild the console's channel set for
 * platforms that cannot enumerate a bot's memberships, record newly observed chats, and
 * retract conversations the bot has left. The per-platform collapse/space strategies it
 * consumes live in ./observed-channels.ts — this file is the core that reads them.
 *
 * The Daemon keeps thin same-name delegates and everything here reaches back through
 * {@link ObservedChannelsSyncHost}, which extends the strategies' own narrow host so one
 * object serves both. `channelSnapshots` stays on the Daemon — many other call sites read
 * it — and is reached through the port.
 */
import type { IntegrationChannel } from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { CpClient } from '../cp/client.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { LocalStore } from '../store/local-store.js'
import type { TelegramObservedChat } from '../telegram/connection.js'
import {
  observedChannelsFor,
  observedMembershipPlatforms,
  type ObservedChannelsHost,
  type ObservedChat
} from './observed-channels.js'

/** Exactly what the sync engine touches on the Daemon — nothing wider. */
export interface ObservedChannelsSyncHost extends ObservedChannelsHost {
  store(): LocalStore
  debug(message: string): void
  now(): number
  cpClient(): CpClient | undefined
  agents(): Map<string, LoadedAgent>
  /** The Daemon's cached per-integration channel snapshots, read and written in place. */
  channelSnapshots(): Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>
  integrationConfigById(integrationId: string): Integration | undefined
  transportScopeForIntegration(integration: Integration): string
  emitSessionMetadataSnapshotsForDisplayName(id: string): Promise<void>
}

export class ObservedChannelsSync {
  constructor(private readonly host: ObservedChannelsSyncHost) {}

  /**
   * Observed-conversation discovery for every platform the §5 manifest marks
   * `membershipEnumeration: 'observed'` — today Telegram, Discord and Feishu. These
   * platforms do not give us an authoritative set of chats the bot is engaged in, so
   * stored session history is merged with explicitly-addressed Off conversations already
   * cached for the integration. Reports carry `authoritative:false`: the CP upserts
   * what we know but never treats an absent row as a leave.
   *
   * Names fill in lazily through ChannelNameResolver. Re-merging the cached rows
   * here is important for Off conversations: they have no session row, so without
   * preserving and enriching the cached entry an async Telegram getChat result
   * could never replace the console's raw numeric id.
   *
   * Legacy Discord rows are folded onto the channel they belong to first; current
   * Discord sessions already persist that enclosing channel directly.
   */
  async refreshObservedChannels(): Promise<void> {
    const store = this.host.store()
    const snapshots = this.host.channelSnapshots()
    for (const agent of this.host.agents().values()) {
      for (const platform of observedMembershipPlatforms()) {
        const integrations = agent.integrations.filter((i) => i.platform === platform)
        if (integrations.length === 0) continue
        for (const integ of integrations) {
          // A conversation the bot left is still all over session history, so the
          // retracted set is subtracted from BOTH sources — the fresh observations and
          // the cached rows carried forward — or the rebuild would resurrect it.
          //
          // Subtracted AFTER the compatibility collapse: a legacy Discord observation
          // may still be a thread id, while the tombstone names its enclosing channel.
          const retracted = await store.retractedConversations(integ.id)
          const observed = (
            await this.collapseObserved(
              await store.observedChannels(agent.id, platform, this.host.transportScopeForIntegration(integ)),
              platform
            )
          ).filter((c) => !retracted.has(c.id))
          const prior = (snapshots.get(integ.id)?.channels ?? []).filter((c) => !retracted.has(c.id))
          if (observed.length === 0 && prior.length === 0) continue
          const priorById = new Map(prior.map((c) => [c.id, c]))
          const observedIds = new Set(observed.map((c) => c.id))
          const names = await store.getDisplayNames([...new Set([...observedIds, ...prior.map((c) => c.id)])])
          // The sessions table cannot distinguish DMs from groups, so the kind comes
          // from the channel lookup's own verdict (`channel_scopes.isIm`), falling back
          // to the kind explicit gated-conversation discovery established. Without it a
          // DM surfaces as a configurable channel row named "@someone", which is not a
          // channel anyone can invite the bot to or set a trigger on.
          const kinds = await store.getChannelScopes([...observedIds])
          const fromSessions: IntegrationChannel[] = observed.map((c) => {
            const previous = priorById.get(c.id)
            const isIm = kinds.get(c.id)?.isIm
            const kind = isIm === undefined ? previous?.kind : isIm ? ('im' as const) : ('channel' as const)
            const name = c.name ?? names.get(c.id)
            // The enclosing Discord server: the guild snowflake is the identity the
            // console groups on (two servers may share a name), the label is display
            // only. Keep the last known values when this pass can't resolve them (the
            // guild name lands with the channel's name lookup), so the console never
            // flickers back to a bare "#general".
            const spaceId = c.spaceId ?? previous?.spaceId
            const space = c.space ?? previous?.space
            return {
              id: c.id,
              ...(name ? { name } : {}),
              ...(spaceId ? { spaceId } : {}),
              ...(space ? { space } : {}),
              ...(previous?.isPrivate !== undefined ? { isPrivate: previous.isPrivate } : {}),
              ...(kind ? { kind } : {})
            }
          })
          const retained = await Promise.all(
            prior
              .filter((c) => !observedIds.has(c.id))
              .map(async (c) => {
                const name = names.get(c.id)
                // A retained row has no session behind it (a gated Off channel), so its
                // space is looked up directly rather than coming out of the collapse.
                const found = await this.spaceFor(platform, c.id)
                const spaceId = found?.id ?? c.spaceId
                const space = found?.name ?? c.space
                const next = {
                  ...c,
                  ...(name ? { name } : {}),
                  ...(spaceId ? { spaceId } : {}),
                  ...(space ? { space } : {})
                }
                return next.name === c.name && next.spaceId === c.spaceId && next.space === c.space ? c : next
              })
          )
          const channels = [...fromSessions, ...retained]
          snapshots.set(integ.id, { channels, authoritative: false })
          this.host.cpClient()?.emitIntegrationChannels({ integrationId: integ.id, channels, authoritative: false })
        }
      }
    }
  }

  /**
   * A retracted conversation that is talking to us again has plainly been re-joined —
   * a platform only delivers messages for a conversation the bot is actually in — so
   * traffic lifts the suppression and the row comes back on the next refresh.
   *
   * Without this, "leave" would be permanent in the console even after someone
   * re-invited the bot, and the operator would have no way to undo it from here.
   */
  async clearRetractionOnTraffic(msg: NormalizedMessage, srcIntegrationIds?: string[]): Promise<void> {
    if (msg.source !== 'user' || !srcIntegrationIds?.length) return
    for (const integrationId of srcIntegrationIds) {
      const retracted = await this.host.store().retractedConversations(integrationId)
      if (retracted.size === 0) continue
      if (retracted.has(msg.channel)) {
        await this.host.store().clearRetractedConversation(integrationId, msg.channel)
        this.host.debug(`channels: ${msg.channel} is active again — retraction cleared for ${integrationId}`)
      }
    }
  }

  /**
   * Retract conversations from this integration's reported set — the counterpart to
   * discovery, for platforms whose snapshots can only ever grow. Absence from a
   * non-authoritative report means nothing, so the ids ride an explicit `removed`.
   */
  async retractChannels(integrationId: string, channelIds: readonly string[]): Promise<void> {
    if (channelIds.length === 0) return
    const gone = new Set(channelIds)
    // Durably, before touching the snapshot. The observed set of a non-enumerating
    // platform is rebuilt from SESSION HISTORY, which knows nothing about leaving, so
    // without this marker the very next refresh restores the row and undoes the
    // departure. `refreshObservedChannels` reads it back.
    await this.host.store().markRetractedConversations(integrationId, [...gone], this.host.now())
    const snapshots = this.host.channelSnapshots()
    const cached = snapshots.get(integrationId)
    const channels = (cached?.channels ?? []).filter((c) => !gone.has(c.id))
    snapshots.set(integrationId, { channels, authoritative: cached?.authoritative ?? false })
    this.host.cpClient()?.emitIntegrationChannels({
      integrationId,
      channels,
      authoritative: false,
      removed: [...gone]
    })
  }

  /**
   * Telegram cannot enumerate a bot's chats. Its own `new_chat_members` service
   * record therefore contributes one non-authoritative observed channel row, but
   * never enters `onInbound` or creates an agent turn.
   */
  async observeTelegramChat(chat: TelegramObservedChat, integrationIds: readonly string[]): Promise<void> {
    await this.observePlatformChat('telegram', chat, integrationIds)
  }

  /** Record one observed chat row for a platform that cannot enumerate its bot's
   *  chats. The event's own platform filters the fan-out — a caller is already
   *  platform-specific and names it as data, not a branch. */
  async observePlatformChat(platform: string, chat: ObservedChat, integrationIds: readonly string[]): Promise<void> {
    await this.observePlatformChats(platform, [chat], integrationIds)
  }

  /** The same for a whole set — Linear reports a workspace's teams at once (§4.5), and one
   *  report per integration beats one per conversation on a snapshot they all share. */
  async observePlatformChats(
    platform: string,
    chats: readonly ObservedChat[],
    integrationIds: readonly string[]
  ): Promise<void> {
    if (chats.length === 0) return
    for (const chat of chats) {
      if (!chat.name) continue
      await this.host.store().setDisplayName(chat.id, chat.name, Date.now())
      await this.host.emitSessionMetadataSnapshotsForDisplayName(chat.id)
    }
    const snapshots = this.host.channelSnapshots()
    for (const integrationId of integrationIds) {
      const integration = this.host.integrationConfigById(integrationId)
      if (!integration || integration.platform !== platform) continue
      let channels = snapshots.get(integrationId)?.channels ?? []
      let changed = false
      for (const chat of chats) {
        const current = channels.find((channel) => channel.id === chat.id)
        const observed: IntegrationChannel = {
          ...current,
          id: chat.id,
          ...(chat.name ? { name: chat.name } : {}),
          isPrivate: chat.isPrivate,
          kind: 'channel'
        }
        if (
          current?.name === observed.name &&
          current?.isPrivate === observed.isPrivate &&
          current?.kind === observed.kind
        ) {
          continue
        }
        channels = current
          ? channels.map((channel) => (channel.id === chat.id ? observed : channel))
          : [...channels, observed]
        changed = true
      }
      if (!changed) continue
      snapshots.set(integrationId, { channels, authoritative: false })
      this.host.cpClient()?.emitIntegrationChannels({ integrationId, channels, authoritative: false })
    }
  }

  /** The space a channel sits in, per its platform's strategy — the id that keeps
   *  one bot's several same-named rows apart (Discord guilds). Undefined on
   *  platforms without the notion, or until the lookup has recorded it. */
  spaceFor(platform: string, channelId: string): Promise<{ id: string; name?: string } | undefined> {
    return observedChannelsFor(platform)?.spaceFor(this.host, channelId) ?? Promise.resolve(undefined)
  }

  /**
   * Fold legacy observed conversations onto the channel set the console should offer
   * and attach platform-specific space metadata. Current Discord rows already name the
   * enclosing channel; older thread-as-channel rows still collapse through the strategy.
   */
  collapseObserved(
    observed: { id: string; name?: string }[],
    platform: string
  ): Promise<{ id: string; name?: string; spaceId?: string; space?: string }[]> {
    return observedChannelsFor(platform)?.collapse(this.host, observed) ?? Promise.resolve(observed)
  }
}
