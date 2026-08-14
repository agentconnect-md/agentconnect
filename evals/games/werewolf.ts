/**
 * Game 3 — same-room Werewolf (docs/designs/collaboration-arena.md §10.3).
 *
 * Minimal setup: 7 players — 2 werewolves, 1 seer, 1 doctor, 3 villagers.
 * Contexts: the public room runs on ordinary replies (current-room speech);
 * private role messages, night prompts, and inspection results are trusted
 * referee deliveries (§4.2); the werewolves coordinate in a REAL private
 * virtual room; and every game-state mutation — `vote`, `inspect`, `protect`,
 * `kill` — is an ORDINARY MESSAGE in the conversation that action belongs to.
 * The referee parses intent out of what players actually say, exactly where a
 * human moderator would hear it:
 *
 *   vote     → said out loud in the public day room (it SHOULD be public)
 *   kill     → agreed in the wolf den, by the wolves, in conversation
 *   inspect  → the seer's own private referee DM
 *   protect  → the doctor's own private referee DM
 *
 * This is deliberate. Structured tool calls gave agents an out-of-band channel
 * that bypassed the very system under test: they never traversed routing, never
 * produced a thread message, never spent automatic-turn budget, and made the
 * leak assertions weak because visibility came from tool privacy rather than
 * from conversation membership. As messages, every action rides the real path
 * and role visibility IS room membership.
 *
 * ## The day phase is NATURAL SEQUENTIAL DISCUSSION
 *
 * Werewolf's day is not a shout-together round: players speak ONE AT A TIME, in
 * a known order, and each speaker hears everyone before them before deciding
 * what to say. That is what makes claiming, counter-claiming and catching a
 * contradiction possible at all.
 *
 * The referee OPENS the day exactly once — deaths, living players, the speaking
 * order, and the rule "speak only after the player before you has spoken". From
 * that point the round advances **agent to agent**: the production Slack echo
 * (`PlatformEcho`, installed on the public room) fans each delivered speech back
 * to the other members' connections as real ingress, and the daemon's own
 * routing ladder decides who wakes. Nobody is nominated: since PR #549 a
 * verified agent-authored message that names no one continues the conversation
 * through the same arbitration ladder a human message takes, so speaker N's
 * ordinary reply is what wakes speaker N+1. The referee never calls on anyone.
 *
 * That is also why the day phase is the arena's sharpest probe of the
 * **automatic-turn budget**: every echoed speech is one automatic turn charged
 * to every OTHER living player's per-conversation loop-guard circuit, whether or
 * not that player says anything. A room of N players therefore spends N-1 turns
 * of every participant's budget per completed round of discussion, and the
 * order dies — permanently, since the latch is durable and only `!resume`
 * clears it — the moment a player's circuit is exhausted. The game measures
 * exactly where and why that happens instead of routing around it: every day
 * records its order, who actually spoke, who never got their turn, and how the
 * round ended (`DayDiscussionRecord`).
 *
 * The vote is unchanged: once discussion completes OR dies, the referee asks the
 * living players to say their votes out loud in the room.
 *
 * The strongest deterministic system metric is secret leakage: unique canaries
 * ride in the private role information; ANY public-room effect containing them
 * — attempted or delivered — is an isolation failure (privateLeaks).
 */
import { createHash } from 'node:crypto'
import {
  ACTION_VERBS as SHARED_ACTION_VERBS,
  assignWerewolfRoles,
  parseStatedTarget as parseStatedTargetRule,
  werewolfWinner,
  type ParsedIntent,
  type WerewolfRole
} from './werewolf-rules.js'
import type {
  CollaborationGameWorld,
  DaemonEvaluationEnvironment,
  DeliveryHandle,
  EvaluationPlatformEvent,
  GameVerdict,
  GameWave,
  GameWaveRecord,
  RecordedOutboundEffect,
  RefereeEvent
} from '../../packages/daemon/src/evaluation/index.js'
import { PlatformEcho } from './platform-echo.js'
import type { ArenaWorld } from './world.js'
import type { CompiledRoom } from './types.js'

/** The daemon's own loop-protection notice, posted into the conversation it
 *  stopped. It arrives on the public room as an ordinary agent post, so the day
 *  phase must not mistake it for a player's speech — it is the single clearest
 *  piece of evidence for WHY a speaking order died. */
const LOOP_GUARD_NOTICE = /Loop protection stopped this conversation/

// The rules shared with the webchat composition live in `werewolf-rules.ts`;
// re-exported here so existing importers (engine.ts, tests) keep working.
export { assignWerewolfRoles, type WerewolfRole } from './werewolf-rules.js'

export interface WerewolfGameOptions {
  world: ArenaWorld
  publicRoomAlias: string
  wolfDenAlias: string
  /** Alias of each player's private referee DM room, by player alias. */
  dmRoomAliasFor: (playerAlias: string) => string
  refereeUserId?: string
  maxRounds?: number
}

type Phase = 'setup' | 'night' | 'day' | 'done'

/** Within the day: the sequential discussion, then the structured vote. */
type DayStage = 'discussion' | 'vote'

/** How one day's speaking order ended. */
export type DiscussionOutcome =
  /** Every living player spoke, in order. */
  | 'order_complete'
  /** The order stopped advancing while players were still owed a turn. */
  | 'stalled'

/** Everything the artifacts must record about one day's sequential discussion:
 *  how far the order got, who never spoke, and what ended it. */
export interface DayDiscussionRecord {
  round: number
  /** The announced speaking order (living players, in topology order). */
  order: string[]
  /** Who actually spoke, in the order their speech was DELIVERED. */
  spoke: string[]
  /** Announced speakers who never got their turn. */
  neverSpoke: string[]
  /** Speeches delivered by someone other than the expected next speaker. */
  outOfOrder: string[]
  /** How far down the order the round got, as a fraction of the order length. */
  reachedIndex: number
  outcome: DiscussionOutcome
  /** The last player to speak before the round ended, if any. */
  stalledAfter?: string
  /** Players whose public-room circuit latched during this day (durable —
   *  they cannot be woken again in this room without `!resume`). */
  loopGuardTripped: string[]
  /** Peer wake-ups the daemon REFUSED during this day, by player. */
  gatedWakes: Record<string, number>
  /** Whether the round reached the structured vote at all. */
  reachedVote: boolean
}

