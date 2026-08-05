/**
 * Game 1 — same-room coordinated counting
 * (docs/designs/collaboration-arena.md §10.1 / §3.3).
 *
 * The world injects the starting instruction to the room; routing fans it out
 * to the members' room-scoped sessions. Agents publish candidates as ORDINARY
 * room replies (current-room speech, §3.3); the referee parses candidates from
 * the unified outbound-effect stream and atomically accepts the first valid
 * candidate equal to `current + 1` in `sequence` order.
 *
 * Two variants of what drives the next wave:
 *
 * - `referee-announced` (§10.1's canonical form): the referee relays a
 *   synthesized acceptance event ("Accepted: 1 … Next expected number: 2").
 * - `peer-driven` (§3.3 taken literally): every DELIVERED agent post fans back
 *   to the OTHER members' connections as the production Slack echo
 *   (`PlatformEcho`) — the streaming post under its own message id plus the
 *   response-closing finalize carrying the daemon-stamped authorship claim —
 *   and the referee goes silent after the start message. Since PR #549 an
 *   agent message that names nobody CONTINUES the conversation through the
 *   same arbitration ladder a human message takes (author excluded), so a
 *   peer's bare number genuinely wakes the other agents; the exchange is
 *   bounded by the hop cap (`MAX_AGENT_CALL_HOPS`) and the durable loop guard
 *   rather than by anyone declining to answer.
 *
 * Relay TIMING is production timing: the fan-out fires SYNCHRONOUSLY from the
 * §7.2 sink the moment a post is delivered — while the other agents' turns are
 * still open — never batched to the wave barrier. That is what lets the
 * daemon's own `features.turnFinalContextRefresh` fence work: a concurrent
 * turn's final refresh pulls the thread snapshot (`getThreadReplies` on the
 * virtual connection) plus the observed rows the injected ingress recorded,
 * sees a peer message it has not represented, and REGENERATES instead of
 * posting a now-stale number.
 *
 * Product-fidelity note on the echo sender: each echoed copy carries the
 * posting agent's REAL managed bot identity plus the §4 authorship claim the
 * daemon stamped on the finalized response. Verification remains the line
 * between a participant and anonymous bot traffic: streaming posts and
 * claim-less bot messages still never route — only the finalized event with a
 * verifiable claim reaches the routing ladder.
 *
 * Counting has NO winner or loser. It is a probe of LEADERLESS group
 * self-organization (无领导小组讨论): can a room of agents coordinate
 * turn-taking without a moderator — fill in, avoid duplication, avoid spam,
 * and recognize completion? The result is a collaboration report: did the
 * GROUP complete the count, and with what coordination quality (participation
 * balance, duplication, turn-taking, termination awareness)?
 *
 * Conventions: one accepted occurrence of each number; no skips; no predefined
 * order; waiting is legal. Letting someone else continue after you contributed
 * is a turn-taking convention the group is measured on, never a per-agent
 * score.
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

export type CountingVariant = 'referee-announced' | 'peer-driven'

export interface CountingGameOptions {
  world: ArenaWorld
  /** Alias of the counting room in the compiled topology. */
  roomAlias: string
  target?: number
  /** What drives the next wave (default: the §10.1 referee announcements). */
  variant?: CountingVariant
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
  private readonly candidateStats = {
    total: 0,
    rejected: 0,
    noise: 0,
    consecutiveRejections: 0,
    consecutiveContributions: 0,
    terminationAcks: 0
  }
  private readonly acceptedByAgent = new Map<string, number>()
  private lastContributor: string | undefined
  private expected = 1
  private started = false
  private terminalReason: string | undefined
  private readonly pendingWaves: GameWave[] = []
  private liveIngress?: (event: EvaluationPlatformEvent) => DeliveryHandle
  private readonly liveHandles: DeliveryHandle[] = []
  /** Peer-driven propagation: the production platform echo (§2.3/§5/§6). */
  private readonly echo?: PlatformEcho

  private readonly variant: CountingVariant

  constructor(options: CountingGameOptions) {
    this.world = options.world
    const room = options.world.topology.rooms.find((candidate) => candidate.alias === options.roomAlias)
    if (!room) throw new Error(`counting room "${options.roomAlias}" is not in the compiled topology`)
    this.room = room
    this.target = options.target ?? 12
    this.variant = options.variant ?? 'referee-announced'
    this.refereeUserId = options.refereeUserId ?? 'W-ARENA-REFEREE'
    this.environment = options.world.buildEnvironment()
    this.echo = this.variant === 'peer-driven' ? new PlatformEcho(options.world, room) : undefined
  }

  private roomBroadcast(text: string): GameWave {
    // ONE platform message id shared by every member integration's copy — the
    // same channel:ts each dedicated Slack app receives; per-connection dedup
    // (scoped by transport) must admit each copy exactly once.
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

  /** §8: the runner supplies live ingress so relays enter the daemon the moment
   *  a post lands, not at the wave barrier. */
  attachLiveIngress(inject: (event: EvaluationPlatformEvent) => DeliveryHandle): void {
    this.liveIngress = inject
    // Peer-driven: the platform echo IS the propagation mechanism — whether an
    // echoed post activates anyone is the DAEMON's routing decision, never ours.
    this.echo?.attach(inject)
  }

  /** Handles for echoes injected mid-wave; the runner awaits and drains them. */
  drainLiveHandles(): DeliveryHandle[] {
    if (this.echo) return this.echo.drainHandles()
    const handles = [...this.liveHandles]
    this.liveHandles.length = 0
    return handles
  }

  isTerminal(): boolean {
    return this.terminalReason !== undefined || this.expected > this.target
  }

  nextDeliveries(): GameWave {
    if (!this.started) {
      this.started = true
      if (this.variant === 'peer-driven') {
        return this.roomBroadcast(
          `Let's play the counting game. Together, count from 1 to ${this.target} in this thread by continuing ` +
            `each other's messages. When you see a number posted in this thread, reply with ONLY the next number — ` +
            `nothing else. Do not repeat a number that was already posted. If you posted the most recent number, ` +
            `prefer letting another participant continue, but keep the count moving. Stop once ${this.target} has ` +
            `been posted. No number has been posted yet, so the first reply should be 1. The referee stays silent ` +
            `from now on and only checks the sequence at the end.`
        )
      }
      return this.roomBroadcast(
        `Let's play the counting game. Together, count from 1 to ${this.target} in this thread. ` +
          `Reply with ONLY the next number — nothing else. One number per message; the referee accepts the ` +
          `first valid reply and announces it. No participant may take two numbers in a row; waiting is legal. ` +
          `Next expected number: 1.`
      )
    }
    return this.pendingWaves.shift() ?? { platformEvents: [], refereeEvents: [] }
  }

  drainOutboundEffects(): readonly RecordedOutboundEffect[] {
    return this.world.drainOutboundEffects()
  }

  applyEffects(effects: readonly RecordedOutboundEffect[]): void {
    const deliveredReplies: RecordedOutboundEffect[] = []
    for (const effect of effects) {
      if (effect.kind !== 'reply' || effect.status !== 'delivered') continue
      if (effect.channel !== this.room.channel) continue
      const agentId = effect.agentId
      if (agentId === undefined) continue
      deliveredReplies.push(effect)
      // Post-completion acknowledgments ("8 has already been posted, so the
      // count is complete.") are a POSITIVE coordination signal — the group
      // recognized termination on its own. They are never noise and never
      // duplication.
      if (this.isTerminal() && /complet|already|done|finish/i.test(effect.text)) {
        this.candidateStats.terminationAcks += 1
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
        this.candidateStats.noise += 1
        continue
      }
      const value = Number(match[0])
      this.candidateStats.total += 1
      if (this.isTerminal()) {
        this.recordCandidate(effect, value, false, 'post_completion')
        continue
      }
      if (value !== this.expected) {
        this.recordCandidate(effect, value, false, value < this.expected ? 'stale' : 'wrong_number')
        continue
      }
      if (this.lastContributor === agentId) {
        // Turn-taking convention. Referee-announced mode enforces it at
        // acceptance (the referee announces every acceptance, so the official
        // count stays visible). With a SILENT referee, a hidden rejection would
        // diverge the official count from the room-visible transcript, so the
        // peer-driven variant accepts the contribution and records it as a
        // TURN-TAKING BALANCE observation — a coordination-quality measure,
        // not a rule violation.
        if (this.variant === 'referee-announced') {
          this.candidateStats.consecutiveRejections += 1
          this.recordCandidate(effect, value, false, 'consecutive_scorer')
          continue
        }
        this.candidateStats.consecutiveContributions += 1
      }
      // Atomic acceptance: first valid candidate in `sequence` order wins.
      this.accepted.push({ value, agentId, sequence: effect.sequence })
      this.acceptedByAgent.set(agentId, (this.acceptedByAgent.get(agentId) ?? 0) + 1)
      this.lastContributor = agentId
      this.expected += 1
      this.recordCandidate(effect, value, true)
      if (this.expected > this.target) {
        this.terminalReason = 'completed'
        this.world.appendEvent({
          type: 'game.completed',
          origin: 'world',
          roomId: this.room.alias,
          acceptedPrefix: this.accepted.length,
          target: this.target
        })
      } else if (this.variant === 'referee-announced') {
        this.pendingWaves.push(
          this.roomBroadcast(
            `Accepted: ${value} from ${this.world.aliasOfAgent(agentId)}. Next expected number: ${this.expected}.`
          )
        )
      }
    }
    // Peer-driven echoes are NOT queued here: each was already injected
    // synchronously on delivery (PlatformEcho) so concurrent turns could
    // observe it at their turn-final refresh and regenerate.
    void deliveredReplies
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
      // No-consecutive-scorer is an ACCEPTANCE rule only where the referee
      // announces; peer-driven acceptance follows the visible transcript.
      if (this.variant === 'referee-announced' && index > 0 && this.accepted[index - 1]!.agentId === entry.agentId) {
        refereeConsistent = false
      }
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
    // A collaboration report, not a scoreboard: DID THE GROUP complete the
    // count, plus the coordination-quality measures — who contributed when
    // (turn-taking record), how balanced participation was, how much
    // duplication occurred, and whether the group recognized completion.
    return {
      terminalReason: this.terminalReason ?? (completed ? 'completed' : 'incomplete'),
      refereeConsistent,
      invariants: {
        ...this.world.invariantCounters(),
        privateLeaks: 0
      },
      outcome: {
        completed,
        variant: this.variant,
        acceptedPrefix: this.accepted.length,
        target: this.target,
        /** Turn-taking record: which agent filled each slot, in order. */
        contributionOrder: this.accepted.map((entry) => this.world.aliasOfAgent(entry.agentId)),
        /** Per-agent contribution counts across the whole group. */
        contributions: Object.fromEntries(
          this.room.memberAgentIds.map((memberId) => [
            this.world.aliasOfAgent(memberId),
            this.acceptedByAgent.get(memberId) ?? 0
          ])
        )
      },
      metrics: {
        candidates: this.candidateStats.total,
        /** Duplication: replies that raced an already-filled or wrong slot. */
        collisions: this.candidateStats.rejected,
        /** Digit-free chatter that carried no count signal. */
        noiseReplies: this.candidateStats.noise,
        consecutiveScorerRejections: this.candidateStats.consecutiveRejections,
        /** Turn-taking balance: times one agent filled two slots in a row. */
        consecutiveContributions: this.candidateStats.consecutiveContributions,
        /** Termination awareness: post-completion acknowledgments. */
        terminationAcknowledgments: this.candidateStats.terminationAcks,
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
