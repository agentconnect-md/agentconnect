/**
 * Runner for webchat Werewolf (`webchat-werewolf.ts`): boots the webchat
 * arena, plays the human HOST (kickoff + the night cues the referee asks
 * for), lets the wake-driven referee brain and the players carry everything
 * else, and assembles the verdict from the daemon's own records.
 *
 * The host loop is REACTIVE, mirroring the live runbook: the host posts the
 * kickoff, then only ever answers the referee's explicit public asks
 * ("HOST: please open night N."). Each cue is a trusted human turn, which is
 * also what keeps every round's continuation chain inside the webchat hop
 * budget (the same reason the live game's host paces the phases).
 *
 * A run that stops advancing is an HONEST STALL, not an error: with PR #905
 * parked, a real child answering its needsReply delegation in prose never
 * wakes the referee again — the runner records where the game stood
 * (`stalledAt`) and which needsReply calls never came back (`replyLoss`).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, redactEvaluationValue } from '../../packages/daemon/src/evaluation/index.js'
import { callDaemonTool } from './mcp-client.js'
import { PuppetDriver } from './puppet.js'
import { preflightRealSubject } from './subject.js'
import {
  WebchatArena,
  agentReplyWakeEvidence,
  mintSeats,
  prepareRealWebchatRoot,
  prepareScriptedWebchatRoot,
  type WebchatSeat
} from './webchat-fixture.js'
import { executeBrainTurn, parentSessionIdOf, scriptedWebchatHostFactory } from './webchat-referee.js'
import type { PromptLogEntry, ScriptedSessionHandler } from './webchat-referee.js'
import {
  GAME_OVER_PATTERN,
  HOST_CUE_PATTERN,
  ROUND_LIMIT_PATTERN,
  VOTE_NUDGE_TEXT,
  WebchatWerewolfReferee,
  hostKickoffText,
  hostNightCueText,
  scriptedWebchatPlayer,
  type NeedsReplyLogRow,
  type WebchatDayRecord,
  type WebchatNightRecord
} from './webchat-werewolf.js'
import type { WerewolfRole } from './werewolf-rules.js'

export interface WebchatWerewolfRunOptions {
  seed: number
  playerCount?: number
  maxRounds?: number
  /** Scripted subjects only: aliases that ignore the public VOTE call and
   *  answer only the referee's private re-prompt (the re-prompt lever's CI
   *  cell — scripted vote reticence). */
  scriptedAbstainers?: readonly string[]
  subject?: { kind: 'scripted' } | { kind: 'real'; subjectRoot: string; templateAgentIds: string[] }
  /** Whole-run budget. Scripted default 180s; real default 30min. */
  budgetMs?: number
  /** Quiet window the settle barrier uses between host-loop passes. */
  quietMs?: number
  artifactDir?: string
}

export interface WebchatWerewolfRunResult {
  terminalReason: 'completed' | 'round_limit' | 'stalled' | 'budget_exhausted'
  winner?: 'village' | 'werewolves'
  rounds: number
  roles: Record<string, WerewolfRole>
  survivors: string[]
  nights: WebchatNightRecord[]
  days: WebchatDayRecord[]
  /** Every needsReply call the referee issued, with whether an answer ever
   *  came back — the pending rows of a finished run ARE the reply losses. */
  replyLoss: (Omit<NeedsReplyLogRow, 'to'> & { to: string })[]
  /** Admitted `sendMessage {sessionId}` reply wakes at the referee — the
   *  daemon-side ground truth for `answered` rows. The brain also absorbs
   *  #926 public-copy CONTEXT rows (a model referee reads the room too), so
   *  the CI gate asserts this count equals the answered rows: an `answered`
   *  verdict fed only by a context echo of a DROPPED wake cannot pass. */
  replyWakesAccepted: number
  /** Of those, wakes coalesced into an in-flight referee turn. */
  replyWakesCoalesced: number
  /** Canary strings observed in the shared conversation (posts or transcript).
   *  Must be zero: canaries ride only the private role calls. */
  canaryLeaks: number
  /** Committed conversation posts whose text is a private needsReply REPORT
   *  body (role acks / night statements) — the #926 surface: on current main
   *  a child's reply into a conversation-origin parent session is posted live
   *  into the conversation view, so webchat "private" night traffic is
   *  visible to the whole room. Measured, not failed. */
  privateReportsPostedPublicly: number
  /** Scripted subjects only: canary sightings in prompts of players whose ROLE
   *  does not hold that canary (wolf canary outside the wolves, seer canary
   *  outside the seer) — the #967 pairwise-transcript regression probe. Every
   *  prompt of every player session (conversation + pairwise) is scanned.
   *  Undefined for real subjects (their prompts are not observable). */
  canaryCrossVisibility?: number
  stalledAt?: string
  posts: { author: string; text: string }[]
}