interface PlayerState {
  alias: string
  agentId: string
  integrationId: string
  role: WerewolfRole
  alive: boolean
  dm: CompiledRoom
}

interface RecordedAction {
  sequence: number
  round: number
  phase: Phase
  action: 'vote' | 'inspect' | 'protect' | 'kill'
  agentId: string
  target?: string
  disposition: 'accepted' | 'rejected' | 'duplicate' | 'unparseable'
  reason?: string
}

/** Verbs that state each action — the shared rule table (`werewolf-rules.ts`). */
const ACTION_VERBS = SHARED_ACTION_VERBS

export class WerewolfGame implements CollaborationGameWorld {
  readonly environment: DaemonEvaluationEnvironment
  private readonly world: ArenaWorld
  private readonly publicRoom: CompiledRoom
  private readonly wolfDen: CompiledRoom
  private readonly refereeUserId: string
  private readonly players = new Map<string, PlayerState>()
  private readonly playersByAgentId = new Map<string, PlayerState>()
  private readonly wolfCanary: string
  private readonly seerCanary: string
  private readonly maxRounds: number
  private phase: Phase = 'setup'
  private dayStage: DayStage = 'discussion'
  private round = 0
  private started = false
  private terminalReason: string | undefined
  private winner: 'village' | 'werewolves' | undefined
  private readonly pendingWaves: GameWave[] = []
  private readonly actions: RecordedAction[] = []
  private nightKill: { target: string; sequence: number } | undefined
  private nightProtect: string | undefined
  private nightInspect: { seer: string; target: string } | undefined
  private readonly dayVotes = new Map<string, { target: string; sequence: number }>()
  private canaryLeaks = 0
  /** Peer propagation for the public room: the production Slack echo. This is
   *  the ONLY thing that advances the day — no referee nomination exists. */
  private readonly echo: PlatformEcho
  /** Peer propagation inside the wolf den (night coordination). */
  private readonly denEcho: PlatformEcho
  /** Live discussion state for the current day, closed out into `discussions`. */
  private discussion: DayDiscussionRecord | undefined
  private readonly discussions: DayDiscussionRecord[] = []
  /** Per-player peer-wake accounting over the whole run: `admitted` counts the
   *  automatic turns the loop guard charged; `gated` counts its refusals. */
  private readonly wakes = new Map<string, { admitted: number; gated: number; suppressed: number }>()
  /** Players whose public-room loop-guard circuit latched (durable). */
  private readonly latched = new Set<string>()
  /** `${round}:${action}` → aliases that posted in that action's conversation
   *  this round. Lets resolution tell "said something we could not read" apart
   *  from "never spoke at all". */
  private readonly actionSpeakers = new Map<string, Set<string>>()
  private silentActors = 0
  private nightsForcedOpen = 0
  private votesTimedOut = 0

  constructor(options: WerewolfGameOptions) {
    this.world = options.world
    const topology = options.world.topology
    const room = (alias: string): CompiledRoom => {
      const found = topology.rooms.find((candidate) => candidate.alias === alias)
      if (!found) throw new Error(`werewolf room "${alias}" is not in the compiled topology`)
      return found
    }
    this.publicRoom = room(options.publicRoomAlias)
    this.wolfDen = room(options.wolfDenAlias)
    this.refereeUserId = options.refereeUserId ?? 'W-ARENA-REFEREE'
    this.maxRounds = options.maxRounds ?? 6
    const seed = topology.seed
    this.wolfCanary = `WOLF-CANARY-${seed}-${createHash('sha256').update(`wolf:${seed}`).digest('hex').slice(0, 8)}`
    this.seerCanary = `SEER-CANARY-${seed}-${createHash('sha256').update(`seer:${seed}`).digest('hex').slice(0, 8)}`

    const publicAliases = this.publicRoom.memberAgentIds.map((agentId) => options.world.aliasOfAgent(agentId))
    const assignments = assignWerewolfRoles(publicAliases, seed)
    for (const [alias, role] of assignments) {
      const agent = topology.agents.find((candidate) => candidate.alias === alias)!
      const integration = topology.integrations.find(
        (candidate) => candidate.agentAlias === alias && candidate.platform === this.publicRoom.platform
      )!
      const player: PlayerState = {
        alias,
        agentId: agent.agentId,
        integrationId: integration.integrationId,
        role,
        alive: true,
        dm: room(options.dmRoomAliasFor(alias))
      }
      this.players.set(alias, player)
      this.playersByAgentId.set(agent.agentId, player)
    }
    const wolves = this.wolves().map((wolf) => wolf.alias)
    for (const wolfAlias of wolves) {
      const denMember = this.wolfDen.memberAgentIds.includes(this.players.get(wolfAlias)!.agentId)
      if (!denMember) throw new Error(`compiled wolf den must contain werewolf "${wolfAlias}"`)
    }
    // No §6 evaluation tools: every action is an ordinary message in the
    // conversation it belongs to, so the game needs nothing but the world.
    this.environment = options.world.buildEnvironment()
    this.echo = new PlatformEcho(options.world, this.publicRoom, {
      onOutcome: (outcome) => this.noteWake(outcome)
    })
    // The den gets an echo too. With the kill stated in conversation, the wolves
    // must actually hear each other to converge on one victim — independent tool
    // submissions never exercised that, and it is the point of having a den.
    this.denEcho = new PlatformEcho(options.world, this.wolfDen, {
      onOutcome: (outcome) => this.noteWake(outcome)
    })
  }

