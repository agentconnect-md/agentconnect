/**
 * The "night collection" scenario — the live Werewolf night-1 failure shape,
 * reproduced webchat-shaped (see the runbook topology this mirrors):
 *
 *  ONE multi-agent webchat conversation (referee + players + the human host).
 *  The host posts a night-start message; the REFEREE's conversation session
 *  issues THREE concurrent `needsReply` postless calls (wolf-A: propose;
 *  seer: inspect; doctor: protect) while other players post public filler
 *  ("Waiting.") into the conversation. Children that reply correctly
 *  (`sendMessage {sessionId}`) must wake the referee's session exactly once
 *  each, regardless of interleaved public posts; a child that answers in
 *  PROSE (headless, no tool call) is a LOST reply — the known headless-child
 *  prose-reply loss that stalled the live game (PR #905 is parked on exactly
 *  this eval coverage). The referee-mediated wolf relay (wolf-A's proposal
 *  forwarded to wolf-B, wolf-B's verdict back) is the end-to-end leg.
 *
 * The referee is a SCRIPTED subject agent acting through the REAL tool
 * surface (`sendMessage` over the daemon's MCP control socket) — never the
 * trusted referee control path. Scripted and real-model variants share this
 * module; only who plays the CHILDREN differs.
 */
import type { EvaluationEvent } from '../../packages/daemon/src/evaluation/index.js'
import type { RdWebchatPost } from '../../packages/protocol/src/index.js'
import { NO_RESPONSE, type WebchatSeat } from './webchat-fixture.js'
import type { BrainCallOutcome, BrainTurn, ScriptedBrain } from './webchat-referee.js'

export const NIGHT_ALIASES = ['referee', 'wolf-a', 'wolf-b', 'seer', 'doctor', 'villager'] as const

/** The reply markers each child is instructed to lead its report with. The
 *  referee (and the scoring) recognize replies by marker, never by uuid. */
export const MARKERS = {
  proposal: 'WOLF-PROPOSAL:',
  seer: 'SEER-REPORT:',
  doctor: 'DOCTOR-REPORT:',
  verdict: 'WOLF-B-VERDICT:'
} as const

export type NightMarker = keyof typeof MARKERS

export const NIGHT_START_TEXT =
  'NIGHT 1 begins. Referee: collect the night actions privately now — contact wolf-a for the kill proposal, ' +
  'the seer for an inspection, and the doctor for a protection, all at the same time. Everyone else: you may ' +
  'chat here while the referee works.'

/** One needsReply call the referee issued, with its delivery verdict. */
export interface IssuedCall {
  to: string
  purpose: NightMarker
  needsReply: boolean
  delivered: boolean
  targetSession?: string
  error?: string
}

export interface NightCollectionRefereeConfig {
  wolfA: WebchatSeat
  wolfB: WebchatSeat
  seer: WebchatSeat
  doctor: WebchatSeat
}

const instruction = (task: string, marker: string): string =>
  `${task} Answer with a single line that starts exactly with \`${marker}\` — nothing before it. ` +
  `Do not contact anyone else and do not post anywhere.`

/**
 * The deterministic referee brain. Wake-driven only (a model referee has no
 * timers either): the night calls go out on the host's night-start wake, the
 * wolf-B relay goes out on the wolf-A proposal wake, and the closing public
 * post rides the wolf-B verdict wake. Idempotent under coalesced/regenerated
 * prompts — every trigger fires at most once.
 */
export class NightCollectionReferee implements ScriptedBrain {
  readonly issued: IssuedCall[] = []
  /** Marker → number of onPrompt() calls whose text contained the reply. */
  readonly markerSightings = new Map<NightMarker, number>()
  private nightIssued = false
  private relayIssued = false
  private closed = false
  private pendingPurposes: NightMarker[] = []

  constructor(private readonly cfg: NightCollectionRefereeConfig) {}

