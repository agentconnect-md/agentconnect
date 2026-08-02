/**
 * Game 1 — same-room coordinated counting
 * (docs/designs/collaboration-arena.md §10.1).
 *
 * The world injects the starting instruction to the room; routing fans it out
 * to the members' room-scoped sessions. Agents publish candidates as ORDINARY
 * room replies (current-room speech, §3.3); the referee parses candidates from
 * the unified outbound-effect stream, atomically accepts the first valid
 * candidate equal to `current + 1` in `sequence` order, and relays a canonical
 * room event through the real-path ingress (§4.1) — the world, not an agent
 * call chain, relays accepted events.
 *
 * Rules: one accepted occurrence of each number; no skips; no agent scores
 * twice consecutively; no predefined order; waiting is legal.
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
import type { CompiledRoom } from './types.js'

export interface CountingGameOptions {
  world: ArenaWorld
  /** Alias of the counting room in the compiled topology. */
  roomAlias: string
  target?: number
  /** Human persona the referee speaks through on the real ingress path. */
  refereeUserId?: string
}

interface AcceptedCandidate {
  value: number
  agentId: string
  sequence: number
}

export class CountingGame implements CollaborationGameWorld {
  readonly environment: DaemonEvaluationEnvironment
  private readonly world: ArenaWorld
  private readonly room: CompiledRoom
  private readonly target: number
  private readonly refereeUserId: string
  private readonly accepted: AcceptedCandidate[] = []
  private readonly candidateStats = { total: 0, rejected: 0, noise: 0, consecutiveRejections: 0 }
  private readonly acceptedByAgent = new Map<string, number>()
  private lastScorer: string | undefined
  private expected = 1
  private started = false
  private terminalReason: string | undefined
  private readonly pendingWaves: GameWave[] = []

  constructor(options: CountingGameOptions) {
    this.world = options.world
    const room = options.world.topology.rooms.find((candidate) => candidate.alias === options.roomAlias)
    if (!room) throw new Error(`counting room "${options.roomAlias}" is not in the compiled topology`)
    this.room = room
    this.target = options.target ?? 12
    this.refereeUserId = options.refereeUserId ?? 'W-ARENA-REFEREE'
    this.environment = options.world.buildEnvironment()
  }

  private roomBroadcast(text: string): GameWave {
    // ONE platform message id shared by every member integration's copy — the
    // same channel:ts each dedicated Slack app receives; per-connection dedup
    // (scoped by transport) must admit each copy exactly once.
    const messageId = this.world.mintMessageId(this.room.platform)
    this.world.registerRoomMessage(this.room.channel, messageId)
    const platformEvents: EvaluationPlatformEvent[] = this.room.memberIntegrationIds.map((integrationId) => ({
      integrationId,
      payload: {
        channel: this.room.channel,
        thread: this.room.thread,
        messageId,
        text,
        sender: { id: this.refereeUserId, isBot: false }
      }
    }))
    this.world.appendEvent({
      type: 'referee.room_event',
      origin: 'referee',
      roomId: this.room.alias,
      channel: this.room.channel,
      thread: this.room.thread,
      messageId,
      text
    })
    return { platformEvents, refereeEvents: [] }
  }

  isTerminal(): boolean {
    return this.terminalReason !== undefined || this.expected > this.target
  }

  nextDeliveries(): GameWave {
    if (!this.started) {
      this.started = true
      return this.roomBroadcast(
        `Let's play the counting game. Together, count from 1 to ${this.target} in this thread. ` +
          `Reply with ONLY the next number — nothing else. One number per message; the referee accepts the ` +
          `first valid reply and announces it. No participant may score twice in a row; waiting is legal. ` +
          `Next expected number: 1.`
      )
    }
    return this.pendingWaves.shift() ?? { platformEvents: [], refereeEvents: [] }
  }

  drainOutboundEffects(): readonly RecordedOutboundEffect[] {
    return this.world.drainOutboundEffects()
  }