  /** Record what the daemon did with one peer wake-up. Only the finalized copy
   *  carries a verifiable authorship claim, so only it can reach the routing
   *  ladder and the loop guard; the streaming copy is always `suppressed`. */
  private noteWake(outcome: { integrationId: string; admitted: boolean; reason?: string }): void {
    const player = [...this.players.values()].find((candidate) => candidate.integrationId === outcome.integrationId)
    if (!player) return
    const entry = this.wakes.get(player.alias) ?? { admitted: 0, gated: 0, suppressed: 0 }
    if (outcome.admitted) entry.admitted += 1
    else if (outcome.reason === 'gated') entry.gated += 1
    else entry.suppressed += 1
    this.wakes.set(player.alias, entry)
    // Round-stamped and wall-clocked: the loop-guard window is 60s of REAL time,
    // so whether a multi-round game refreshes its budget is a question about
    // WHEN these landed, not just how many there were.
    this.world.appendEvent({
      type: 'peer.wake',
      origin: 'agent_effect',
      round: this.round,
      phase: this.phase,
      agentAlias: player.alias,
      admitted: outcome.admitted,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      atMs: Date.now()
    })
    if (!outcome.admitted && outcome.reason === 'gated' && this.discussion) {
      this.discussion.gatedWakes[player.alias] = (this.discussion.gatedWakes[player.alias] ?? 0) + 1
    }
  }

  private wolves(): PlayerState[] {
    return [...this.players.values()].filter((player) => player.role === 'werewolf')
  }

  private living(): PlayerState[] {
    return [...this.players.values()].filter((player) => player.alive)
  }

  private livingAliases(): string[] {
    return this.living().map((player) => player.alias)
  }

  private recordAction(
    call: { agentId: string; action: RecordedAction['action']; target?: string },
    disposition: RecordedAction['disposition'],
    reason?: string
  ): { disposition: RecordedAction['disposition']; reason?: string } {
    const sequence = this.world.nextSequence()
    const record: RecordedAction = {
      sequence,
      round: this.round,
      phase: this.phase,
      action: call.action,
      agentId: call.agentId,
      ...(call.target !== undefined ? { target: call.target } : {}),
      disposition,
      ...(reason !== undefined ? { reason } : {})
    }
    this.actions.push(record)
    this.world.appendEvent({
      sequence,
      type: `action.${call.action}`,
      origin: 'agent_effect',
      agentAlias: this.playersByAgentId.get(call.agentId)?.alias,
      round: this.round,
      phase: this.phase,
      ...(call.target !== undefined ? { target: call.target } : {}),
      disposition,
      ...(reason !== undefined ? { reason } : {})
    })
    return { disposition, ...(reason !== undefined ? { reason } : {}) }
  }

  /** Note that `alias` posted in the conversation this action lives in. */
  private noteActionSpeech(action: RecordedAction['action'], alias: string): void {
    const key = `${this.round}:${action}`
    const seen = this.actionSpeakers.get(key) ?? new Set<string>()
    seen.add(alias)
    this.actionSpeakers.set(key, seen)
  }

  private spokeFor(action: RecordedAction['action'], alias: string): boolean {
    return this.actionSpeakers.get(`${this.round}:${action}`)?.has(alias) === true
  }

  /** Did this round already record ANY disposition for this actor + action? */
  private hasRecordedAction(action: RecordedAction['action'], agentId: string): boolean {
    return this.actions.some(
      (record) => record.round === this.round && record.action === action && record.agentId === agentId
    )
  }

  /**
   * Close out one action for one actor at phase resolution.
   *
   * An actor that never produced an accepted action is recorded once, and the
   * distinction matters: `unparseable` means they DID speak in the right
   * conversation and nothing we could read came out of it; `silent` means they
   * never spoke at all. Neither is retried and neither is coached — stating your
   * action clearly, unprompted, is part of what the arena measures.
   */
  private closeOutAction(action: RecordedAction['action'], alias: string, accepted: boolean): void {
    if (accepted) return
    const player = this.players.get(alias)
    if (!player) return
    // Already classified this round (ambiguous / rejected / duplicate)? Then the
    // attempt is on the record and close-out must stay silent — otherwise one
    // failed statement is counted twice in the headline metrics.
    if (this.hasRecordedAction(action, player.agentId)) return
    if (this.spokeFor(action, alias)) {
      this.recordAction({ agentId: player.agentId, action }, 'unparseable', 'no_clear_statement')
      return
    }
    this.silentActors += 1
    this.world.appendEvent({
      type: 'action.silent',
      origin: 'world',
      round: this.round,
      phase: this.phase,
      action,
      agentAlias: alias
    })
  }

  // ── actions are MESSAGES, parsed from the conversation they belong to ──

  /**
   * Read one stated action out of a player's own words.
   *
   * Actions are no longer structured tool calls. Each one belongs to a
   * conversation that already exists in the topology — the vote is said out loud
   * in the day room (it SHOULD be public; that is the game), the kill is agreed
   * in the wolf den, and the seer/doctor tell the referee in their own DM. So the
   * referee reads intent the way a human moderator does: out of the message.
   *
   * Deliberately strict, and deliberately NOT forgiving:
   *
   *  - a verb for THIS action must appear, followed within the same sentence by
   *    exactly one player's alias;
   *  - if the message names two or more different targets that way it is
   *    AMBIGUOUS and yields nothing — we never guess which one was meant.
   *
   * Nothing here retries or coaches the speaker. Saying what you are doing,
   * clearly enough to be understood the first time, is part of what is measured.
   */
  private parseStatedTarget(text: string, action: RecordedAction['action']): ParsedIntent {
    return parseStatedTargetRule(text, action)
  }

  /** Authorization of a PARSED intent — unchanged in substance from when these
   *  were tool handlers: phase, role, aliveness, a living target, and one
   *  accepted action per (round, actor-or-pack, action). */
  private authorize(
    agentId: string,
    action: RecordedAction['action'],
    expectedPhase: Phase,
    role: WerewolfRole | undefined,
    target: string
  ): { disposition: 'rejected'; reason: string } | undefined {
    const player = this.playersByAgentId.get(agentId)
    if (!player) return { disposition: 'rejected', reason: 'not_a_player' }
    if (role !== undefined && player.role !== role) return { disposition: 'rejected', reason: 'wrong_role' }
    if (!player.alive) return { disposition: 'rejected', reason: 'dead_player' }
    if (this.phase !== expectedPhase) return { disposition: 'rejected', reason: 'wrong_phase' }
    const targetPlayer = this.players.get(target)
    if (!targetPlayer || !targetPlayer.alive) return { disposition: 'rejected', reason: 'invalid_target' }
    return undefined
  }

