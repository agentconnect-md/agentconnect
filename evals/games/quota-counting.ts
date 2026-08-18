/**
 * Quota counting — a leaderless turn-taking probe with a REAL endgame hazard.
 *
 * Rules (stated once by the referee, then silence): count upward from 1;
 * each participant must post exactly `quotaPerAgent` numbers in total; no one
 * may post twice in a row — someone else must post before you may post again;
 * the count ends at `quotaPerAgent × members` when everyone has posted their
 * quota.
 *
 * Like peer-driven counting (§3.3), propagation is entirely peer fan-out:
 * every delivered agent post fans back to the other members' connections as
 * the production Slack echo (`PlatformEcho`) with the daemon-stamped
 * authorship claim, so a finalized bare number CONTINUES the conversation
 * through the ordinary arbitration ladder (PR #549) and in-flight turns
 * absorb peer posts via the daemon's own context fences. There is NO winner and NO enforcement:
 * the world only observes — an agent CAN overpost or post consecutively, and
 * the group CAN maneuver itself into the variant's characteristic deadlock
 * (one agent left holding ≥2 of the remaining posts once everyone else has
 * exhausted their quota — with no one left to interleave, the count cannot
 * finish). The validator classifies the outcome; it never prevents it.
 */
import type {
  CollaborationGameWorld,
  DaemonEvaluationEnvironment,
  DeliveryHandle,
  EvaluationPlatformEvent,
  GameVerdict,
  GameWave,
  GameWaveRecord,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import { PlatformEcho } from './platform-echo.js'
import type { ArenaWorld } from './world.js'
import type { CompiledRoom } from './types.js'

export interface QuotaCountingGameOptions {
  world: ArenaWorld
  roomAlias: string
  /** Posts each participant must contribute (default 5). */
  quotaPerAgent?: number
  refereeUserId?: string
}

interface Contribution {
  value: number
  agentId: string
  sequence: number
  /** Turn-taking violation: same poster as the previous accepted number. */
  consecutive: boolean
  /** Quota violation: this agent had already posted its full quota. */
  overQuota: boolean
}

export class QuotaCountingGame implements CollaborationGameWorld {
  readonly environment: DaemonEvaluationEnvironment
  private readonly world: ArenaWorld
  private readonly room: CompiledRoom
  private readonly quota: number
  private readonly target: number
  private readonly refereeUserId: string
  private readonly accepted: Contribution[] = []
  private readonly contributionsByAgent = new Map<string, number>()
  private readonly stats = {
    candidates: 0,
    collisions: 0,
    noise: 0,
    consecutiveViolations: 0,
    overQuotaContributions: 0,
    terminationAcks: 0
  }
  private lastContributor: string | undefined
  private expected = 1
  private started = false
  private terminalReason: string | undefined
  private readonly pendingWaves: GameWave[] = []
  private liveIngress?: (event: EvaluationPlatformEvent) => DeliveryHandle | Promise<DeliveryHandle>
  private readonly liveHandles: DeliveryHandle[] = []
  /** Propagation: the production platform echo (§2.3/§5/§6). */
  private readonly echo: PlatformEcho

  constructor(options: QuotaCountingGameOptions) {
    this.world = options.world
    const room = options.world.topology.rooms.find((candidate) => candidate.alias === options.roomAlias)
    if (!room) throw new Error(`quota counting room "${options.roomAlias}" is not in the compiled topology`)
    this.room = room
    this.quota = options.quotaPerAgent ?? 5
    if (this.quota < 1) throw new Error('quotaPerAgent must be at least 1')
    this.target = this.quota * room.memberAgentIds.length
    this.refereeUserId = options.refereeUserId ?? 'W-ARENA-REFEREE'
    this.environment = options.world.buildEnvironment()
    this.echo = new PlatformEcho(options.world, room)
    for (const memberId of room.memberAgentIds) this.contributionsByAgent.set(memberId, 0)
  }

  private memberAliases(): string[] {
    return this.room.memberAgentIds.map((agentId) => this.world.aliasOfAgent(agentId))
  }

  private roomBroadcast(text: string): GameWave {
    const messageId = this.world.mintMessageId(this.room.platform)
    this.world.registerRoomMessage(this.room.channel, messageId)
    this.world.recordThreadMessage(this.room.channel, this.room.thread, {
      ts: messageId,
      text,
      sender: this.refereeUserId,
      isBot: false
    })
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

  attachLiveIngress(inject: (event: EvaluationPlatformEvent) => DeliveryHandle | Promise<DeliveryHandle>): void {
    this.liveIngress = inject
    // The platform echo IS the propagation mechanism — whether an echoed post
    // activates anyone is the DAEMON's routing decision, never ours.
    this.echo.attach(inject)
  }

  drainLiveHandles(): Promise<DeliveryHandle>[] {
    return this.echo.drainHandles()
  }

  isTerminal(): boolean {
    return this.terminalReason !== undefined || this.expected > this.target
  }

  nextDeliveries(): GameWave {
    if (!this.started) {
      this.started = true
      return this.roomBroadcast(
        `Let's play quota counting. Participants: ${this.memberAliases().join(', ')}. ` +
          `Count upward from 1 in this thread by continuing each other's messages — reply with ONLY the next ` +
          `number, nothing else. Each participant must post exactly ${this.quota} numbers in total. You cannot ` +
          `post twice in a row — someone else must post before you may post again. The count ends at ` +
          `${this.target}, when everyone has posted ${this.quota}. Plan your turns so nobody is left holding ` +
          `posts no one can interleave. No number has been posted yet, so the first reply should be 1. The ` +
          `referee stays silent from now on and only reviews the sequence at the end.`
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
      // Post-completion acknowledgments are termination awareness, never noise.
      if (this.isTerminal() && /complet|already|done|finish/i.test(effect.text)) {
        this.stats.terminationAcks += 1
        this.world.appendEvent({
          type: 'count.termination_ack',
          origin: 'agent_effect',
          effectSequence: effect.sequence,
          agentAlias: this.world.aliasOfAgent(agentId),
          roomId: this.room.alias,
          text: effect.text
        })
        continue
      }
      const match = /-?\d+/.exec(effect.text)
      if (!match) {
        this.stats.noise += 1
        continue
      }
      const value = Number(match[0])
      this.stats.candidates += 1
      const record = (accepted: boolean, reason?: string, flags?: { consecutive: boolean; overQuota: boolean }) => {
        if (!accepted) this.stats.collisions += 1
        this.world.appendEvent({
          type: 'count.candidate',
          origin: 'agent_effect',
          effectSequence: effect.sequence,
          agentId,
          agentAlias: this.world.aliasOfAgent(agentId),
          roomId: this.room.alias,
          value,
          accepted,
          ...(reason !== undefined ? { reason } : {}),
          ...(flags?.consecutive ? { consecutiveViolation: true } : {}),
          ...(flags?.overQuota ? { overQuota: true } : {})
        })
      }
      if (this.isTerminal()) {
        record(false, 'post_completion')
        continue
      }
      if (value !== this.expected) {
        record(false, value < this.expected ? 'stale' : 'wrong_number')
        continue
      }
      // Accepted — the visible transcript is ground truth. Violations are
      // OBSERVED, never prevented: the group is being measured, not policed.
      const consecutive = this.lastContributor === agentId
      const overQuota = (this.contributionsByAgent.get(agentId) ?? 0) >= this.quota
      if (consecutive) this.stats.consecutiveViolations += 1
      if (overQuota) this.stats.overQuotaContributions += 1
      this.accepted.push({ value, agentId, sequence: effect.sequence, consecutive, overQuota })
      this.contributionsByAgent.set(agentId, (this.contributionsByAgent.get(agentId) ?? 0) + 1)
      this.lastContributor = agentId
      this.expected += 1
      record(true, undefined, { consecutive, overQuota })
      if (this.expected > this.target) {
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
    const sequenceComplete = this.accepted.length >= this.target
    const remainingQuota = Object.fromEntries(
      this.room.memberAgentIds.map((memberId) => [
        this.world.aliasOfAgent(memberId),
        Math.max(0, this.quota - (this.contributionsByAgent.get(memberId) ?? 0))
      ])
    )
    const quotaExact = this.room.memberAgentIds.every(
      (memberId) => (this.contributionsByAgent.get(memberId) ?? 0) === this.quota
    )
    // Group completion requires ALL THREE: correct 1..target sequence, exact
    // quotas, and no consecutive-poster violation along the way.
    const completed = sequenceComplete && quotaExact && this.stats.consecutiveViolations === 0
    // The variant's endgame hazard: once every other participant has exhausted
    // its quota, a single agent holding remaining posts cannot interleave with
    // anyone — the count can never finish. (One remaining post is deadlocked
    // only when its holder also posted last.)
    const unfinished = this.room.memberAgentIds.filter(
      (memberId) => (this.contributionsByAgent.get(memberId) ?? 0) < this.quota
    )
    const deadlocked =
      !sequenceComplete &&
      unfinished.length === 1 &&
      ((this.quota - (this.contributionsByAgent.get(unfinished[0]!) ?? 0) >= 2 &&
        this.room.memberAgentIds.length > 1) ||
        unfinished[0] === (this.accepted.at(-1)?.agentId ?? undefined))
    const endgame = sequenceComplete
      ? completed
        ? 'completed-clean'
        : 'completed-with-violations'
      : deadlocked
        ? 'deadlocked'
        : 'stalled'
    let refereeConsistent = true
    for (const [index, entry] of this.accepted.entries()) {
      if (entry.value !== index + 1) refereeConsistent = false
      if (index > 0 && this.accepted[index - 1]!.sequence >= entry.sequence) refereeConsistent = false
    }
    const counts = [...this.contributionsByAgent.values()]
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
    // A collaboration report: did the GROUP satisfy its own constraints, and
    // how well did it manage the endgame — never a per-agent scoreboard.
    return {
      terminalReason:
        this.terminalReason === 'stalled' && deadlocked ? 'deadlocked' : (this.terminalReason ?? 'incomplete'),
      refereeConsistent,
      invariants: {
        ...this.world.invariantCounters(),
        privateLeaks: 0
      },
      outcome: {
        completed,
        variant: 'quota',
        quotaPerAgent: this.quota,
        target: this.target,
        acceptedPrefix: this.accepted.length,
        endgame,
        deadlocked,
        /** Turn-taking record: which agent filled each slot, in order. */
        contributionOrder: this.accepted.map((entry) => this.world.aliasOfAgent(entry.agentId)),
        contributions: Object.fromEntries(
          this.room.memberAgentIds.map((memberId) => [
            this.world.aliasOfAgent(memberId),
            this.contributionsByAgent.get(memberId) ?? 0
          ])
        ),
        remainingQuota
      },
      metrics: {
        candidates: this.stats.candidates,
        collisions: this.stats.collisions,
        noiseReplies: this.stats.noise,
        /** Turn-taking violations the group allowed (observed, not policed). */
        consecutivePostViolations: this.stats.consecutiveViolations,
        overQuotaContributions: this.stats.overQuotaContributions,
        terminationAcknowledgments: this.stats.terminationAcks,
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