  applyEffects(effects: readonly RecordedOutboundEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== 'reply' || effect.status !== 'delivered') continue
      if (effect.channel !== this.room.channel) continue
      const agentId = effect.agentId
      if (agentId === undefined) continue
      const match = /-?\d+/.exec(effect.text)
      if (!match) {
        this.candidateStats.noise += 1
        continue
      }
      const value = Number(match[0])
      this.candidateStats.total += 1
      if (this.isTerminal()) {
        this.recordCandidate(effect, value, false, 'game_over')
        continue
      }
      if (value !== this.expected) {
        this.recordCandidate(effect, value, false, value < this.expected ? 'stale' : 'wrong_number')
        continue
      }
      if (this.lastScorer === agentId) {
        this.candidateStats.consecutiveRejections += 1
        this.recordCandidate(effect, value, false, 'consecutive_scorer')
        continue
      }
      // Atomic acceptance: first valid candidate in `sequence` order wins.
      this.accepted.push({ value, agentId, sequence: effect.sequence })
      this.acceptedByAgent.set(agentId, (this.acceptedByAgent.get(agentId) ?? 0) + 1)
      this.lastScorer = agentId
      this.expected += 1
      this.recordCandidate(effect, value, true)
      if (this.expected <= this.target) {
        this.pendingWaves.push(
          this.roomBroadcast(
            `Accepted: ${value} from ${this.world.aliasOfAgent(agentId)}. Next expected number: ${this.expected}.`
          )
        )
      } else {
        this.terminalReason = 'completed'
        this.world.appendEvent({
          type: 'game.completed',
          origin: 'world',
          roomId: this.room.alias,
          acceptedPrefix: this.accepted.length,
          target: this.target
        })
      }
    }
  }

  private recordCandidate(effect: RecordedOutboundEffect, value: number, accepted: boolean, reason?: string): void {
    if (!accepted) this.candidateStats.rejected += 1
    this.world.appendEvent({
      type: 'count.candidate',
      origin: 'agent_effect',
      effectSequence: effect.sequence,
      agentId: effect.agentId,
      agentAlias: effect.agentId ? this.world.aliasOfAgent(effect.agentId) : undefined,
      roomId: this.room.alias,
      value,
      accepted,
      ...(reason !== undefined ? { reason } : {})
    })
  }

  noteWave(record: GameWaveRecord): void {
    this.world.appendEvent({
      type: 'wave',
      origin: 'world',
      step: record.step,
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
    const completed = this.accepted.length >= this.target
    // Referee self-check (§9.1): the accepted list must be exactly 1..n with no
    // agent scoring twice consecutively.
    let refereeConsistent = true
    for (const [index, entry] of this.accepted.entries()) {
      if (entry.value !== index + 1) refereeConsistent = false
      if (index > 0 && this.accepted[index - 1]!.agentId === entry.agentId) refereeConsistent = false
      if (index > 0 && this.accepted[index - 1]!.sequence >= entry.sequence) refereeConsistent = false
    }
    // Participation balance as normalized entropy over accepted counts.
    const counts = [...this.acceptedByAgent.values()]
    const total = counts.reduce((sum, count) => sum + count, 0)
    const agents = this.room.memberAgentIds.length
    let entropy = 0
    if (total > 0 && agents > 1) {
      for (const count of counts) {
        if (count === 0) continue
        const p = count / total
        entropy -= p * Math.log2(p)
      }
      entropy /= Math.log2(agents)
    }
    return {
      terminalReason: this.terminalReason ?? (completed ? 'completed' : 'incomplete'),
      refereeConsistent,
      invariants: {
        ...this.world.invariantCounters(),
        privateLeaks: 0
      },
      outcome: {
        completed,
        acceptedPrefix: this.accepted.length,
        target: this.target,
        acceptedBy: this.accepted.map((entry) => this.world.aliasOfAgent(entry.agentId))
      },
      metrics: {
        candidates: this.candidateStats.total,
        collisions: this.candidateStats.rejected,
        noiseReplies: this.candidateStats.noise,
        consecutiveScorerRejections: this.candidateStats.consecutiveRejections,
        participationEntropy: Number(entropy.toFixed(4))
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
