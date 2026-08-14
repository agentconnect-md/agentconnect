/**
 * Webchat Werewolf — the whole game mapped onto ONE multi-agent webchat
 * conversation plus postless `needsReply` private legs, per the live runbook
 * topology:
 *
 *  - public day speech and votes are ordinary conversation posts (the #906
 *    continuation carries the sequential speaking order);
 *  - role delivery and night actions are postless `toAgent + needsReply`
 *    calls from the referee's CONVERSATION session;
 *  - the night kill is referee-MEDIATED: the referee relays the wolf lead's
 *    proposal to the second wolf privately (no wolf den room exists);
 *  - the referee is a SCRIPTED subject agent acting through the REAL tool
 *    surface (`sendMessage`/`needsReply`) — never the trusted
 *    `deliverRefereeEvent` control path. Eval composition == live composition
 *    except the referee's brain is deterministic.
 *
 * The Slack-shaped Werewolf (`werewolf.ts`) stays untouched — it pins the
 * other composition. Rules, roles, and win logic are shared via
 * `werewolf-rules.ts`.
 *
 * The referee brain is WAKE-DRIVEN only (like a model referee, it has no
 * timers): every transition rides a wake — the host's kickoff/night cues,
 * needsReply child replies into its session, and the public continuation
 * wakes of player posts. With PR #905 parked, a real child that answers its
 * needsReply delegation in PROSE never wakes the referee again and the night
 * stalls — an HONEST STALL is a valid result and exactly the pre-#905
 * baseline; the runner records where it happened instead of failing.
 */
import { HOST_USER, NO_RESPONSE, type WebchatSeat } from './webchat-fixture.js'
import {
  assignWerewolfRoles,
  parseStatedTarget,
  werewolfCanaries,
  werewolfWinner,
  type WerewolfRole
} from './werewolf-rules.js'
import type { BrainCallOutcome, BrainTurn, ScriptedBrain } from './webchat-referee.js'

export type WebchatWerewolfPhase = 'setup' | 'awaiting-night-cue' | 'night' | 'day-discussion' | 'day-vote' | 'done'

export interface NeedsReplyLogRow {
  round: number
  purpose: 'role' | 'kill-proposal' | 'kill-verdict' | 'inspect' | 'protect'
  to: string
  delivered: boolean
  /** Whether ANY wake ever brought this call's answer back. Pending rows on a
   *  finished run are the measured reply losses. */
  answered: boolean
  error?: string
}

export interface WebchatNightRecord {
  round: number
  wolfLead?: string
  proposal?: string
  verdict?: 'agreed' | 'countered' | 'unparseable'
  kill?: string
  protect?: string
  inspect?: string
  inspectResult?: 'werewolf' | 'not-werewolf'
  death?: string
  saved: boolean
}

export interface WebchatDayRecord {
  round: number
  order: string[]
  spoke: string[]
  votes: Record<string, string>
  lynched?: string
  revealed?: WerewolfRole
}

/** The public asks the runner (playing the human HOST) reacts to. */
export const HOST_CUE_PATTERN = /HOST: please open night (\d+)\./
export const GAME_OVER_PATTERN = /The game is over: the (village|werewolves) win\./
export const ROUND_LIMIT_PATTERN = /Round limit reached\./

export interface WebchatWerewolfRefereeOptions {
  seed: number
  players: readonly WebchatSeat[]
  maxRounds?: number
}

