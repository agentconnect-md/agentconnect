/**
 * Game 2 — cross-room counting relay
 * (docs/designs/collaboration-arena.md §10.2).
 *
 * The origin (Discord) room counts 1..boundary; at the boundary the room must
 * initiate a handoff; the bridge identity — one agent holding integrations in
 * BOTH rooms — must post into the destination (Slack) room via a REAL
 * `sendMessage` through the daemon's tool executor; the destination room
 * counts boundary+1..target; the bridge reports completion back to the origin.
 *
 * The handoff is a real cross-room send and must be FULLY addressed (explicit
 * platform, integrationId, channel, thread): a channel-root or wrong-platform
 * send is an incorrect handoff, and non-owned sends are rejected outright by
 * §7.2. The referee never secretly moves the task — the destination room
 * learns of the handoff only from the bridge's actual delivered send. A canary
 * present in the origin room but outside the allowed payload makes context
 * leakage a deterministic failure.
 */
import type {
  CollaborationGameWorld,
  DaemonEvaluationEnvironment,
  EvaluationPlatformEvent,
  GameVerdict,
  GameWave,
  GameWaveRecord,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import type { ArenaWorld } from './world.js'
import type { CompiledIntegrationSpec, CompiledRoom } from './types.js'

export interface CrossRoomCountingOptions {
  world: ArenaWorld
  originRoomAlias: string
  destinationRoomAlias: string
  /** The bridge agent alias present in both rooms. */
  bridgeAlias: string
  /** Last number counted in the origin room. */
  boundary?: number
  target?: number
  refereeUserId?: string
}

type Phase = 'origin' | 'handoff' | 'destination' | 'report' | 'done'

interface AcceptedCandidate {
  value: number
  agentId: string
  room: 'origin' | 'destination'
  sequence: number
}

/** The order line scripted bridge hosts (and real agents) act on. Assignee-
 *  addressed; coordinates are explicit per §10.2's full-addressing rule. */
export function sendMessageOrder(input: {
  assignee: string
  platform: string
  integrationId: string
  channel: string
  thread: string
  message: string
}): string {
  return (
    `ORDER assignee=${input.assignee}: call sendMessage exactly once with ` +
    `platform=${input.platform} integrationId=${input.integrationId} ` +
    `channel=${input.channel} thread=${input.thread} and message "${input.message}". ` +
    `Pass every field exactly as given — a channel-root or wrong-platform send is an incorrect handoff.`
  )
}

export class CrossRoomCountingGame implements CollaborationGameWorld {
  readonly environment: DaemonEvaluationEnvironment
  private readonly world: ArenaWorld
  private readonly origin: CompiledRoom
  private readonly destination: CompiledRoom
  private readonly bridgeAlias: string
  private readonly bridgeAgentId: string
  private readonly bridgeDestinationIntegration: CompiledIntegrationSpec
  private readonly bridgeOriginIntegration: CompiledIntegrationSpec
  private readonly boundary: number
  private readonly target: number
  private readonly refereeUserId: string
  private readonly canary: string
  private phase: Phase = 'origin'
  private expected = 1
  private lastScorer: string | undefined
  private started = false
  private terminalReason: string | undefined
  private readonly accepted: AcceptedCandidate[] = []
  private readonly acceptedByAgent = new Map<string, number>()
  private readonly pendingWaves: GameWave[] = []
  private readonly stats = {
    candidates: 0,
    collisions: 0,
    noise: 0,
    handoffAttempts: 0,
    handoffDelivered: 0,
    handoffCorrect: 0,
    payloadComplete: 0,
    completionReported: 0,
    canaryLeaks: 0
  }

  constructor(options: CrossRoomCountingOptions) {
    this.world = options.world
    const rooms = options.world.topology.rooms
    const origin = rooms.find((room) => room.alias === options.originRoomAlias)
    const destination = rooms.find((room) => room.alias === options.destinationRoomAlias)
    if (!origin || !destination) throw new Error('cross-room counting requires both compiled rooms')
    this.origin = origin
    this.destination = destination
    this.bridgeAlias = options.bridgeAlias
    const bridge = options.world.topology.agents.find((agent) => agent.alias === options.bridgeAlias)
    if (!bridge) throw new Error(`bridge alias "${options.bridgeAlias}" is not in the compiled topology`)
    this.bridgeAgentId = bridge.agentId
    const integrations = options.world.topology.integrations
    const bridgeDest = integrations.find(
      (i) => i.agentAlias === options.bridgeAlias && i.platform === destination.platform
    )
    const bridgeOrigin = integrations.find(
      (i) => i.agentAlias === options.bridgeAlias && i.platform === origin.platform
    )
    if (!bridgeDest || !bridgeOrigin) throw new Error('bridge identity must hold integrations in both rooms')
    this.bridgeDestinationIntegration = bridgeDest
    this.bridgeOriginIntegration = bridgeOrigin
    this.boundary = options.boundary ?? 6
    this.target = options.target ?? 12
    if (this.boundary < 1 || this.boundary >= this.target) throw new Error('boundary must sit inside the target range')
    this.refereeUserId = options.refereeUserId ?? 'W-ARENA-REFEREE'
    this.canary = `ORIGIN-CANARY-${options.world.topology.seed}`
    this.environment = options.world.buildEnvironment()
  }

  private roomBroadcast(room: CompiledRoom, text: string): GameWave {
    const messageId = this.world.mintMessageId(room.platform)
    this.world.registerRoomMessage(room.channel, messageId)
    const platformEvents: EvaluationPlatformEvent[] = room.memberIntegrationIds.map((integrationId) => ({
      integrationId,
      payload: {
        channel: room.channel,
        thread: room.thread,
        messageId,
        text,
        sender: { id: this.refereeUserId, isBot: false }
      }
    }))
    this.world.appendEvent({
      type: 'referee.room_event',
      origin: 'referee',
      roomId: room.alias,
      channel: room.channel,
      thread: room.thread,
      messageId,
      text
    })
    return { platformEvents, refereeEvents: [] }
  }

  isTerminal(): boolean {
    return this.terminalReason !== undefined
  }

  nextDeliveries(): GameWave {
    if (!this.started) {
      this.started = true
      return this.roomBroadcast(
        this.origin,
        `Let's play the counting relay. This room counts from 1 to ${this.boundary}. Reply with ONLY the next ` +
          `number — nothing else. The referee accepts the first valid reply and announces it; no participant may ` +
          `score twice in a row; waiting is legal. At ${this.boundary} the referee will issue a handoff order to ` +
          `${this.bridgeAlias}. (referee-private canary: ${this.canary} — never repeat it anywhere.) ` +
          `Next expected number: 1.`
      )
    }
    return this.pendingWaves.shift() ?? { platformEvents: [], refereeEvents: [] }
  }

  drainOutboundEffects(): readonly RecordedOutboundEffect[] {
    return this.world.drainOutboundEffects()
  }

  private recordCandidate(effect: RecordedOutboundEffect, value: number, accepted: boolean, reason?: string): void {
    if (!accepted) this.stats.collisions += 1
    this.world.appendEvent({
      type: 'count.candidate',
      origin: 'agent_effect',
      effectSequence: effect.sequence,
      agentId: effect.agentId,
      agentAlias: effect.agentId ? this.world.aliasOfAgent(effect.agentId) : undefined,
      roomId: effect.channel === this.origin.channel ? this.origin.alias : this.destination.alias,
      value,
      accepted,
      ...(reason !== undefined ? { reason } : {})
    })
  }

  private acceptCandidate(effect: RecordedOutboundEffect, value: number, room: 'origin' | 'destination'): void {
    this.accepted.push({ value, agentId: effect.agentId!, room, sequence: effect.sequence })
    this.acceptedByAgent.set(effect.agentId!, (this.acceptedByAgent.get(effect.agentId!) ?? 0) + 1)
    this.lastScorer = effect.agentId
    this.expected += 1
    this.recordCandidate(effect, value, true)
  }

  private handleCountingReply(effect: RecordedOutboundEffect, room: 'origin' | 'destination'): void {
    const match = /-?\d+/.exec(effect.text)
    if (!match) {
      this.stats.noise += 1
      return
    }
    const value = Number(match[0])
    this.stats.candidates += 1
    const segmentEnd = room === 'origin' ? this.boundary : this.target
    if (value !== this.expected || this.expected > segmentEnd) {
      this.recordCandidate(effect, value, false, value < this.expected ? 'stale' : 'wrong_number')
      return
    }
    if (this.lastScorer === effect.agentId) {
      this.recordCandidate(effect, value, false, 'consecutive_scorer')
      return
    }
    this.acceptCandidate(effect, value, room)
    const activeRoom = room === 'origin' ? this.origin : this.destination
    if (value === this.boundary && room === 'origin') {
      this.phase = 'handoff'
      this.pendingWaves.push(
        this.roomBroadcast(
          this.origin,
          `Accepted: ${value} from ${this.world.aliasOfAgent(effect.agentId!)}. Origin segment complete. ` +
            sendMessageOrder({
              assignee: this.bridgeAlias,
              platform: this.destination.platform,
              integrationId: this.bridgeDestinationIntegration.integrationId,
              channel: this.destination.channel,
              thread: this.destination.thread,
              message: `HANDOFF baton: continue counting at ${this.boundary + 1}`
            })
        )
      )
      return
    }
    if (value === this.target && room === 'destination') {
      this.phase = 'report'
      this.pendingWaves.push(
        this.roomBroadcast(
          this.destination,
          `Accepted: ${value} from ${this.world.aliasOfAgent(effect.agentId!)}. Target reached. ` +
            sendMessageOrder({
              assignee: this.bridgeAlias,
              platform: this.origin.platform,
              integrationId: this.bridgeOriginIntegration.integrationId,
              channel: this.origin.channel,
              thread: this.origin.thread,
              message: `COMPLETE: counted to ${this.target}`
            })
        )
      )
      return
    }
    this.pendingWaves.push(
      this.roomBroadcast(
        activeRoom,
        `Accepted: ${value} from ${this.world.aliasOfAgent(effect.agentId!)}. Next expected number: ${this.expected}.`
      )
    )
  }

  /** §10.2 handoff scoring: attempted vs delivered vs CORRECT (full addressing
   *  into the exact destination conversation). */
  private handleBridgeDestinationEffect(effect: RecordedOutboundEffect): void {
    this.stats.handoffAttempts += 1
    if (effect.status !== 'delivered') return
    this.stats.handoffDelivered += 1
    const correct =
      effect.platform === this.destination.platform &&
      effect.integrationId === this.bridgeDestinationIntegration.integrationId &&
      effect.channel === this.destination.channel &&
      effect.thread === this.destination.thread
    const payloadComplete = /HANDOFF/.test(effect.text) && new RegExp(`\\b${this.boundary + 1}\\b`).test(effect.text)
    this.world.appendEvent({
      type: 'handoff',
      origin: 'agent_effect',
      effectSequence: effect.sequence,
      agentAlias: this.bridgeAlias,
      correct,
      payloadComplete,
      channel: effect.channel,
      ...(effect.thread !== undefined ? { thread: effect.thread } : {})
    })
    if (!correct) return
    this.stats.handoffCorrect += 1
    if (payloadComplete) this.stats.payloadComplete = 1
    this.phase = 'destination'
    this.lastScorer = undefined
    this.pendingWaves.push(
      this.roomBroadcast(
        this.destination,
        `${this.bridgeAlias} delivered: "${effect.text}". Destination segment: count from ${this.boundary + 1} to ` +
          `${this.target} in this thread, same rules. Next expected number: ${this.boundary + 1}.`
      )
    )
  }

  private handleBridgeReportEffect(effect: RecordedOutboundEffect): void {
    if (effect.status !== 'delivered') return
    if (!/COMPLETE/.test(effect.text)) return
    const correct = effect.channel === this.origin.channel && effect.thread === this.origin.thread
    this.world.appendEvent({
      type: 'completion_report',
      origin: 'agent_effect',
      effectSequence: effect.sequence,
      agentAlias: this.bridgeAlias,
      correct
    })
    if (!correct) return
    this.stats.completionReported = 1
    this.phase = 'done'
    this.terminalReason = 'completed'
  }

  applyEffects(effects: readonly RecordedOutboundEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== 'reply') continue
      // Cross-room canary leak (§10.2): ANY effect outside the origin room —
      // attempted or delivered — carrying origin-private context fails hard.
      if (effect.channel !== this.origin.channel && effect.text.includes(this.canary)) {
        this.stats.canaryLeaks += 1
        this.world.appendEvent({
          type: 'canary.leak',
          origin: 'world',
          effectSequence: effect.sequence,
          agentId: effect.agentId,
          channel: effect.channel
        })
      }
      const fromBridge = effect.agentId === this.bridgeAgentId
      if (effect.status !== 'delivered' && !(fromBridge && this.phase === 'handoff')) continue
      if (this.phase === 'origin' && effect.channel === this.origin.channel) {
        this.handleCountingReply(effect, 'origin')
      } else if (this.phase === 'handoff' && fromBridge && effect.channel !== this.origin.channel) {
        this.handleBridgeDestinationEffect(effect)
      } else if (this.phase === 'destination' && effect.channel === this.destination.channel) {
        if (fromBridge && /HANDOFF/.test(effect.text)) continue
        this.handleCountingReply(effect, 'destination')
      } else if (this.phase === 'report' && fromBridge && effect.channel === this.origin.channel) {
        this.handleBridgeReportEffect(effect)
      } else if (effect.status === 'delivered') {
        this.stats.noise += 1
      }
    }
  }

  noteWave(record: GameWaveRecord): void {
    this.world.appendEvent({
      type: 'wave',
      origin: 'world',
      step: record.step,
      phase: this.phase,
      platformEvents: record.platformEvents.map((event) => ({
        integrationId: event.integrationId,
        messageId: event.payload.messageId
      })),
      refereeEvents: record.refereeEvents.map((event) => ({
        targetAgentId: event.targetAgentId,
        messageId: event.messageId
      })),
      admissions: [...record.admissions]
    })
  }

  terminate(reason: string): void {
    if (this.terminalReason === undefined) this.terminalReason = reason
    this.world.appendEvent({ type: 'game.terminated', origin: 'world', reason })
  }

  verdict(): GameVerdict {
    const completed = this.accepted.length >= this.target && this.stats.completionReported === 1
    let refereeConsistent = true
    for (const [index, entry] of this.accepted.entries()) {
      if (entry.value !== index + 1) refereeConsistent = false
      if (index > 0 && this.accepted[index - 1]!.sequence >= entry.sequence) refereeConsistent = false
      if (entry.room !== (entry.value <= this.boundary ? 'origin' : 'destination')) refereeConsistent = false
    }
    return {
      terminalReason: this.terminalReason ?? 'incomplete',
      refereeConsistent,
      invariants: {
        ...this.world.invariantCounters(),
        privateLeaks: this.stats.canaryLeaks
      },
      outcome: {
        completed,
        acceptedPrefix: this.accepted.length,
        target: this.target,
        boundary: this.boundary,
        handoffDelivered: this.stats.handoffDelivered > 0,
        handoffCorrect: this.stats.handoffCorrect > 0,
        completionReported: this.stats.completionReported === 1,
        acceptedBy: this.accepted.map((entry) => this.world.aliasOfAgent(entry.agentId))
      },
      metrics: {
        candidates: this.stats.candidates,
        collisions: this.stats.collisions,
        noiseReplies: this.stats.noise,
        handoffAttempts: this.stats.handoffAttempts,
        handoffDelivered: this.stats.handoffDelivered,
        handoffCorrect: this.stats.handoffCorrect,
        payloadComplete: this.stats.payloadComplete,
        completionReported: this.stats.completionReported
      }
    }
  }

  worldEventRecords(): readonly Record<string, unknown>[] {
    return this.world.events()
  }

  topologyArtifact(): unknown {
    return this.world.topology
  }
}
