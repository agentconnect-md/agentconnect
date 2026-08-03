/**
 * The Arena game world — rooms, membership, and outbound authorization
 * (docs/designs/collaboration-arena.md §3/§7.2).
 *
 * The world is the single outbound-effect sink shared by ordinary replies and
 * MCP sends: every attempt — delivered or rejected — is recorded with a
 * monotonic `sequence`, the resolved integration, and the TRUSTED sender
 * identity (resolved from the integration registry, never from the effect's
 * claim). Rejections use the §7.2 taxonomy, so "unauthorized delivery" and
 * "wrong-room delivery" are hard gates over ATTEMPTED effects.
 */
import type {
  DaemonEvaluationEnvironment,
  EffectiveIntegration,
  OutboundEffectInput,
  OutboundEffectResult,
  OutboundRejection,
  RecordedOutboundEffect,
  VirtualChannelInfo,
  VirtualConnectionWorldPort,
  VirtualMember,
  VirtualProfile,
  VirtualThreadMessage
} from '../../packages/daemon/src/evaluation/index.js'
import {
  VirtualDiscordConnection,
  VirtualSlackConnection,
  VirtualTelegramConnection
} from '../../packages/daemon/src/evaluation/index.js'
import type { CompiledIntegrationSpec, CompiledTopology, WorldEventRecord } from './types.js'

export class ArenaWorld implements VirtualConnectionWorldPort {
  private sequence = 0
  private readonly effects: RecordedOutboundEffect[] = []
  private drainedEffects = 0
  private readonly eventLog: WorldEventRecord[] = []
  private readonly integrationsById = new Map<string, CompiledIntegrationSpec>()
  private readonly channelsById = new Map<
    string,
    { info: VirtualChannelInfo; memberAgentIds: Set<string>; threads: Set<string>; visibleTo: Set<string> }
  >()
  private readonly agentAliasById = new Map<string, string>()
  private messageCounter = 0
  private readonly messageEpoch: number
  /** Provider-visible room history per `<channel>\u001f<thread>` — what
   *  `getThreadReplies` returns, i.e. what a running turn discovers at its
   *  final refresh. Referee/relay ingress and delivered agent posts both land
   *  here, in `ts` order, exactly as they would in a real Slack thread. */
  private readonly history = new Map<string, VirtualThreadMessage[]>()
  /** Fired synchronously as soon as an effect is DELIVERED, before the sending
   *  agent's turn returns — the production timing that lets a concurrent turn
   *  observe the post at its turn-final refresh and regenerate. */
  private readonly deliveredHooks = new Set<(effect: RecordedOutboundEffect) => void>()

  constructor(readonly topology: CompiledTopology) {
    this.messageEpoch = 1_690_000_000 + (topology.seed % 9_999_999)
    for (const integration of topology.integrations) this.integrationsById.set(integration.integrationId, integration)
    for (const agent of topology.agents) this.agentAliasById.set(agent.agentId, agent.alias)
    for (const room of topology.rooms) {
      this.channelsById.set(room.channel, {
        info: { id: room.channel, name: room.alias, isIm: false, isPrivate: false },
        memberAgentIds: new Set(room.memberAgentIds),
        threads: new Set([room.thread]),
        visibleTo: new Set([...room.memberIntegrationIds, ...room.observerIntegrationIds])
      })
    }
  }

  aliasOfAgent(agentId: string): string {
    return this.agentAliasById.get(agentId) ?? agentId
  }

  nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  /** Mint a platform-shaped message id for a world-authored room event. */
  mintMessageId(platform: string): string {
    this.messageCounter += 1
    if (platform === 'slack') return `${this.messageEpoch}.${String(this.messageCounter).padStart(6, '0')}`
    return String(this.messageEpoch * 1000 + this.messageCounter)
  }

  appendEvent(
    record: { type: string; origin: WorldEventRecord['origin']; sequence?: number } & Record<string, unknown>
  ): WorldEventRecord {
    const complete: WorldEventRecord = { ...record, sequence: record.sequence ?? this.nextSequence() }
    this.eventLog.push(complete)
    return complete
  }