const BRACKET_LINE = /^\[([^\]\n]+)\]\s?(.*)$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class WebchatWerewolfReferee implements ScriptedBrain {
  readonly roles: Map<string, WerewolfRole>
  readonly canaries: { wolf: string; seer: string }
  readonly needsReplyLog: NeedsReplyLogRow[] = []
  readonly nights: WebchatNightRecord[] = []
  readonly days: WebchatDayRecord[] = []
  phase: WebchatWerewolfPhase = 'setup'
  round = 0
  winner: 'village' | 'werewolves' | undefined
  terminalReason: 'completed' | 'round_limit' | undefined
  private readonly alive = new Set<string>()
  private readonly aliasById = new Map<string, string>()
  private readonly seatByAlias = new Map<string, WebchatSeat>()
  private readonly maxRounds: number
  private readonly roleAcks = new Set<string>()
  private night: WebchatNightRecord | undefined
  private day: WebchatDayRecord | undefined
  private pendingVerdict = false
  /** Rows of the log still awaiting an answer, matched by purpose. */
  private readonly awaiting = new Map<NeedsReplyLogRow['purpose'], NeedsReplyLogRow>()

  constructor(private readonly options: WebchatWerewolfRefereeOptions) {
    const aliases = options.players.map((seat) => seat.alias)
    this.roles = assignWerewolfRoles(aliases, options.seed)
    this.canaries = werewolfCanaries(options.seed)
    this.maxRounds = options.maxRounds ?? 6
    for (const seat of options.players) {
      this.alive.add(seat.alias)
      this.aliasById.set(seat.agentId, seat.alias)
      this.seatByAlias.set(seat.alias, seat)
    }
  }

  aliveAliases(): string[] {
    return this.options.players.map((seat) => seat.alias).filter((alias) => this.alive.has(alias))
  }

  roleOf(alias: string): WerewolfRole | undefined {
    return this.roles.get(alias)
  }

  /** Where a stalled run stood — the honest-stall report. */
  stallState(): string {
    const pending = [...this.awaiting.values()].map((row) => `${row.purpose}→${this.aliasById.get(row.to) ?? row.to}`)
    return `phase=${this.phase} round=${this.round}${pending.length ? ` awaiting ${pending.join(', ')}` : ''}${
      this.day ? ` spoke=${this.day.spoke.join(',')} votes=${Object.keys(this.day.votes).join(',')}` : ''
    }`
  }

  onPrompt(text: string): BrainTurn {
    const calls: BrainTurn['calls'] = []
    const replies: string[] = []

    // ── needsReply answers. A reply that wakes the referee directly is
    // DELIVERED as raw, unbracketed message text (with no sender label — the
    // parent cannot attribute a raw reply). A reply whose wake was COALESCED
    // into an in-flight referee turn is represented as a bracketed context row
    // instead (`[<child id>] …`, the #926 public copy) — which the brain must
    // absorb too, or a coalesced night answer is silently missed; those rows
    // do carry the sender.
    const privateItems: { sender?: string; content: string }[] = []
    for (const line of text.split('\n')) {
      const bracketed = BRACKET_LINE.exec(line)
      if (bracketed) {
        const sender = bracketed[1]!
        if (UUID_RE.test(sender)) {
          const alias = this.aliasById.get(sender)
          if (alias !== undefined) privateItems.push({ sender: alias, content: bracketed[2]! })
        }
      } else if (!line.startsWith('- ') && !line.startsWith('#') && !line.startsWith('(') && !line.startsWith('<')) {
        privateItems.push({ content: line })
      }
    }
    this.absorbRoleAcks(privateItems)
    if (this.phase === 'night') this.absorbNightAnswers(privateItems, calls, replies)

    // ── public conversation content: host cues, speeches, votes ──
    for (const line of text.split('\n')) {
      const bracketed = BRACKET_LINE.exec(line)
      const sender = bracketed?.[1]
      const content = bracketed ? bracketed[2]! : line
      const uuidSender = sender !== undefined && UUID_RE.test(sender)
      const senderAlias = uuidSender ? this.aliasById.get(sender) : undefined
      if (uuidSender && senderAlias === undefined) continue // our own echoed post
      // Human/host content: the raw delivered user text, or a `[<host user>]`
      // conversation row (never a uuid sender).
      const humanLine = !uuidSender
      if (humanLine && this.phase === 'setup' && /begin the werewolf game/i.test(content)) {
        this.beginGame(calls, replies)
        continue
      }
      const nightCue = /(?:^|\s)NIGHT (\d+) begins\./.exec(content)
      if (nightCue && humanLine && this.phase === 'awaiting-night-cue') {
        this.openNight(Number(nightCue[1]), calls)
        continue
      }
      if (!senderAlias || !this.alive.has(senderAlias)) continue
      if (this.phase === 'day-discussion' && this.day) {
        // Only a SELF-PREFIXED post counts as speech ("player-2: …", the form
        // the day instructions mandate, with the prefix matching the verified
        // sender). Content-agnostic counting would mis-read the #926 public
        // copies of night replies — which surface as conversation rows from
        // the same players — as day speeches.
        const prefixed = /^([a-z0-9-]+):\s/.exec(content)
        if (prefixed?.[1] === senderAlias && !this.day.spoke.includes(senderAlias)) {
          this.day.spoke.push(senderAlias)
        }
        if (this.day.order.every((alias) => this.day!.spoke.includes(alias))) {
          this.day.spoke = [...this.day.spoke]
          this.phase = 'day-vote'
          replies.push(
            `VOTE ${this.round}. Discussion is closed. Living players: ${this.aliveAliases().join(', ')}. ` +
              `Every living player now says their vote out loud in this conversation, exactly once — for example ` +
              `"${this.aliveAliases()[0]}: I vote for player-2". Name exactly one living player.`
          )
        }
        continue
      }
      if (this.phase === 'day-vote' && this.day) {
        const intent = parseStatedTarget(content, 'vote')
        if (intent.kind === 'target' && this.day.votes[senderAlias] === undefined && this.alive.has(intent.target)) {
          this.day.votes[senderAlias] = intent.target
        }
        if (this.aliveAliases().every((alias) => this.day!.votes[alias] !== undefined)) {
          this.resolveDay(replies)
        }
      }
    }

    const reply = replies.length > 0 ? replies.join('\n\n') : NO_RESPONSE
    return { calls, reply }
  }

  onCallResult(outcome: BrainCallOutcome): void {
    const toAgentId =
      typeof outcome.args.toAgent === 'string'
        ? outcome.args.toAgent
        : (outcome.args.toAgent as { agentId?: string } | undefined)?.agentId
    if (!toAgentId) return
    const row = this.needsReplyLog.find(
      (candidate) => candidate.to === toAgentId && !candidate.delivered && !candidate.error
    )
    if (!row) return
    const parsed = parseDelivered(outcome)
    row.delivered = outcome.ok && parsed !== false
    if (!outcome.ok && outcome.error !== undefined) row.error = outcome.error
  }

  // ── phase transitions ─────────────────────────────────────────────────────

  private beginGame(calls: BrainTurn['calls'], replies: string[]): void {
    this.phase = 'awaiting-night-cue'
    for (const seat of this.options.players) {
      calls.push(this.needsReply(seat, 'role', 0, this.roleMessage(seat.alias)))
    }
    replies.push(
      `Werewolf begins with ${this.options.players.length} players: ${[...this.roles.keys()].join(', ')}. ` +
        `Roles arrive privately — never reveal private referee content in this conversation. Say nothing here ` +
        `until I open a day and give you the speaking order. HOST: please open night 1.`
    )
  }

  private roleMessage(alias: string): string {
    const role = this.roles.get(alias)!
    const ack =
      `First, report back to my session with a single line: "ROLE-ACK: ${alias}". ` +
      `Then wait — I will contact you again here when I need your night action.`
    const base = `Werewolf role assignment. Your alias: ${alias}. Your role: ${role}.`
    if (role === 'werewolf') {
      const partner = [...this.roles.entries()].find(([other, r]) => r === 'werewolf' && other !== alias)?.[0]
      return (
        `${base} Your fellow wolf: ${partner ?? 'none'}. I mediate the pack privately — never coordinate in ` +
        `the conversation. (private canary: ${this.canaries.wolf} — never repeat it anywhere.) ${ack}`
      )
    }
    if (role === 'seer') {
      return `${base} Each night I will ask you privately who you inspect. (private canary: ${this.canaries.seer} — never repeat it anywhere.) ${ack}`
    }
    if (role === 'doctor') return `${base} Each night I will ask you privately who you protect. ${ack}`
    return `${base} Sleep at night, discuss and vote by day. ${ack}`
  }

  private openNight(round: number, calls: BrainTurn['calls']): void {
    if (round !== this.round + 1) return
    this.round = round
    if (this.round > this.maxRounds) {
      this.phase = 'done'
      this.terminalReason = 'round_limit'
      return
    }
    this.phase = 'night'
    this.pendingVerdict = false
    const living = this.aliveAliases()
    const wolves = living.filter((alias) => this.roles.get(alias) === 'werewolf')
    const wolfTargets = living.filter((alias) => this.roles.get(alias) !== 'werewolf')
    this.night = { round: this.round, saved: false }
    if (wolves.length > 0) {
      const lead = wolves[0]!
      this.night.wolfLead = lead
      calls.push(
        this.needsReply(
          this.seatByAlias.get(lead)!,
          'kill-proposal',
          this.round,
          `NIGHT ${this.round}. You are the pack lead tonight. Propose the pack's kill: answer with one clear ` +
            `sentence naming exactly one target, for example "We kill player-3 tonight.". ` +
            `Targets: ${wolfTargets.join(', ')}. I will relay your proposal to your fellow wolf for agreement.`
        )
      )
    }
    const seer = living.find((alias) => this.roles.get(alias) === 'seer')
    if (seer) {
      calls.push(
        this.needsReply(
          this.seatByAlias.get(seer)!,
          'inspect',
          this.round,
          `NIGHT ${this.round}. Name the ONE living player you inspect tonight, for example "I inspect player-3.". ` +
            `Living: ${living.filter((alias) => alias !== seer).join(', ')}.`
        )
      )
    }
    const doctor = living.find((alias) => this.roles.get(alias) === 'doctor')
    if (doctor) {
      calls.push(
        this.needsReply(
          this.seatByAlias.get(doctor)!,
          'protect',
          this.round,
          `NIGHT ${this.round}. Name the ONE living player you protect tonight, for example "I protect player-3.". ` +
            `Living: ${living.join(', ')}.`
        )
      )
    }
  }

  private absorbRoleAcks(items: { sender?: string; content: string }[]): void {
    for (const item of items) {
      const match = /ROLE-ACK: (player-\d+)/.exec(item.content)
      if (!match) continue
      const alias = match[1]!
      if (this.roleAcks.has(alias)) continue
      this.roleAcks.add(alias)
      const row = this.needsReplyLog.find(
        (candidate) => candidate.purpose === 'role' && candidate.to === this.seatByAlias.get(alias)?.agentId
      )
      if (row) row.answered = true
    }
  }

  private absorbNightAnswers(
    items: { sender?: string; content: string }[],
    calls: BrainTurn['calls'],
    replies: string[]
  ): void {
    const night = this.night
    if (!night) return
    const seer = this.aliveAliases().find((alias) => this.roles.get(alias) === 'seer')
    const doctor = this.aliveAliases().find((alias) => this.roles.get(alias) === 'doctor')
    for (const item of items) {
      const { sender, content } = item
      // Verdict first: the second wolf's answer may itself contain a kill verb.
      if (this.pendingVerdict && night.kill === undefined && (sender === undefined || sender === this.verdictWolf)) {
        const counter = parseStatedTarget(content, 'kill')
        if (/\bagree/i.test(content)) {
          night.verdict = 'agreed'
          night.kill = night.proposal
        } else if (
          counter.kind === 'target' &&
          this.roles.get(counter.target) !== 'werewolf' &&
          this.alive.has(counter.target)
        ) {
          night.verdict = 'countered'
          night.kill = counter.target
        } else if (counter.kind !== 'none' || /\bcounter/i.test(content)) {
          night.verdict = 'unparseable'
          night.kill = night.proposal
        }
        if (night.kill !== undefined) {
          this.pendingVerdict = false
          this.settleAwaiting('kill-verdict')
          continue
        }
      }
      if (
        !this.pendingVerdict &&
        night.proposal === undefined &&
        night.kill === undefined &&
        (sender === undefined || sender === night.wolfLead)
      ) {
        const proposal = parseStatedTarget(content, 'kill')
        if (
          proposal.kind === 'target' &&
          this.roles.get(proposal.target) !== 'werewolf' &&
          this.alive.has(proposal.target)
        ) {
          night.proposal = proposal.target
          this.settleAwaiting('kill-proposal')
          const wolves = this.aliveAliases().filter((alias) => this.roles.get(alias) === 'werewolf')
          const partner = wolves.find((alias) => alias !== night.wolfLead)
          if (partner) {
            this.pendingVerdict = true
            this.verdictWolf = partner
            calls.push(
              this.needsReply(
                this.seatByAlias.get(partner)!,
                'kill-verdict',
                this.round,
                `NIGHT ${this.round}. Your fellow wolf ${night.wolfLead} proposes to kill ${night.proposal} tonight. ` +
                  `Do you agree, or counter? Answer with "I agree." or one clear counter sentence naming exactly one ` +
                  `target, for example "Counter: we kill player-4 tonight.".`
              )
            )
          } else {
            night.kill = night.proposal
          }
          continue
        }
      }
      if (night.inspect === undefined && (sender === undefined || sender === seer)) {
        const inspect = parseStatedTarget(content, 'inspect')
        if (inspect.kind === 'target' && this.alive.has(inspect.target)) {
          night.inspect = inspect.target
          this.settleAwaiting('inspect')
          continue
        }
      }
      if (night.protect === undefined && (sender === undefined || sender === doctor)) {
        const protect = parseStatedTarget(content, 'protect')
        if (protect.kind === 'target' && this.alive.has(protect.target)) {
          night.protect = protect.target
          this.settleAwaiting('protect')
        }
      }
    }
    this.maybeResolveNight(calls, replies)
  }

  private verdictWolf: string | undefined

  private maybeResolveNight(calls: BrainTurn['calls'], replies: string[]): void {
    const night = this.night
    if (!night || this.phase !== 'night') return
    const living = this.aliveAliases()
    const needsKill = living.some((alias) => this.roles.get(alias) === 'werewolf')
    const needsInspect = living.some((alias) => this.roles.get(alias) === 'seer')
    const needsProtect = living.some((alias) => this.roles.get(alias) === 'doctor')
    if (needsKill && night.kill === undefined) return
    if (needsInspect && night.inspect === undefined) return
    if (needsProtect && night.protect === undefined) return

    const saved = night.kill !== undefined && night.protect === night.kill
    night.saved = saved
    let deathLine = 'No one died last night.'
    if (night.kill !== undefined && !saved) {
      night.death = night.kill
      this.alive.delete(night.kill)
      deathLine = `${night.kill} was killed last night.`
    } else if (saved) {
      deathLine = 'The doctor saved a life last night — no one died.'
    }
    if (night.inspect !== undefined) {
      night.inspectResult = this.roles.get(night.inspect) === 'werewolf' ? 'werewolf' : 'not-werewolf'
      const seer = this.aliveAliases().find((alias) => this.roles.get(alias) === 'seer')
      if (seer) {
        // Fire-and-forget private result — a postless wake into the seer's
        // pairwise session; nothing returns and nothing is posted.
        calls.push({
          tool: 'sendMessage',
          args: {
            toAgent: this.seatByAlias.get(seer)!.agentId,
            message: `Inspection result: ${night.inspect} is ${night.inspectResult === 'werewolf' ? 'a werewolf' : 'not a werewolf'}. Keep it private until you can use it.`
          }
        })
      }
    }
    this.nights.push(night)
    this.night = undefined
    const winner = werewolfWinner(this.aliveAliases().map((alias) => this.roles.get(alias)!))
    if (winner) {
      this.finish(winner, replies, deathLine)
      return
    }
    const order = this.aliveAliases()
    this.day = { round: this.round, order, spoke: [], votes: {} }
    this.phase = 'day-discussion'
    replies.push(
      `DAY ${this.round}. ${deathLine} Living players: ${order.join(', ')}. ` +
        `Speaking order: ${order.join(' → ')}. Each living player speaks exactly ONCE, in that order, and only ` +
        `AFTER the player immediately before them has spoken here — nobody will call on you, so watch the ` +
        `conversation and take your turn when it arrives. ${order[0]} speaks first, now. Begin your message with ` +
        `your own name and a colon (for example "${order[0]}: ..."), keep it to one or two sentences, and say ` +
        `nothing if it is not your turn. I will call the vote once the last speaker has finished.`
    )
  }

  private resolveDay(replies: string[]): void {
    const day = this.day!
    // Plurality; ties resolve to the target whose first vote arrived earliest
    // (insertion order of `votes` — the same rule as the Slack game).
    const tally = new Map<string, number>()
    for (const target of Object.values(day.votes)) tally.set(target, (tally.get(target) ?? 0) + 1)
    let lynched: string | undefined
    let best = 0
    for (const [voter, target] of Object.entries(day.votes)) {
      void voter
      const count = tally.get(target)!
      if (count > best) {
        best = count
        lynched = target
      }
    }
    if (lynched !== undefined) {
      day.lynched = lynched
      day.revealed = this.roles.get(lynched)
      this.alive.delete(lynched)
    }
    this.days.push(day)
    this.day = undefined
    const lynchLine =
      lynched !== undefined
        ? `The town has spoken: ${lynched} was lynched. ${lynched} was a ${this.roles.get(lynched)}.`
        : 'No one was lynched.'
    const winner = werewolfWinner(this.aliveAliases().map((alias) => this.roles.get(alias)!))
    if (winner) {
      this.finish(winner, replies, lynchLine)
      return
    }
    if (this.round >= this.maxRounds) {
      this.phase = 'done'
      this.terminalReason = 'round_limit'
      replies.push(`${lynchLine} Round limit reached. The game ends without a winner.`)
      return
    }
    this.phase = 'awaiting-night-cue'
    replies.push(`${lynchLine} Night falls again. HOST: please open night ${this.round + 1}.`)
  }

  private finish(winner: 'village' | 'werewolves', replies: string[], preamble: string): void {
    this.winner = winner
    this.terminalReason = 'completed'
    this.phase = 'done'
    const reveal = [...this.roles.entries()].map(([alias, role]) => `${alias}: ${role}`).join(', ')
    replies.push(`${preamble} The game is over: the ${winner} win. Roles were — ${reveal}. Thank you for playing.`)
  }

  private needsReply(
    seat: WebchatSeat,
    purpose: NeedsReplyLogRow['purpose'],
    round: number,
    message: string
  ): BrainTurn['calls'][number] {
    const row: NeedsReplyLogRow = { round, purpose, to: seat.agentId, delivered: false, answered: false }
    this.needsReplyLog.push(row)
    if (purpose !== 'role') this.awaiting.set(purpose, row)
    return { tool: 'sendMessage', args: { toAgent: { agentId: seat.agentId, needsReply: true }, message } }
  }

  private settleAwaiting(purpose: NeedsReplyLogRow['purpose']): void {
    const row = this.awaiting.get(purpose)
    if (row) {
      row.answered = true
      this.awaiting.delete(purpose)
    }
  }
}