  onPrompt(text: string): BrainTurn {
    const calls: BrainTurn['calls'] = []
    let reply = NO_RESPONSE
    for (const marker of Object.keys(MARKERS) as NightMarker[]) {
      if (text.includes(MARKERS[marker])) {
        this.markerSightings.set(marker, (this.markerSightings.get(marker) ?? 0) + 1)
      }
    }
    if (!this.nightIssued && /NIGHT 1 begins/.test(text)) {
      this.nightIssued = true
      this.pendingPurposes = ['proposal', 'seer', 'doctor']
      calls.push(
        this.needsReplyCall(
          this.cfg.wolfA,
          'proposal',
          instruction('Night 1: as werewolf lead, state your kill proposal for tonight.', MARKERS.proposal)
        ),
        this.needsReplyCall(
          this.cfg.seer,
          'seer',
          instruction('Night 1: name the one player you inspect tonight.', MARKERS.seer)
        ),
        this.needsReplyCall(
          this.cfg.doctor,
          'doctor',
          instruction('Night 1: name the one player you protect tonight.', MARKERS.doctor)
        )
      )
    }
    if (!this.relayIssued && text.includes(MARKERS.proposal)) {
      this.relayIssued = true
      const line = text.split('\n').find((candidate) => candidate.includes(MARKERS.proposal)) ?? MARKERS.proposal
      calls.push(
        this.needsReplyCall(
          this.cfg.wolfB,
          'verdict',
          instruction(`Your fellow wolf proposes: "${line.trim()}". Do you agree, or counter?`, MARKERS.verdict)
        )
      )
    }
    if (!this.closed && text.includes(MARKERS.verdict)) {
      this.closed = true
      reply = 'The night is resolved.'
    }
    return { calls, reply }
  }

  onCallResult(outcome: BrainCallOutcome): void {
    const toAgentId = (outcome.args.toAgent as { agentId?: string } | undefined)?.agentId
    const row = this.issued.find((candidate) => candidate.to === toAgentId && !this.settled.has(candidate))
    if (!row) return
    this.settled.add(row)
    const parsed = parseToolResult(outcome.result)
    row.delivered = outcome.ok && parsed?.delivered !== false
    if (parsed?.targetSession !== undefined) row.targetSession = String(parsed.targetSession)
    if (!outcome.ok && outcome.error !== undefined) row.error = outcome.error
  }

  private readonly settled = new Set<IssuedCall>()

  private needsReplyCall(seat: WebchatSeat, purpose: NightMarker, message: string): BrainTurn['calls'][number] {
    this.issued.push({ to: seat.agentId, purpose, needsReply: true, delivered: false })
    return {
      tool: 'sendMessage',
      args: { toAgent: { agentId: seat.agentId, needsReply: true }, message }
    }
  }
}