  /** Register a world-authored room message so later thread coordinates naming
   *  it validate (§7.2 `invalid_thread`). */
  registerRoomMessage(channel: string, messageId: string): void {
    this.channelsById.get(channel)?.threads.add(messageId)
  }

  /** Register a synchronous delivered-effect observer (peer fan-out). */
  onDelivered(hook: (effect: RecordedOutboundEffect) => void): void {
    this.deliveredHooks.add(hook)
  }

  private historyKey(channel: string, thread: string): string {
    return `${channel}\u001f${thread}`
  }

  /** Append a provider-visible room message (referee/relay ingress). */
  recordThreadMessage(channel: string, thread: string, message: VirtualThreadMessage): void {
    const key = this.historyKey(channel, thread)
    const rows = this.history.get(key) ?? []
    rows.push(message)
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    this.history.set(key, rows)
  }

  threadHistory(channel: string, thread: string): readonly VirtualThreadMessage[] {
    return this.history.get(this.historyKey(channel, thread)) ?? []
  }

  // ── VirtualConnectionWorldPort ────────────────────────────────────────────

  async recordOutbound(effect: OutboundEffectInput): Promise<OutboundEffectResult> {
    const sequence = this.nextSequence()
    const integration = this.integrationsById.get(effect.integrationId)
    const reject = (reason: OutboundRejection): OutboundEffectResult => {
      const record: RecordedOutboundEffect = {
        ...effect,
        sequence,
        ...(integration ? { agentId: integration.agentId } : {}),
        status: 'rejected',
        reason
      }
      this.effects.push(record)
      this.appendEvent({
        sequence,
        type: 'outbound.rejected',
        origin: 'agent_effect',
        kind: effect.kind,
        ...(integration ? { agentId: integration.agentId, agentAlias: integration.agentAlias } : {}),
        integrationId: effect.integrationId,
        channel: effect.channel,
        ...(effect.thread !== undefined ? { thread: effect.thread } : {}),
        reason,
        text: effect.text
      })
      return { status: 'rejected', sequence, reason }
    }

    // §7.2 checks — the ones a real platform + daemon policy would enforce.
    if (!integration) return reject('integration_not_owned')
    if (effect.identity?.agentAuthorId !== undefined && effect.identity.agentAuthorId !== integration.agentId) {
      return reject('integration_not_owned')
    }
    if (effect.platform !== integration.platform) return reject('platform_mismatch')
    const channel = this.channelsById.get(effect.channel)
    if (!channel) return reject('unknown_channel')
    if (!channel.visibleTo.has(effect.integrationId)) return reject('channel_not_visible')
    if (!channel.memberAgentIds.has(integration.agentId)) return reject('not_a_member')
    if (effect.thread !== undefined && !channel.threads.has(effect.thread)) return reject('invalid_thread')

    const messageId = this.mintMessageId(effect.platform)
    if (effect.thread === undefined) channel.threads.add(messageId)
    const record: RecordedOutboundEffect = {
      ...effect,
      sequence,
      agentId: integration.agentId,
      status: 'delivered',
      messageId
    }
    this.effects.push(record)
    // The post is now part of the provider-visible thread — a concurrent turn's
    // final snapshot must see it (that is what trips the regeneration fence).
    if (effect.thread !== undefined) {
      this.recordThreadMessage(effect.channel, effect.thread, {
        ts: messageId,
        text: effect.text,
        sender: this.botUserIdFor(effect.integrationId) ?? integration.agentId,
        isBot: true,
        agentAuthorId: integration.agentId,
        ...(effect.kind === 'chrome' ? { chrome: true } : {})
      })
    }
    this.appendEvent({
      sequence,
      type: 'outbound.delivered',
      origin: 'agent_effect',
      kind: effect.kind,
      agentId: integration.agentId,
      agentAlias: integration.agentAlias,
      integrationId: effect.integrationId,
      channel: effect.channel,
      ...(effect.thread !== undefined ? { thread: effect.thread } : {}),
      messageId,
      text: effect.text
    })
    // Synchronous fan-out hooks run BEFORE this promise resolves, so the peer
    // ingress is already queued while the posting agent's turn is still open.
    for (const hook of this.deliveredHooks) hook(record)
    return { status: 'delivered', messageId, sequence }
  }