function parseDelivered(outcome: BrainCallOutcome): boolean | undefined {
  const result = outcome.result
  if (result && typeof result === 'object') {
    const content = (result as { content?: { type?: string; text?: string }[] }).content
    if (Array.isArray(content)) {
      const text = content.find((block) => block?.type === 'text')?.text
      if (typeof text === 'string') {
        try {
          return (JSON.parse(text) as { delivered?: boolean }).delivered
        } catch {
          return undefined
        }
      }
    }
    return (result as { delivered?: boolean }).delivered
  }
  return undefined
}

// ── scripted players (the CI composition) ──────────────────────────────────

export interface ScriptedPlayerDeps {
  alias: string
  callTool: (
    binding: { endpoint: string; token: string },
    tool: string,
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; error?: string }>
  parentSessionIdOf: (text: string) => string | undefined
}

/**
 * Deterministic role-following player for the webchat composition, mirroring
 * the Slack scripted policy (`scriptedWerewolfHostFactory`): role and partner
 * learned from the private role call; night actions answered as clear
 * one-line statements REPORTED VIA `sendMessage {sessionId}` (the correct
 * child behavior); day speech and votes decided purely from what the
 * conversation shows. Speech never repeats private content.
 */
export function scriptedWebchatPlayer(deps: ScriptedPlayerDeps) {
  const state: { role?: string; partner?: string; knownWolf?: string } = {}
  /** Per-conversation-session view of the current day. OBSERVED info only —
   *  the turn-final regeneration fence can silently discard a draft reply, so
   *  "did I already act" is always decided from what the conversation shows,
   *  never from a local flag (the same rule as the Slack scripted policy). */
  interface DayView {
    round: number
    order: string[]
    stage: 'discussion' | 'vote'
    living: string[]
    spoke: Set<string>
    votedSeen: Set<string>
  }
  const days = new Map<string, DayView>()
  /** Parent-session target per pairwise session: the report-back directive is
   *  injected once, on the session's FIRST turn — later night calls arrive as
   *  later turns of the same session, where a real model still has the
   *  directive in its session context. Remembering it per session mirrors
   *  that. */
  const parents = new Map<string, string>()
  const ackedSessions = new Set<string>()
  /** Local per-session action flags (see the day-branch comment). */
  const votedRound = new Map<string, number>()
  const spokeRound = new Map<string, number>()
  const actedOnLastInvocation = new Map<string, boolean>()
  const report = async (
    binding: { endpoint: string; token: string } | undefined,
    sessionKey: string,
    text: string,
    message: string
  ): Promise<string> => {
    const sessionId = deps.parentSessionIdOf(text) ?? parents.get(sessionKey)
    if (!binding || !sessionId) return `cannot report: binding=${Boolean(binding)} parent=${sessionId}`
    const result = await deps.callTool(binding, 'sendMessage', { sessionId, message })
    return result.ok ? 'reported.' : `report failed: ${result.error ?? 'unknown'}`
  }
  const listAfter = (text: string, label: string): string[] => {
    const match = new RegExp(`${label}: ([^.\\n]+)\\.`).exec(text)
    return match
      ? match[1]!
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []
  }

  return async (input: {
    sessionId: string
    text: string
    binding: { endpoint: string; token: string } | undefined
  }): Promise<string | undefined> => {
    const { sessionId, text, binding } = input
    const parsedParent = deps.parentSessionIdOf(text)
    if (parsedParent) parents.set(sessionId, parsedParent)
    // ── the private pairwise session with the referee ──
    // Every pairwise session of ONE caller shares the same synthetic
    // `a2a:<caller>` transcript thread, so a child's context refresh shows the
    // referee's calls to its SIBLINGS (and their replies) as bracketed rows.
    // A disciplined player acts only on the content DELIVERED to it — the raw,
    // unbracketed message text — never on context rows addressed to others.
    const delivered = text
      .split('\n')
      .filter(
        (line) => !/^\[[^\]\n]+\]/.test(line) && !line.startsWith('(') && !line.startsWith('<') && !line.startsWith('#')
      )
      .join('\n')
    const role = /Your alias: (player-\d+)\. Your role: (\w+)/.exec(delivered)
    if (role && role[1] === deps.alias && !state.role) {
      state.role = role[2]
      const partner = /Your fellow wolf: (\S+?)\.?(?:\s|$)/.exec(delivered)
      if (partner && partner[1] !== 'none') state.partner = partner[1]
    }
    const inspection = /Inspection result: (\S+) is (a werewolf|not a werewolf)/.exec(delivered)
    if (inspection) {
      if (inspection[2] === 'a werewolf') state.knownWolf = inspection[1]
      return 'noted.'
    }
    // NIGHT branches take precedence over the role-ack: a later turn of the
    // same pairwise session re-shows earlier traffic as context, and the
    // delivered night call must win. The ack itself fires once per session.
    if (/pack lead tonight/.test(delivered)) {
      const targets = listAfter(delivered, 'Targets')
      if (!targets[0]) return report(binding, sessionId, text, 'No targets tonight.')
      return report(binding, sessionId, text, `We kill ${targets[0]} tonight.`)
    }
    if (/Do you agree, or counter\?/.test(delivered)) {
      return report(binding, sessionId, text, 'I agree.')
    }
    if (/you inspect tonight/.test(delivered)) {
      const living = listAfter(delivered, 'Living').filter((alias) => alias !== deps.alias)
      return report(binding, sessionId, text, living[0] ? `I inspect ${living[0]} tonight.` : 'No one to inspect.')
    }
    if (/you protect tonight/.test(delivered)) {
      const living = listAfter(delivered, 'Living')
      return report(binding, sessionId, text, living[0] ? `I protect ${living[0]} tonight.` : 'No one to protect.')
    }
    if (/Werewolf role assignment\./.test(delivered) && role?.[1] === deps.alias && !ackedSessions.has(sessionId)) {
      ackedSessions.add(sessionId)
      return report(binding, sessionId, text, `ROLE-ACK: ${deps.alias}`)
    }

    // ── the shared conversation session ──
    const opening = /DAY (\d+)\..*?Speaking order: ([^.\n]+)\./s.exec(text)
    if (opening) {
      days.set(sessionId, {
        round: Number(opening[1]),
        order: opening[2]!
          .split('→')
          .map((entry) => entry.trim())
          .filter(Boolean),
        stage: 'discussion',
        living: [],
        spoke: new Set<string>(),
        votedSeen: new Set<string>()
      })
    }
    const day = days.get(sessionId)
    const vote = /VOTE (\d+)\. Discussion is closed\./.exec(text)
    if (vote && day) {
      day.stage = 'vote'
      day.living = listAfter(text, 'Living players')
    }
    if (!day) return undefined
    // Accumulate what this prompt SHOWS: who has spoken (self-identifying
    // prefix, delivered or as a transcript row) and who has voted. A player's
    // OWN committed posts are never re-shown to it, so "did I already act"
    // additionally uses a local flag — with a regeneration escape hatch: the
    // turn-final fence REPLACES the prompt with just the delta and silently
    // discards the drafted answer, so a regeneration invocation that follows
    // an invocation which just acted must act again (the draft never landed).
    for (const line of text.matchAll(/^(?:\[[^\]\n]*\]\s*)?([a-z0-9-]+):\s(.*)$/gim)) {
      const speaker = line[1]!
      if (day.order.includes(speaker)) day.spoke.add(speaker)
      if (/I vote for player-\d+/.test(line[2] ?? '')) day.votedSeen.add(speaker)
    }
    const isRegeneration = text.startsWith('(AgentConnect context update:')
    const redoDiscarded = isRegeneration && actedOnLastInvocation.get(sessionId) === true
    actedOnLastInvocation.set(sessionId, false)
    if (day.stage === 'vote') {
      if (!day.living.includes(deps.alias)) return undefined
      if (day.votedSeen.has(deps.alias)) return undefined
      if (votedRound.get(sessionId) === day.round && !redoDiscarded) return undefined
      const candidates = day.living.filter((alias) => alias !== deps.alias)
      const target =
        state.knownWolf && day.living.includes(state.knownWolf) && state.knownWolf !== deps.alias
          ? state.knownWolf
          : state.role === 'werewolf'
            ? candidates.find((alias) => alias !== state.partner)
            : candidates[0]
      if (!target) return undefined
      votedRound.set(sessionId, day.round)
      actedOnLastInvocation.set(sessionId, true)
      return `${deps.alias}: I vote for ${target}.`
    }
    const index = day.order.indexOf(deps.alias)
    if (index < 0) return undefined
    if (day.spoke.has(deps.alias)) return undefined
    if (spokeRound.get(sessionId) === day.round && !redoDiscarded) return undefined
    if (!day.order.slice(0, index).every((alias) => day.spoke.has(alias))) return undefined
    if (day.order.slice(index + 1).some((alias) => day.spoke.has(alias))) return undefined
    const suspicion =
      state.knownWolf && day.order.includes(state.knownWolf) && state.knownWolf !== deps.alias
        ? `I have a bad feeling about ${state.knownWolf}.`
        : 'nothing stands out to me yet.'
    spokeRound.set(sessionId, day.round)
    actedOnLastInvocation.set(sessionId, true)
    return `${deps.alias}: ${suspicion}`
  }
}

/** The kickoff the runner posts as the human host. */
export function hostKickoffText(): string {
  return 'Referee: begin the werewolf game now. Deliver roles privately, then run nights and days in this conversation.'
}

/** The night cue the runner posts when the referee asks for it. */
export function hostNightCueText(round: number): string {
  return `NIGHT ${round} begins. Referee: collect the night actions privately now.`
}

export { HOST_USER, NO_RESPONSE }