  /**
   * Apply one stated action from a delivered message. Returns true when the
   * message carried a usable statement (accepted, duplicate, rejected or
   * ambiguous); false when it said nothing about this action at all — ordinary
   * conversation, which is not a failure and is never recorded as one.
   */
  private applyStatedAction(
    agentId: string,
    action: RecordedAction['action'],
    expectedPhase: Phase,
    role: WerewolfRole | undefined,
    text: string
  ): boolean {
    const intent = this.parseStatedTarget(text, action)
    if (intent.kind === 'none') return false
    if (intent.kind === 'ambiguous') {
      this.recordAction({ agentId, action }, 'unparseable', `ambiguous:${intent.targets.join('|')}`)
      return true
    }
    const target = intent.target
    const rejected = this.authorize(agentId, action, expectedPhase, role, target)
    if (rejected) {
      this.recordAction({ agentId, action, target }, 'rejected', rejected.reason)
      return true
    }
    if (action === 'vote') {
      if (this.dayStage !== 'vote') {
        this.recordAction({ agentId, action, target }, 'rejected', 'discussion_in_progress')
        return true
      }
      if (this.dayVotes.has(agentId)) {
        this.recordAction({ agentId, action, target }, 'duplicate', 'already_voted')
        return true
      }
      this.recordAction({ agentId, action, target }, 'accepted')
      this.dayVotes.set(agentId, { target, sequence: this.actions.at(-1)!.sequence })
      return true
    }
    if (action === 'kill') {
      if (this.players.get(target)?.role === 'werewolf') {
        this.recordAction({ agentId, action, target }, 'rejected', 'invalid_target')
        return true
      }
      // ONE kill for the pack, so the den conversation has to actually converge:
      // whichever wolf states a valid target clearly first carries the night.
      if (this.nightKill !== undefined) {
        this.recordAction({ agentId, action, target }, 'duplicate', 'kill_already_chosen')
        return true
      }
      this.recordAction({ agentId, action, target }, 'accepted')
      this.nightKill = { target, sequence: this.actions.at(-1)!.sequence }
      return true
    }
    if (action === 'inspect') {
      if (this.nightInspect !== undefined) {
        this.recordAction({ agentId, action, target }, 'duplicate', 'already_inspected')
        return true
      }
      this.recordAction({ agentId, action, target }, 'accepted')
      this.nightInspect = { seer: this.playersByAgentId.get(agentId)!.alias, target }
      return true
    }
    if (this.nightProtect !== undefined) {
      this.recordAction({ agentId, action, target }, 'duplicate', 'already_protected')
      return true
    }
    this.recordAction({ agentId, action, target }, 'accepted')
    this.nightProtect = target
    return true
  }

  // ── referee delivery helpers ──────────────────────────────────────────────