  /** The bot user id the daemon bound for one virtual integration. */
  botUserIdFor(integrationId: string): string | undefined {
    return this.integrationsById.get(integrationId)?.botUserId
  }

  channelInfo(channel: string): VirtualChannelInfo | undefined {
    return this.channelsById.get(channel)?.info
  }

  members(channel: string): readonly VirtualMember[] {
    const room = this.channelsById.get(channel)
    if (!room) return []
    return [...room.memberAgentIds].map((agentId) => ({
      id: agentId,
      name: this.aliasOfAgent(agentId),
      isBot: true
    }))
  }

  channels(integrationId: string): readonly VirtualChannelInfo[] {
    return [...this.channelsById.values()]
      .filter((channel) => channel.visibleTo.has(integrationId))
      .map((channel) => channel.info)
  }

  profile(user: string): VirtualProfile | undefined {
    const alias = this.agentAliasById.get(user)
    if (alias) return { id: user, name: alias, isBot: true }
    return { id: user, name: user, isBot: false }
  }

  // ── world log + effect stream ─────────────────────────────────────────────

  drainOutboundEffects(): readonly RecordedOutboundEffect[] {
    const drained = this.effects.slice(this.drainedEffects)
    this.drainedEffects = this.effects.length
    return drained
  }

  allEffects(): readonly RecordedOutboundEffect[] {
    return this.effects
  }

  events(): readonly WorldEventRecord[] {
    return this.eventLog
  }

  /** §9.2 hard-gate counters over ATTEMPTED effects. */
  invariantCounters(): Record<string, number> {
    const rejected = this.effects.filter((effect) => effect.status === 'rejected')
    return {
      attemptedUnauthorizedEffects: rejected.filter(
        (effect) => effect.reason === 'integration_not_owned' || effect.reason === 'platform_mismatch'
      ).length,
      wrongRoomMessages: rejected.filter(
        (effect) =>
          effect.reason === 'not_a_member' ||
          effect.reason === 'channel_not_visible' ||
          effect.reason === 'unknown_channel' ||
          effect.reason === 'invalid_thread'
      ).length
    }
  }

  /** Build the §5 environment: ONE registry, projected by the daemon into both
   *  `agent.integrations` and the connection maps. */
  buildEnvironment(): DaemonEvaluationEnvironment {
    const integrations: EffectiveIntegration[] = this.topology.integrations.map((spec) => {
      const connection =
        spec.platform === 'slack'
          ? new VirtualSlackConnection(
              spec.integrationId,
              { workspaceId: spec.tenant?.workspaceId ?? `TARENA${this.topology.seed}` },
              this,
              { botUserId: spec.botUserId }
            )
          : spec.platform === 'discord'
            ? new VirtualDiscordConnection(spec.integrationId, this)
            : new VirtualTelegramConnection(spec.integrationId, this)
      return {
        integrationId: spec.integrationId,
        agentId: spec.agentId,
        platform: spec.platform,
        transportScope: spec.transportScope,
        ...(spec.tenant ? { tenant: spec.tenant } : {}),
        bindRules: spec.bindChannels.map((channel) => ({ channel, match: { kind: 'auto' as const } })),
        connection
      }
    })
    const topology = this.topology
    return {
      integrations,
      collaborationRoutes: topology.collabRoutes,
      listAgents: async (request) => {
        const channel = request.channel ? this.channelsById.get(request.channel) : undefined
        const agents = topology.agents
          .filter((agent) => (channel ? channel.memberAgentIds.has(agent.agentId) : true))
          .map((agent) => ({ agentId: agent.agentId, name: agent.alias, status: 'active' as const }))
        return {
          platform: request.platform,
          ...(request.channel !== undefined ? { channel: request.channel } : {}),
          agents
        }
      }
    }
  }
}