const NIGHT_REPORT_SHAPES = [
  /^ROLE-ACK: player-\d+/,
  /\bkill player-\d+\b|\bkill\b.*\btonight\b/i,
  /^I agree\./,
  /\bI inspect player-\d+/i,
  /\bI protect player-\d+/i
]

export async function runWebchatWerewolf(options: WebchatWerewolfRunOptions): Promise<WebchatWerewolfRunResult> {
  const playerCount = options.playerCount ?? 5
  const subjectSpec = options.subject ?? { kind: 'scripted' as const }
  const budgetMs = options.budgetMs ?? (subjectSpec.kind === 'scripted' ? 180_000 : 30 * 60_000)
  const quietMs = options.quietMs ?? (subjectSpec.kind === 'scripted' ? 900 : 15_000)
  const playerAliases = Array.from({ length: playerCount }, (_, index) => `player-${index + 1}`)
  const seats = mintSeats(['referee', ...playerAliases])
  const refereeSeat = seats[0]!
  const playerSeats = seats.slice(1)
  const aliasOf = (agentId: string) => seats.find((seat) => seat.agentId === agentId)?.alias ?? agentId
  const brain = new WebchatWerewolfReferee({
    seed: options.seed,
    players: playerSeats,
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {})
  })

  const log: PromptLogEntry[] = []
  let driver: PuppetDriver | undefined
  let subject: { root: string; secrets: string[]; cleanup: () => void }
  let hostFactory: ReturnType<typeof scriptedWebchatHostFactory> | undefined
  if (subjectSpec.kind === 'scripted') {
    const handlers = new Map<string, ScriptedSessionHandler>()
    handlers.set(refereeSeat.agentId, async ({ text, binding }) => {
      const { reply } = await executeBrainTurn(brain, binding, text)
      return reply
    })
    for (const seat of playerSeats) {
      const player = scriptedWebchatPlayer({
        alias: seat.alias,
        callTool: callDaemonTool,
        parentSessionIdOf,
        ...(options.scriptedAbstainers?.includes(seat.alias) ? { abstainPublicVote: true } : {})
      })
      handlers.set(seat.agentId, ({ sessionId, text, binding }) => player({ sessionId, text, binding }))
    }
    hostFactory = scriptedWebchatHostFactory(handlers, log)
    subject = prepareScriptedWebchatRoot(seats)
  } else {
    driver = new PuppetDriver()
    await driver.start()
    driver.useBrain(brain)
    subject = prepareRealWebchatRoot(seats, {
      subjectRoot: subjectSpec.subjectRoot,
      templateAgentIds: subjectSpec.templateAgentIds,
      refereeAlias: 'referee',
      puppetEndpoint: driver.endpoint
    })
  }

  const arena = new WebchatArena({
    root: subject.root,
    seats,
    secrets: subject.secrets,
    ...(hostFactory ? { hostFactory: hostFactory as never } : {})
  })
  const deadline = Date.now() + budgetMs
  let terminalReason: WebchatWerewolfRunResult['terminalReason'] = 'stalled'
  let transcriptTexts: string[] = []
  try {
    if (subjectSpec.kind === 'real') await preflightRealSubject(subject.root)
    await arena.start()
    arena.postHost(hostKickoffText(), { mentions: ['referee'] })

    const answeredCues = new Set<number>()
    const voteNudgesByRound = new Map<number, number>()
    let lastProgressPosts = -1
    while (Date.now() < deadline) {
      const settled = await arena.settleOrStall({
        quietMs,
        timeoutMs: Math.max(5_000, Math.min(deadline - Date.now(), budgetMs))
      })
      // React to the referee's public asks, newest state first.
      const refereePosts = arena.posts.filter((post) => post.agentId === refereeSeat.agentId)
      const over = refereePosts.some(
        (post) => GAME_OVER_PATTERN.test(post.post.text) || ROUND_LIMIT_PATTERN.test(post.post.text)
      )
      if (over || brain.phase === 'done') {
        terminalReason = brain.terminalReason ?? 'stalled'
        break
      }
      let acted = false
      for (const post of refereePosts) {
        const cue = HOST_CUE_PATTERN.exec(post.post.text)
        if (cue) {
          const round = Number(cue[1])
          if (!answeredCues.has(round)) {
            answeredCues.add(round)
            arena.postHost(hostNightCueText(round), { mentions: ['referee'] })
            acted = true
          }
        }
      }
      if (acted) continue
      if (settled) {
        // A quiet vote is not yet a stall: the host nudges the referee (the
        // human-moderator mirror) — first nudge triggers the individual
        // re-prompts of the missing voters, the second closes the ballot with
        // abstentions. At most two nudges per round.
        if (brain.phase === 'day-vote' && (voteNudgesByRound.get(brain.round) ?? 0) < 2) {
          voteNudgesByRound.set(brain.round, (voteNudgesByRound.get(brain.round) ?? 0) + 1)
          arena.postHost(VOTE_NUDGE_TEXT, { mentions: ['referee'] })
          continue
        }
        // Fully drained, nothing to answer, game not done: the honest stall.
        if (arena.posts.length === lastProgressPosts) break
        lastProgressPosts = arena.posts.length
        // One grace pass: a wave may have landed between settle and the scan.
        continue
      }
    }
    if (brain.phase !== 'done' && terminalReason === 'stalled' && Date.now() >= deadline) {
      terminalReason = 'budget_exhausted'
    }
    transcriptTexts = (await arena.transcriptRows()).map((row) => row.text)
  } finally {
    await arena.stop().catch(() => {})
    await driver?.stop().catch(() => {})
  }

  const posts = arena.posts.map((post) => ({ author: aliasOf(post.agentId), text: post.post.text }))
  const wakeEvidence = agentReplyWakeEvidence(arena.events(), refereeSeat.agentId)
  // #967 regression probe (scripted only — real players' prompts are not
  // observable): a role canary must never surface in a prompt of a player
  // whose role does not hold it, on ANY of that player's sessions.
  let canaryCrossVisibility: number | undefined
  if (subjectSpec.kind === 'scripted') {
    canaryCrossVisibility = 0
    for (const seat of playerSeats) {
      const role = brain.roleOf(seat.alias)
      const promptTexts = log.filter((entry) => entry.agentId === seat.agentId).map((entry) => entry.text)
      for (const text of promptTexts) {
        if (role !== 'werewolf' && text.includes(brain.canaries.wolf)) canaryCrossVisibility += 1
        if (role !== 'seer' && text.includes(brain.canaries.seer)) canaryCrossVisibility += 1
      }
    }
  }
  const canaryLeaks = [...posts.map((post) => post.text), ...transcriptTexts].filter(
    (text) => text.includes(brain.canaries.wolf) || text.includes(brain.canaries.seer)
  ).length
  const privateReportsPostedPublicly = posts.filter(
    (post) => post.author.startsWith('player-') && NIGHT_REPORT_SHAPES.some((pattern) => pattern.test(post.text.trim()))
  ).length

  const result: WebchatWerewolfRunResult = {
    terminalReason,
    ...(brain.winner !== undefined ? { winner: brain.winner } : {}),
    rounds: brain.round,
    roles: Object.fromEntries(brain.roles),
    survivors: brain.aliveAliases(),
    nights: brain.nights,
    days: brain.days,
    replyLoss: brain.needsReplyLog.map((row) => ({ ...row, to: aliasOf(row.to) })),
    replyWakesAccepted: wakeEvidence.accepted.size,
    replyWakesCoalesced: wakeEvidence.coalesced.size,
    ...(canaryCrossVisibility !== undefined ? { canaryCrossVisibility } : {}),
    canaryLeaks,
    privateReportsPostedPublicly,
    ...(terminalReason === 'stalled' || terminalReason === 'budget_exhausted' ? { stalledAt: brain.stallState() } : {}),
    posts
  }

  if (options.artifactDir) {
    mkdirSync(options.artifactDir, { recursive: true, mode: 0o700 })
    arena.eventCollector().writeJsonl(join(options.artifactDir, 'events.jsonl'))
    atomicWrite(
      join(options.artifactDir, 'game-result.json'),
      `${JSON.stringify(redactEvaluationValue(result, subject.secrets), null, 2)}\n`
    )
    const refereePrompts =
      subjectSpec.kind === 'scripted'
        ? log.filter((entry) => entry.agentId === refereeSeat.agentId).map((entry) => entry.text)
        : (driver?.promptLog.map((entry) => entry.text) ?? [])
    atomicWrite(
      join(options.artifactDir, 'referee-prompts.json'),
      `${JSON.stringify(redactEvaluationValue(refereePrompts, subject.secrets), null, 2)}\n`
    )
  }
  subject.cleanup()
  return result
}

export type { WebchatSeat }