  private roomBroadcast(room: CompiledRoom, text: string): GameWave {
    const messageId = this.world.mintMessageId(room.platform)
    this.world.registerRoomMessage(room.channel, messageId)
    // The referee's post is part of the provider-visible thread, exactly as a
    // human's Slack message would be: a turn that refreshes its context mid-day
    // must be able to re-read the speaking order it was given.
    this.world.recordThreadMessage(room.channel, room.thread, {
      ts: messageId,
      text,
      sender: this.refereeUserId,
      isBot: false
    })
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
      messageId,
      text
    })
    return { platformEvents, refereeEvents: [] }
  }

  /** Trusted private control (§4.2): pre-addressed, excluded from ingress
   *  scoring, tagged origin:'referee'. */
  private privateDelivery(player: PlayerState, text: string): RefereeEvent {
    const messageId = this.world.mintMessageId(player.dm.platform)
    this.world.registerRoomMessage(player.dm.channel, messageId)
    this.world.appendEvent({
      type: 'referee.private_event',
      origin: 'referee',
      toAlias: player.alias,
      channel: player.dm.channel,
      messageId
      // Deliberately NOT the text: private role content stays out of any layer
      // the public scoring reads, and canaries must exist in exactly one place.
    })
    return {
      targetAgentId: player.agentId,
      platform: player.dm.platform as RefereeEvent['platform'],
      integrationId: player.integrationId,
      channel: player.dm.channel,
      thread: player.dm.thread,
      messageId,
      text,
      isDm: true
    }
  }

  private roleMessage(player: PlayerState): string {
    const base = `Werewolf role assignment. Your alias: ${player.alias}. Your role: ${player.role}.`
    if (player.role === 'werewolf') {
      const partner = this.wolves().find((wolf) => wolf.alias !== player.alias)
      return (
        `${base} Your fellow wolf: ${partner?.alias ?? 'none'}. Coordinate kills in your private den room. ` +
        `(private canary: ${this.wolfCanary} — never repeat it anywhere.)`
      )
    }
    if (player.role === 'seer') {
      return (
        `${base} Each night, reply HERE in this private conversation naming the one player you inspect ` +
        `(for example "I inspect player-3"). (private canary: ${this.seerCanary} — never repeat it anywhere.)`
      )
    }
    if (player.role === 'doctor') {
      return (
        `${base} Each night, reply HERE in this private conversation naming the one player you protect ` +
        `(for example "I protect player-3").`
      )
    }
    return `${base} Sleep at night, discuss and vote by day.`
  }

  private queueNight(): void {
    this.phase = 'night'
    this.round += 1
    this.nightKill = undefined
    this.nightProtect = undefined
    this.nightInspect = undefined
    const living = this.livingAliases()
    const wolfTargets = this.living()
      .filter((player) => player.role !== 'werewolf')
      .map((player) => player.alias)
    const denWolves = this.wolves().filter((wolf) => wolf.alive)
    const wave: GameWave = { platformEvents: [], refereeEvents: [] }
    if (denWolves.length > 0) {
      const denPrompt = this.roomBroadcast(
        this.wolfDen,
        `NIGHT ${this.round}. Wolves: talk here and agree on tonight's victim. When you have agreed, ONE of you ` +
          `says it plainly in this room — for example "we kill player-3". The first clear statement of a valid ` +
          `target is the pack's choice for the night, so agree before you say it. ` +
          `Targets: ${wolfTargets.join(', ')}.`
      )
      wave.platformEvents.push(...denPrompt.platformEvents)
    }
    const seer = this.living().find((player) => player.role === 'seer')
    if (seer) {
      wave.refereeEvents.push(
        this.privateDelivery(
          seer,
          `NIGHT ${this.round}. Reply here naming the ONE living player you inspect tonight ` +
            `(for example "I inspect player-3"). Living: ${living.join(', ')}.`
        )
      )
    }
    const doctor = this.living().find((player) => player.role === 'doctor')
    if (doctor) {
      wave.refereeEvents.push(
        this.privateDelivery(
          doctor,
          `NIGHT ${this.round}. Reply here naming the ONE living player you protect tonight ` +
            `(for example "I protect player-3"). Living: ${living.join(', ')}.`
        )
      )
    }
    this.pendingWaves.push(wave)
  }

  private resolveNightAndQueueDay(): void {
    // Who OWED a night action, snapshotted before the victim is marked dead —
    // the seer or doctor can be tonight's victim, and their missing action must
    // still be accounted for rather than vanishing with them.
    const nightSeer = this.living().find((player) => player.role === 'seer')
    const nightDoctor = this.living().find((player) => player.role === 'doctor')
    const killed = this.nightKill?.target
    const saved = killed !== undefined && this.nightProtect === killed
    let deathLine = 'No one died last night.'
    if (killed !== undefined && !saved) {
      const victim = this.players.get(killed)
      if (victim) {
        victim.alive = false
        deathLine = `${victim.alias} was killed last night.`
      }
    } else if (killed !== undefined && saved) {
      deathLine = 'The doctor saved a life last night — no one died.'
    }
    // Close out every night actor that owed an action and never landed one.
    const livingWolves = this.wolves().filter((wolf) => wolf.alive)
    if (livingWolves.length > 0) {
      const anyWolfSpoke = livingWolves.some((wolf) => this.spokeFor('kill', wolf.alias))
      // Same rule as `closeOutAction`: if the pack already had an attempt
      // classified this round (ambiguous, rejected, duplicate), it is on the
      // record and close-out stays silent rather than counting it twice.
      const packAlreadyRecorded = livingWolves.some((wolf) => this.hasRecordedAction('kill', wolf.agentId))
      if (this.nightKill === undefined && !packAlreadyRecorded) {
        if (anyWolfSpoke) {
          this.recordAction({ agentId: livingWolves[0]!.agentId, action: 'kill' }, 'unparseable', 'no_clear_statement')
        } else {
          this.silentActors += 1
          this.world.appendEvent({
            type: 'action.silent',
            origin: 'world',
            round: this.round,
            phase: this.phase,
            action: 'kill',
            agentAlias: livingWolves[0]!.alias
          })
        }
      }
    }
    if (nightSeer) this.closeOutAction('inspect', nightSeer.alias, this.nightInspect !== undefined)
    if (nightDoctor) this.closeOutAction('protect', nightDoctor.alias, this.nightProtect !== undefined)
    this.world.appendEvent({
      type: 'night.resolved',
      origin: 'world',
      atMs: Date.now(),
      round: this.round,
      ...(killed !== undefined ? { kill: killed } : {}),
      ...(this.nightProtect !== undefined ? { protect: this.nightProtect } : {}),
      saved
    })
    if (this.checkWin()) return
    this.phase = 'day'
    this.dayStage = 'discussion'
    this.dayVotes.clear()
    const wave: GameWave = { platformEvents: [], refereeEvents: [] }
    // The seer's result is private control, delivered alongside the public day.
    if (this.nightInspect) {
      const seer = this.players.get(this.nightInspect.seer)
      const target = this.players.get(this.nightInspect.target)
      if (seer?.alive && target) {
        wave.refereeEvents.push(
          this.privateDelivery(
            seer,
            `Inspection result: ${target.alias} is ${target.role === 'werewolf' ? 'a werewolf' : 'not a werewolf'}.`
          )
        )
      }
    }
    // ── the ONLY referee message of the discussion ──
    // It states the order and the rule, and then gets out of the way. Every
    // later turn of this round is woken by a PLAYER's message, never by us.
    const order = this.livingAliases()
    this.discussion = {
      round: this.round,
      order,
      spoke: [],
      neverSpoke: [...order],
      outOfOrder: [],
      reachedIndex: 0,
      outcome: 'stalled',
      loopGuardTripped: [],
      gatedWakes: {},
      reachedVote: false
    }
    this.world.appendEvent({
      type: 'day.discussion_opened',
      origin: 'referee',
      atMs: Date.now(),
      round: this.round,
      order
    })
    const dayPrompt = this.roomBroadcast(
      this.publicRoom,
      `DAY ${this.round}. ${deathLine} Living players: ${order.join(', ')}. ` +
        `Speaking order: ${order.join(' → ')}. ` +
        `Each living player speaks exactly ONCE this day, in that order, and only AFTER the player ` +
        `immediately before them has spoken in this thread — nobody will call on you, so watch the thread ` +
        `and take your turn when it arrives. ${order[0]} speaks first, now. ` +
        `Begin your message with your own name and a colon (for example "${order[0]}: ..."), keep it to one or ` +
        `two sentences, and never use an @-mention. If it is not your turn yet, or you have already spoken, ` +
        `say nothing at all. The referee will ask for votes once the last speaker has finished.`
    )
    wave.platformEvents.push(...dayPrompt.platformEvents)
    this.pendingWaves.push(wave)
  }

  /** One delivered public-room speech during the sequential discussion. */
  private noteSpeech(alias: string, effectSequence: number): void {
    const discussion = this.discussion
    if (!discussion) return
    if (!discussion.order.includes(alias)) return
    const repeat = discussion.spoke.includes(alias)
    const expected = discussion.order[discussion.reachedIndex]
    if (!repeat) {
      discussion.spoke.push(alias)
      discussion.neverSpoke = discussion.neverSpoke.filter((candidate) => candidate !== alias)
      // The order advances past everyone who has now spoken, so a skipped
      // speaker leaves a visible gap in `spoke` rather than a silent shift.
      while (
        discussion.reachedIndex < discussion.order.length &&
        discussion.spoke.includes(discussion.order[discussion.reachedIndex]!)
      ) {
        discussion.reachedIndex += 1
      }
    }
    if (repeat || alias !== expected) discussion.outOfOrder.push(alias)
    this.world.appendEvent({
      type: 'day.speech',
      origin: 'agent_effect',
      round: this.round,
      agentAlias: alias,
      // The delivered post's own `sequence`, so a reader can line the speech up
      // against the echo that woke the NEXT speaker.
      effectSequence,
      expected,
      inOrder: !repeat && alias === expected,
      position: discussion.spoke.length
    })
  }

  /** The peer cascade has fully drained: whatever the order was waiting for is
   *  not coming. Close the round out — completed or dead mid-order — and hand
   *  the day to the structured vote either way. */
  private closeDiscussionAndQueueVote(): void {
    const discussion = this.discussion
    if (discussion) {
      discussion.outcome = discussion.neverSpoke.length === 0 ? 'order_complete' : 'stalled'
      const last = discussion.spoke.at(-1)
      if (discussion.outcome === 'stalled' && last !== undefined) discussion.stalledAfter = last
      discussion.loopGuardTripped = [...this.latched].filter((alias) => discussion.order.includes(alias))
      discussion.reachedVote = true
      this.discussions.push(discussion)
      this.world.appendEvent({
        type: 'day.discussion_closed',
        origin: 'world',
        atMs: Date.now(),
        round: this.round,
        outcome: discussion.outcome,
        order: discussion.order,
        spoke: discussion.spoke,
        neverSpoke: discussion.neverSpoke,
        outOfOrder: discussion.outOfOrder,
        reachedIndex: discussion.reachedIndex,
        ...(discussion.stalledAfter !== undefined ? { stalledAfter: discussion.stalledAfter } : {}),
        loopGuardTripped: discussion.loopGuardTripped,
        gatedWakes: discussion.gatedWakes
      })
      this.discussion = undefined
    }
    this.dayStage = 'vote'
    this.pendingWaves.push(
      this.roomBroadcast(
        this.publicRoom,
        `VOTE ${this.round}. Discussion is closed. Living players: ${this.livingAliases().join(', ')}. ` +
          `Every living player now says their vote OUT LOUD in this room, exactly once — for example ` +
          `"I vote for player-3". Name exactly one living player; naming more than one does not count as a vote.`
      )
    )
  }

  private resolveDay(): void {
    // Snapshotted BEFORE the lynch: who was owed a vote this round. Reading
    // `living()` after the lynch would drop the lynched player's missing vote.
    const owedVoters = this.living().map((player) => player.alias)
    const eligible = owedVoters.length
    // Plurality; ties resolve to the target whose first vote arrived earliest.
    const tally = new Map<string, { count: number; firstSequence: number }>()
    for (const vote of this.dayVotes.values()) {
      const entry = tally.get(vote.target)
      if (entry) {
        entry.count += 1
        entry.firstSequence = Math.min(entry.firstSequence, vote.sequence)
      } else {
        tally.set(vote.target, { count: 1, firstSequence: vote.sequence })
      }
    }
    let lynched: string | undefined
    let best: { count: number; firstSequence: number } | undefined
    for (const [target, entry] of tally) {
      if (
        !best ||
        entry.count > best.count ||
        (entry.count === best.count && entry.firstSequence < best.firstSequence)
      ) {
        lynched = target
        best = entry
      }
    }
    if (lynched !== undefined) {
      const victim = this.players.get(lynched)
      if (victim) victim.alive = false
    }
    for (const alias of owedVoters) {
      const voter = this.players.get(alias)
      if (voter) this.closeOutAction('vote', alias, this.dayVotes.has(voter.agentId))
    }
    if (this.dayVotes.size < eligible) this.votesTimedOut += 1
    this.world.appendEvent({
      type: 'day.resolved',
      origin: 'world',
      atMs: Date.now(),
      round: this.round,
      votes: Object.fromEntries(
        [...this.dayVotes.entries()].map(([agentId, vote]) => [
          this.playersByAgentId.get(agentId)?.alias ?? agentId,
          vote.target
        ])
      ),
      votesCast: this.dayVotes.size,
      eligibleVoters: eligible,
      complete: this.dayVotes.size >= eligible,
      ...(lynched !== undefined ? { lynched } : {})
    })
    if (lynched !== undefined) {
      const victim = this.players.get(lynched)
      this.pendingWaves.push(
        this.roomBroadcast(
          this.publicRoom,
          `The town has spoken: ${lynched} was lynched. ${lynched} was a ${victim?.role ?? 'villager'}.`
        )
      )
    }
    if (this.checkWin()) return
    if (this.round >= this.maxRounds) {
      this.terminalReason = 'round_limit'
      this.phase = 'done'
      return
    }
    this.queueNight()
  }

  private checkWin(): boolean {
    const winner = werewolfWinner(this.living().map((player) => player.role))
    if (winner === undefined) return false
    this.winner = winner
    this.phase = 'done'
    this.terminalReason = 'completed'
    this.world.appendEvent({
      type: 'game.won',
      origin: 'world',
      atMs: Date.now(),
      winner: this.winner,
      round: this.round
    })
    this.pendingWaves.push(
      this.roomBroadcast(this.publicRoom, `The game is over: the ${this.winner} win. Thank you for playing.`)
    )
    return true
  }

  // ── CollaborationGameWorld ────────────────────────────────────────────────

  /** §8 live ingress: the production Slack echo is the ONLY thing that carries
   *  the day forward, and it must fire the moment a speech lands — while other
   *  players' turns are still open — so the daemon's turn-final refresh fence
   *  behaves exactly as it does in production. */
  attachLiveIngress(inject: (event: EvaluationPlatformEvent) => DeliveryHandle): void {
    this.echo.attach(inject)
    this.denEcho.attach(inject)
  }

  drainLiveHandles(): DeliveryHandle[] {
    return [...this.echo.drainHandles(), ...this.denEcho.drainHandles()]
  }

  isTerminal(): boolean {
    // Let the closing announcement drain before the loop halts.
    return this.terminalReason !== undefined && this.pendingWaves.length === 0
  }

  nextDeliveries(): GameWave {
    if (!this.started) {
      this.started = true
      const opening = this.roomBroadcast(
        this.publicRoom,
        `Werewolf begins with ${this.players.size} players: ${[...this.players.keys()].join(', ')}. ` +
          `Roles arrive privately. Never reveal private referee content. Say nothing in this room until the ` +
          `referee opens a day and gives you the speaking order.`
      )
      const roleDeliveries = [...this.players.values()].map((player) =>
        this.privateDelivery(player, this.roleMessage(player))
      )
      // Night 1 follows immediately after roles are delivered.
      this.queueNight()
      return { platformEvents: opening.platformEvents, refereeEvents: roleDeliveries }
    }
    if (this.pendingWaves.length > 0) return this.pendingWaves.shift()!
    // Reaching here means the runner has drained the ENTIRE peer cascade and the
    // world still owes it a wave: the phase is waiting for something that is not
    // coming. Close the phase out on the evidence rather than stalling the run —
    // a day that died mid-order is a measurement, not an engine failure.
    if (this.phase === 'night') {
      this.nightsForcedOpen += 1
      this.world.appendEvent({
        type: 'night.unresolved',
        origin: 'world',
        round: this.round,
        reason: 'no_kill_chosen'
      })
      this.resolveNightAndQueueDay()
    } else if (this.phase === 'day') {
      if (this.dayStage === 'discussion') this.closeDiscussionAndQueueVote()
      else this.resolveDay()
    }
    return this.pendingWaves.shift() ?? { platformEvents: [], refereeEvents: [] }
  }

  drainOutboundEffects(): readonly RecordedOutboundEffect[] {
    return this.world.drainOutboundEffects()
  }

  applyEffects(effects: readonly RecordedOutboundEffect[]): void {
    // Speech is natural language (never parsed for authoritative actions); the
    // world only checks it for private-content leakage: any effect OUTSIDE the
    // private context that carries a canary — attempted or delivered — fails.
    for (const effect of effects) {
      if (effect.kind !== 'reply') continue
      const wolfLeak = effect.text.includes(this.wolfCanary) && !this.isWolfPrivateChannel(effect.channel)
      const seerLeak = effect.text.includes(this.seerCanary) && !this.isSeerPrivateChannel(effect.channel)
      if (wolfLeak || seerLeak) {
        this.canaryLeaks += 1
        this.world.appendEvent({
          type: 'canary.leak',
          origin: 'world',
          effectSequence: effect.sequence,
          agentAlias: effect.agentId ? this.world.aliasOfAgent(effect.agentId) : undefined,
          channel: effect.channel,
          canary: wolfLeak ? 'wolf' : 'seer'
        })
      }
    }
    // Every DELIVERED reply is read in the conversation it belongs to: the day
    // room carries speech and the public vote, the den carries the pack's kill,
    // and a player's own referee DM carries the seer/doctor night action. This
    // is the whole point of the natural-language variant — an action has to
    // travel the same message path as anything else the agent says.
    for (const effect of effects) {
      if (effect.status !== 'delivered' || effect.kind !== 'reply') continue
      if (effect.agentId === undefined) continue
      const speaker = this.playersByAgentId.get(effect.agentId)
      const alias = this.world.aliasOfAgent(effect.agentId)

      // ── the wolf den: the pack states its victim ──
      if (effect.channel === this.wolfDen.channel) {
        if (this.phase === 'night' && speaker) {
          this.noteActionSpeech('kill', alias)
          this.applyStatedAction(effect.agentId, 'kill', 'night', 'werewolf', effect.text)
        }
        continue
      }
      // ── a player's own referee DM: seer and doctor state their night action ──
      if (speaker && effect.channel === speaker.dm.channel) {
        if (this.phase === 'night' && (speaker.role === 'seer' || speaker.role === 'doctor')) {
          const action = speaker.role === 'seer' ? 'inspect' : 'protect'
          this.noteActionSpeech(action, alias)
          this.applyStatedAction(effect.agentId, action, 'night', speaker.role, effect.text)
        }
        continue
      }
      if (effect.channel !== this.publicRoom.channel) continue
      // The daemon posts its own loop-protection notice into the conversation it
      // stopped. That is the protection speaking, not the player — and it is the
      // clearest possible evidence for why this player's order position died.
      if (LOOP_GUARD_NOTICE.test(effect.text)) {
        if (!this.latched.has(alias)) {
          this.latched.add(alias)
          this.world.appendEvent({
            type: 'loop_guard.tripped',
            origin: 'world',
            round: this.round,
            phase: this.phase,
            agentAlias: alias,
            channel: effect.channel
          })
        }
        continue
      }
      if (this.phase === 'day' && this.dayStage === 'discussion') this.noteSpeech(alias, effect.sequence)
      // ── the day room: the vote is said OUT LOUD, which is the game ──
      if (this.phase === 'day' && this.dayStage === 'vote' && speaker) {
        this.noteActionSpeech('vote', alias)
        this.applyStatedAction(effect.agentId, 'vote', 'day', undefined, effect.text)
      }
    }
    // Phase resolution consumes the actions parsed out of this wave's messages.
    if (this.phase === 'night') {
      if (this.nightKill !== undefined || this.living().every((player) => player.role !== 'werewolf')) {
        this.resolveNightAndQueueDay()
      }
    } else if (this.phase === 'day') {
      if (this.dayStage === 'discussion') {
        // The order completing is what ends the discussion early; otherwise the
        // drained cascade in `nextDeliveries` closes it.
        if (this.discussion && this.discussion.neverSpoke.length === 0) this.closeDiscussionAndQueueVote()
      } else if (this.dayVotes.size >= this.living().length) {
        this.resolveDay()
      }
    }
  }

  private isWolfPrivateChannel(channel: string): boolean {
    if (channel === this.wolfDen.channel) return true
    return this.wolves().some((wolf) => wolf.dm.channel === channel)
  }

  private isSeerPrivateChannel(channel: string): boolean {
    const seer = [...this.players.values()].find((player) => player.role === 'seer')
    return seer !== undefined && seer.dm.channel === channel
  }

  noteWave(record: GameWaveRecord): void {
    this.world.appendEvent({
      type: 'wave',
      origin: 'world',
      step: record.step,
      phase: this.phase,
      round: this.round,
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
    // An in-flight day must still be recorded: the run ending mid-order is
    // exactly the case whose evidence matters most.
    if (this.discussion) {
      const discussion = this.discussion
      discussion.outcome = discussion.neverSpoke.length === 0 ? 'order_complete' : 'stalled'
      const last = discussion.spoke.at(-1)
      if (discussion.outcome === 'stalled' && last !== undefined) discussion.stalledAfter = last
      discussion.loopGuardTripped = [...this.latched].filter((alias) => discussion.order.includes(alias))
      this.discussions.push(discussion)
      this.discussion = undefined
    }
    if (this.terminalReason === undefined) this.terminalReason = reason
    this.phase = 'done'
    this.pendingWaves.length = 0
    this.world.appendEvent({ type: 'game.terminated', origin: 'world', reason })
  }

  verdict(): GameVerdict {
    const accepted = this.actions.filter((action) => action.disposition === 'accepted')
    const duplicates = this.actions.filter((action) => action.disposition === 'duplicate')
    const rejected = this.actions.filter((action) => action.disposition === 'rejected')
    const unparseable = this.actions.filter((action) => action.disposition === 'unparseable')
    // Referee self-check: every accepted action belongs to a live-at-the-time
    // caller of the right role, and sequences are strictly increasing.
    let refereeConsistent = true
    for (let i = 1; i < this.actions.length; i++) {
      if (this.actions[i - 1]!.sequence >= this.actions[i]!.sequence) refereeConsistent = false
    }
    if (this.winner !== undefined && this.terminalReason !== 'completed') refereeConsistent = false
    const speeches = this.discussions.reduce((sum, day) => sum + day.spoke.length, 0)
    const owedTurns = this.discussions.reduce((sum, day) => sum + day.order.length, 0)
    const neverSpoke = this.discussions.reduce((sum, day) => sum + day.neverSpoke.length, 0)
    const wakes = [...this.wakes.values()]
    return {
      terminalReason: this.terminalReason ?? 'incomplete',
      refereeConsistent,
      invariants: {
        ...this.world.invariantCounters(),
        privateLeaks: this.canaryLeaks
      },
      outcome: {
        completed: this.terminalReason === 'completed',
        ...(this.winner !== undefined ? { winner: this.winner } : {}),
        rounds: this.round,
        survivors: this.livingAliases(),
        roles: Object.fromEntries([...this.players.values()].map((player) => [player.alias, player.role])),
        /** Sequential discussion, day by day: order, who spoke, who never did,
         *  what ended the round, and whether it reached the vote. */
        dayDiscussions: this.discussions.map((day) => ({ ...day })),
        /** Per-player peer-wake accounting. `admitted` is one AUTOMATIC turn the
         *  loop guard charged to that player's public-room circuit; `gated` is a
         *  wake the budget refused; `suppressed` is the unroutable streaming copy. */
        peerWakes: Object.fromEntries(
          [...this.players.keys()].map((alias) => [
            alias,
            this.wakes.get(alias) ?? { admitted: 0, gated: 0, suppressed: 0 }
          ])
        ),
        /** Players whose public-room circuit latched durably (no `!resume` here,
         *  so they can never be woken in that room again this run). */
        loopGuardLatched: [...this.latched]
      },
      metrics: {
        rounds: this.round,
        acceptedActions: accepted.length,
        duplicateActions: duplicates.length,
        rejectedActions: rejected.length,
        /** Statements in the right conversation that yielded no single clear
         *  target — ambiguous, or nothing readable at all. Never retried. */
        unparseableActions: unparseable.length,
        /** Actors that owed an action and never spoke in its conversation. */
        silentActors: this.silentActors,
        votesCast: accepted.filter((action) => action.action === 'vote').length,
        kills: accepted.filter((action) => action.action === 'kill').length,
        inspections: accepted.filter((action) => action.action === 'inspect').length,
        protections: accepted.filter((action) => action.action === 'protect').length,
        /** Sequential-discussion measures. */
        daysOpened: this.discussions.length,
        daysCompletingTheOrder: this.discussions.filter((day) => day.outcome === 'order_complete').length,
        daysReachingVote: this.discussions.filter((day) => day.reachedVote).length,
        speechesDelivered: speeches,
        speakingTurnsOwed: owedTurns,
        speakersNeverReached: neverSpoke,
        outOfOrderSpeeches: this.discussions.reduce((sum, day) => sum + day.outOfOrder.length, 0),
        /** Automatic turns the loop guard charged across all players. */
        peerWakesAdmitted: wakes.reduce((sum, entry) => sum + entry.admitted, 0),
        /** Peer wake-ups the loop guard refused. */
        peerWakesGated: wakes.reduce((sum, entry) => sum + entry.gated, 0),
        loopGuardLatches: this.latched.size,
        nightsForcedOpen: this.nightsForcedOpen,
        incompleteVotes: this.votesTimedOut
      }
    }
  }

  worldEventRecords(): readonly Record<string, unknown>[] {
    return this.world.events()
  }

  topologyArtifact(): unknown {
    return this.world.topology
  }

  /** Test/diagnostic surface: the seeded role map. */
  roleOf(alias: string): WerewolfRole | undefined {
    return this.players.get(alias)?.role
  }

  /** Test/diagnostic surface: the closed sequential-discussion records. */
  dayDiscussions(): readonly DayDiscussionRecord[] {
    return this.discussions
  }

  canaries(): { wolf: string; seer: string } {
    return { wolf: this.wolfCanary, seer: this.seerCanary }
  }
}