function parseToolResult(result: unknown): Record<string, unknown> | undefined {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const content = (result as { content?: { type?: string; text?: string }[] }).content
    if (Array.isArray(content)) {
      const text = content.find((block) => block?.type === 'text')?.text
      if (typeof text === 'string') {
        try {
          return JSON.parse(text) as Record<string, unknown>
        } catch {
          return undefined
        }
      }
    }
    return result as Record<string, unknown>
  }
  if (typeof result === 'string') {
    try {
      return JSON.parse(result) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  return undefined
}

// ── scoring ────────────────────────────────────────────────────────────────

export type ReplyMode = 'own-turn' | 'coalesced' | 'lost'

/**
 * The two shapes a child reply takes inside a referee prompt, and why the
 * distinction is load-bearing:
 *
 *  - DELIVERED form — the reply body as the wake's own message (a raw line
 *    starting with the marker, or `From <agent>: MARKER …`). One of these in a
 *    `turn.started` input means the reply STARTED that referee turn.
 *  - CONTEXT-ROW form — `[<sender>] MARKER …`, a shared-transcript row shown
 *    by a context refresh. This is how a reply that was COALESCED into an
 *    in-flight referee turn is represented (its queued wake is absorbed, the
 *    regenerated turn input carries the row), and also how LATER turns re-show
 *    catch-up context — which is why context rows never count as wakes.
 */
export interface ReplyOutcome {
  child: string
  marker: NightMarker
  /** 'own-turn': a referee turn started on the delivered reply; 'coalesced':
   *  no turn started on it, but a referee turn's input carried it (context
   *  row of a coalesced wake); 'lost': the referee never saw it at all — the
   *  headless prose-reply loss. */
  mode: ReplyMode
  /** Referee `turn.started` inputs carrying the DELIVERED form. Must be ≤ 1. */
  ownTurnStarts: number
  /** Referee prompt deliveries (incl. regenerations) with the delivered form. */
  deliveredPromptSightings: number
  /** Referee prompt deliveries carrying the context-row form. */
  contextRowSightings: number
  /** Whether the reply body surfaced as a committed conversation post — the
   *  #926 agent-wake inbound live post. Recorded, since it means a "private"
   *  needsReply report is visible to the whole conversation on current main. */
  postedPublicly: boolean
}

export interface NightCollectionScore {
  replies: ReplyOutcome[]
  lost: string[]
  /** Public filler posts observed during the night. */
  fillerPosts: number
  /** The referee's closing public post landed. */
  nightResolvedPosted: boolean
}

export interface ScoreInputs {
  events: readonly EvaluationEvent[]
  /** Every prompt text delivered to the referee host/puppet, in order. */
  refereePrompts: readonly string[]
  posts: readonly RdWebchatPost[]
  refereeAgentId: string
  children: { alias: string; marker: NightMarker }[]
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The delivered-wake form: the reply body as its own message. */
export function deliveredFormPattern(marker: NightMarker): RegExp {
  return new RegExp(`^(?:From [^:\\n]+: ?)?${escapeRegExp(MARKERS[marker])}`, 'm')
}

/** The context-row form: a shared-transcript row shown by a context refresh. */
export function contextRowPattern(marker: NightMarker): RegExp {
  return new RegExp(`^\\[[^\\]\\n]+\\] ?${escapeRegExp(MARKERS[marker])}`, 'm')
}

export function scoreNightCollection(inputs: ScoreInputs): NightCollectionScore {
  const refereeTurnInputs = inputs.events
    .filter((event) => event.type === 'turn.started' && event.agentId === inputs.refereeAgentId)
    .map((event) => String(event.data.input ?? ''))
  const replies: ReplyOutcome[] = inputs.children.map(({ alias, marker }) => {
    const token = MARKERS[marker]
    const delivered = deliveredFormPattern(marker)
    const contextRow = contextRowPattern(marker)
    const ownTurnStarts = refereeTurnInputs.filter((input) => delivered.test(input)).length
    const deliveredPromptSightings = inputs.refereePrompts.filter((text) => delivered.test(text)).length
    const contextRowSightings = inputs.refereePrompts.filter((text) => contextRow.test(text)).length
    const mode: ReplyMode =
      ownTurnStarts > 0 ? 'own-turn' : deliveredPromptSightings + contextRowSightings > 0 ? 'coalesced' : 'lost'
    const postedPublicly = inputs.posts.some((post) => post.agentId !== 'host' && post.post.text.includes(token))
    return { child: alias, marker, mode, ownTurnStarts, deliveredPromptSightings, contextRowSightings, postedPublicly }
  })
  return {
    replies,
    lost: replies.filter((reply) => reply.mode === 'lost').map((reply) => reply.child),
    fillerPosts: inputs.posts.filter((post) => post.agentId !== 'host' && /^Waiting\./.test(post.post.text)).length,
    nightResolvedPosted: inputs.posts.some(
      (post) => post.agentId === inputs.refereeAgentId && post.post.text.includes('The night is resolved.')
    )
  }
}
