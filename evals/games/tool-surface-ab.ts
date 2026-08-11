/**
 * Tool-surface A/B: the landed `sendMessage` against the `post` façade.
 *
 * The two arms are identical in every respect except the tool surface the model
 * carries — same model, same topology, same seeds, same task text. Arm A gets
 * the product `sendMessage`; arm B gets `post` (§ post-facade.ts) with
 * `sendMessage` withheld from the descriptor list. Because the façade compiles
 * down to and is executed by `sendMessage`, both arms exercise one
 * implementation, so any difference is attributable to the surface.
 *
 * WHAT IS MEASURED, and why this shape. Every task here is one explicit send
 * whose correct product form is known in advance. So each tool call can be
 * classified into the same six-form vocabulary for both arms, which makes
 * "did the agent address this correctly, first try" comparable rather than
 * arm-specific. The tasks describe the GOAL and never name a tool, a field or a
 * form — naming them would test instruction-following, not the surface.
 */
import type { EvaluationToolDefinition } from '../../packages/daemon/src/evaluation/index.js'

export type SendForm =
  'agent-channel' | 'agent-postless' | 'user-dm' | 'user-channel' | 'channel-bare' | 'parent-session' | 'unclassifiable'

/** The four scenarios of the reduced matrix, each a single explicit send. */
export interface AbScenario {
  id: string
  /** The product form a correct attempt must produce. */
  expected: SendForm
  /** Task text, delivered as trusted referee control. Names no tool and no field. */
  instruction(ids: { peerAgentId: string; channel: string; humanUserId: string }): string
  /** Scenario 4 needs a real parent session, created by a scripted caller. */
  needsCaller?: boolean
}

export const AB_SCENARIOS: AbScenario[] = [
  {
    id: 'agent-channel',
    expected: 'agent-channel',
    instruction: ({ peerAgentId, channel }) =>
      `Open a fresh discussion in channel ${channel} that the people there can see, and pull agent ` +
      `${peerAgentId} into that same discussion so it replies in the same place. Say: "status check please".`
  },
  {
    id: 'channel-bare',
    expected: 'channel-bare',
    instruction: ({ channel }) =>
      `Publish the announcement "deploy finished" so it is visible in channel ${channel}. Nobody should be woken ` +
      `up by it and nobody should be notified — it is a notice for people to read later.`
  },
  {
    id: 'agent-postless',
    expected: 'agent-postless',
    instruction: ({ peerAgentId }) =>
      `Ask agent ${peerAgentId} privately for its current status, and make sure its answer comes back to you. ` +
      `Nothing at all may become visible in any channel — this exchange must leave no trace anyone else can read.`
  },
  {
    id: 'parent-session',
    expected: 'parent-session',
    needsCaller: true,
    // Relayed to the subject INSIDE a needsReply wake by the caller agent, so
    // the subject really does have a parent session to answer into.
    instruction: () =>
      `What is the sum of 17 and 25? Work it out and get your answer back to whoever is asking you, so it ` +
      `reaches them directly. Do not publish the answer anywhere public.`
  }
]

/** Classify one attempted send into the shared form vocabulary. Used for BOTH
 *  arms: arm A's raw `sendMessage` args and arm B's compiled args. */
export function classifySendForm(args: Record<string, unknown> | undefined): SendForm {
  if (!args) return 'unclassifiable'
  const hasChannel = typeof args.channel === 'string' && args.channel !== ''
  if (args.sessionId !== undefined) return 'parent-session'
  if (args.toAgent !== undefined) return hasChannel ? 'agent-channel' : 'agent-postless'
  if (args.toUser !== undefined) return hasChannel ? 'user-channel' : 'user-dm'
  if (hasChannel) return 'channel-bare'
  return 'unclassifiable'
}

/** One attempted tool call, as reconstructed from the ACP event stream. */
export interface AbAttempt {
  tool: string
  args?: Record<string, unknown>
  form: SendForm
  failed: boolean
  error?: string
}

export interface AbTokenBreakdown {
  total: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface AbTrialMetrics {
  attempts: AbAttempt[]
  /** Calls the surface itself refused: schema violation or illegal combination. */
  invalidCalls: number
  /** Did the FIRST attempt produce the expected form and not fail? */
  firstAttemptSuccess: boolean
  /** Did any attempt eventually produce the expected form and not fail? */
  completed: boolean
  /** Attempts needed to reach the first correct, non-failing call (0 if never). */
  attemptsToSuccess: number
  toolCalls: number
  totalTokens: number
  /** Component sums over the same turns as `totalTokens`. Cache traffic
   *  dominates a local run, so input+output is reported alongside the total. */
  tokens: AbTokenBreakdown
  turns: number
  latencyMs: number
}

interface AcpToolEvent {
  toolCallId?: string
  title?: string
  status?: string
  rawInput?: unknown
  content?: unknown
  _meta?: { claudeCode?: { toolName?: string } }
  sessionUpdate?: string
}

/**
 * Reconstruct one trial's attempts from the recorded evaluation events.
 *
 * ACP reports a tool call across several updates (pending → args → result), so
 * attempts are folded by `toolCallId` and only the final state of each is
 * scored. A call is `failed` when its terminal status says so — that is how
 * both a schema violation and a product refusal surface, which is exactly the
 * comprehensibility signal.
 */
export function extractTrialMetrics(
  events: { type: string; data: Record<string, unknown> }[],
  options: {
    toolName: string
    expected: SendForm
    latencyMs: number
    /** Arm-specific bridge from raw tool input to the shared form vocabulary.
     *  Arm A classifies the product args directly (default); arm B compiles the
     *  façade input first, so both arms are scored on the SAME product shapes. */
    classify?: (args: Record<string, unknown> | undefined) => SendForm
  }
): AbTrialMetrics {
  const classify = options.classify ?? classifySendForm
  const byId = new Map<string, AbAttempt>()
  const order: string[] = []
  const tokens: AbTokenBreakdown = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let turns = 0
  for (const event of events) {
    if (event.type === 'turn.completed') {
      turns += 1
      const usage = event.data.usage as Record<string, unknown> | undefined
      const add = (key: keyof AbTokenBreakdown, field: string) => {
        const value = usage?.[field]
        if (typeof value === 'number' && Number.isFinite(value)) tokens[key] += value
      }
      add('total', 'totalTokens')
      add('input', 'inputTokens')
      add('output', 'outputTokens')
      add('cacheRead', 'cachedReadTokens')
      add('cacheWrite', 'cachedWriteTokens')
      continue
    }
    if (event.type !== 'acp.update') continue
    const update = event.data.update as AcpToolEvent | undefined
    if (!update) continue
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
    const name = update._meta?.claudeCode?.toolName ?? update.title
    const id = update.toolCallId
    if (typeof id !== 'string') continue
    // Only the surface under test counts as an attempt.
    const isSubject = typeof name === 'string' && name.toLowerCase().includes(options.toolName.toLowerCase())
    if (!isSubject && !byId.has(id)) continue
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { tool: String(name), form: 'unclassifiable', failed: false })
      order.push(id)
    }
    const attempt = byId.get(id)!
    if (update.rawInput && typeof update.rawInput === 'object' && Object.keys(update.rawInput).length > 0) {
      attempt.args = update.rawInput as Record<string, unknown>
      attempt.form = classify(attempt.args)
    }
    if (update.status === 'failed') {
      attempt.failed = true
      const text = JSON.stringify(update.content ?? '')
      attempt.error = text.slice(0, 300)
    }
    if (update.status === 'completed') attempt.failed = false
  }
  const attempts = order.map((id) => byId.get(id)!)
  const successIndex = attempts.findIndex((attempt) => !attempt.failed && attempt.form === options.expected)
  return {
    attempts,
    invalidCalls: attempts.filter((attempt) => attempt.failed).length,
    firstAttemptSuccess: successIndex === 0,
    completed: successIndex >= 0,
    attemptsToSuccess: successIndex >= 0 ? successIndex + 1 : 0,
    toolCalls: attempts.length,
    totalTokens: tokens.total,
    tokens,
    turns,
    latencyMs: options.latencyMs
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — in-thread turn-taking conversation (the #801 regression gate).
//
// The four send scenarios above each demand ONE explicit send, so a prompt
// change that made the model over-use the messaging surface could pass the
// whole matrix while breaking ordinary thread play. That is exactly what
// happened with the #801 tool-precedence bullet (validated only against
// parent-session, 10/10): in a live channel counting game the agent started
// routing every in-thread turn through `sendMessage` to "hand off" the next
// number to its peer, posting meta-narration into the thread with skipped and
// duplicated numbers. #801 was reverted (#861); issue #800 records the lesson.
//
// This scenario is the missing coverage: one channel thread, TWO subject
// agents on the arm's surface, a human kickoff @-mentioning both, and the
// agents then take turns counting via ORDINARY replies (the #549 continuation
// ladder — each delivered reply echoes back and wakes the peer). The correct
// number of messaging-tool calls here is ZERO: in-thread speech is the
// ordinary turn reply, by product convention (`sendMessage` deliberately has
// no in-thread form).
// ─────────────────────────────────────────────────────────────────────────────

/** Small on purpose: enough replies to prove sustained turn-taking, cheap
 *  enough to run 2 arms × 3 trials routinely as a prompt-change gate. */
export const THREAD_COUNT_TARGET = 6

export const THREAD_COUNT_SCENARIO = {
  id: 'in-thread-count',
  target: THREAD_COUNT_TARGET,
  /** Kickoff, spoken by a HUMAN into the shared thread, @-mentioning both
   *  participants. Names no tool, no field, no form — the same
   *  banned-vocabulary rule as the send scenarios covers this text. */
  instruction: (mentions: { first: string; second: string }) =>
    `${mentions.first} ${mentions.second} Let's count together right here in this thread, taking turns. ` +
    `Each turn is one reply in this thread containing ONLY the next number — nothing else, no commentary. ` +
    `Start at 1. Do not repeat a number that is already in the thread, and after you contribute one, let the ` +
    `other participant take the next one. Stop once ${THREAD_COUNT_TARGET} has appeared.`
}

/** Is this tool name a messaging tool, on ANY surface the session might carry?
 *  Covers the product `sendMessage` (`mcp__agentconnect__sendMessage`), the
 *  arm-B façade `post` under EVERY runtime-assigned ACP identity — bare
 *  `post`, underscore-flattened `mcp__agentconnect__post`, and the dotted
 *  `mcp.agentconnect.post` the daemon equally supports (daemon.ts FQN
 *  matching) — and the Claude Code runtime's own built-in `SendMessage` (the
 *  #800 name-collision hazard). During the in-thread game every one of them
 *  is the #801 failure mode. Matching is by BOUNDED name segment: some ACP
 *  adapters suffix an opaque invocation id to the flattened FQN (daemon.ts
 *  `containsBuiltinToolFqn`, e.g. `mcp__agentconnect__post-42`), so `post`
 *  must match wherever it appears as its own separator-delimited segment —
 *  while `compost`/`postpone` never do. The gate's bias is deliberate: an
 *  over-match makes a reviewable FAIL, an under-match a silent false PASS. */
export function isMessagingToolName(name: string): boolean {
  const normalized = name.toLowerCase()
  if (normalized.includes('sendmessage')) return true
  return /(^|[^a-z0-9])post([^a-z0-9]|$)/.test(normalized)
}

export interface ThreadCountEffect {
  sequence: number
  kind: string
  status: string
  channel: string
  thread?: string
  agentId?: string
  text: string
}

export interface ThreadCountMessagingCall {
  agentId?: string
  tool: string
  failed: boolean
}

export interface ThreadCountVerdict {
  /** The hard verdict. Fail reasons are enumerated in `failures`. */
  pass: boolean
  failures: string[]
  /** Highest number ≤ target seen in a delivered participant thread reply. */
  reached: number
  target: number
  /** First integer of each delivered participant thread reply that carries
   *  one, in delivery order — the visible count as the thread saw it. */
  numbersPosted: number[]
  /** HARD RULE: every messaging-tool call by any participant during the game
   *  (any surface, delivered or refused). One is the #801 failure mode. */
  messagingToolCalls: ThreadCountMessagingCall[]
  /** Participant thread replies the world refused to deliver. */
  lostMessages: number
  // ── soft metrics: reported, never failed on ──
  duplicates: number
  skips: number
  /** Numbers posted beyond the stop target. */
  overshoot: number
  /** Delivered participant replies in the thread (numbered or not). */
  replies: number
  /** Replies that are just the number (markdown emphasis/punctuation allowed). */
  bareNumberReplies: number
  /** Replies carrying a number plus prose — the meta-narration signal
   *  ("Handing off for 5"-style). */
  metaNarrationReplies: number
  meanReplyChars: number
  /** Participant completed turns per counted number. */
  turnsPerNumber: number
}

interface ThreadCountJudgeOptions {
  target: number
  /** The two subject agents' ids. */
  participants: readonly string[]
  channel: string
  /** Root message id of the kickoff thread. */
  thread: string
  /** The world's recorded outbound effects, in sequence order. */
  effects: readonly ThreadCountEffect[]
  /** The daemon's evaluation events (all agents). */
  events: readonly { type: string; agentId?: string; data: Record<string, unknown> }[]
}

/**
 * Judge one in-thread turn-taking trial from the daemon's records, never the
 * models' claims — same philosophy as the send scenarios.
 *
 * Hard pass: the count reached the target via ordinary delivered thread
 * replies, ZERO messaging-tool calls by any participant during the game (a
 * call with a legitimate non-thread purpose has no reason to occur in this
 * scenario, so the rule stays simple: any messaging-tool call = fail), and no
 * participant reply was lost (rejected by the world).
 *
 * Soft (reported, not failed on): duplicated and skipped numbers, overshoot
 * past the stop target, meta-narration beyond the bare number, reply length,
 * turns per number.
 */
export function judgeThreadCount(options: ThreadCountJudgeOptions): ThreadCountVerdict {
  const participants = new Set(options.participants)

  // ── messaging-tool calls, folded by toolCallId across ACP updates ──
  const callById = new Map<string, ThreadCountMessagingCall>()
  const callOrder: string[] = []
  let participantTurns = 0
  for (const event of options.events) {
    if (event.agentId === undefined || !participants.has(event.agentId)) continue
    if (event.type === 'turn.completed') {
      participantTurns += 1
      continue
    }
    if (event.type !== 'acp.update') continue
    const update = event.data.update as
      | {
          sessionUpdate?: string
          toolCallId?: string
          title?: string
          status?: string
          _meta?: { claudeCode?: { toolName?: string } }
        }
      | undefined
    if (!update) continue
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
    const id = update.toolCallId
    if (typeof id !== 'string') continue
    const name = update._meta?.claudeCode?.toolName ?? update.title
    const existing = callById.get(id)
    if (!existing) {
      if (typeof name !== 'string' || !isMessagingToolName(name)) continue
      callById.set(id, { agentId: event.agentId, tool: name, failed: false })
      callOrder.push(id)
    }
    const call = callById.get(id)!
    if (update.status === 'failed') call.failed = true
    if (update.status === 'completed') call.failed = false
  }
  const messagingToolCalls = callOrder.map((id) => callById.get(id)!)

  // ── the visible thread: delivered participant replies, in order ──
  // STRICT thread match: a reply effect with no `thread` (or another thread)
  // is a channel-root post opening a DIFFERENT conversation — counting it
  // would let numbers posted outside the game thread pass the count.
  const participantThreadEffects = options.effects.filter(
    (effect) =>
      effect.kind === 'reply' &&
      effect.agentId !== undefined &&
      participants.has(effect.agentId) &&
      effect.channel === options.channel &&
      effect.thread === options.thread
  )
  const delivered = participantThreadEffects.filter((effect) => effect.status === 'delivered')
  const lostMessages = participantThreadEffects.filter((effect) => effect.status === 'rejected').length

  const numbersPosted: number[] = []
  let bareNumberReplies = 0
  let metaNarrationReplies = 0
  let replyChars = 0
  for (const effect of delivered) {
    // Digits inside platform mention tokens (`<@W123…>`) are not count signal.
    const text = effect.text.replace(/<@[^>]+>/g, '').trim()
    replyChars += text.length
    const match = /-?\d+/.exec(text)
    if (!match) continue
    numbersPosted.push(Number(match[0]))
    // Bare = the number alone, allowing markdown emphasis and punctuation.
    if (/^[*_`~\s]*-?\d+[*_`~\s.!]*$/.test(text)) bareNumberReplies += 1
    else metaNarrationReplies += 1
  }

  const occurrences = new Map<number, number>()
  for (const value of numbersPosted) occurrences.set(value, (occurrences.get(value) ?? 0) + 1)
  const reached = Math.max(0, ...numbersPosted.filter((value) => value >= 1 && value <= options.target))
  let duplicates = 0
  let skips = 0
  for (let value = 1; value <= reached; value += 1) {
    const count = occurrences.get(value) ?? 0
    if (count === 0) skips += 1
    else duplicates += count - 1
  }
  const overshoot = numbersPosted.filter((value) => value > options.target).length

  const failures: string[] = []
  if (reached < options.target) {
    failures.push(`the count reached ${reached} of ${options.target} via ordinary thread replies`)
  }
  for (const call of messagingToolCalls) {
    failures.push(`participant ${call.agentId ?? 'unknown'} called messaging tool "${call.tool}" during the game`)
  }
  if (lostMessages > 0) failures.push(`${lostMessages} participant thread repl(ies) were rejected, not delivered`)

  return {
    pass: failures.length === 0,
    failures,
    reached,
    target: options.target,
    numbersPosted,
    messagingToolCalls,
    lostMessages,
    duplicates,
    skips,
    overshoot,
    replies: delivered.length,
    bareNumberReplies,
    metaNarrationReplies,
    meanReplyChars: delivered.length === 0 ? 0 : Number((replyChars / delivered.length).toFixed(1)),
    turnsPerNumber: options.target === 0 ? 0 : Number((participantTurns / options.target).toFixed(2))
  }
}

/** Arm B's classifier: compile the façade input, then classify the product args
 *  it becomes — the symmetry that makes the two arms score identically. An
 *  input the façade refuses names no legal form. */
export function classifyPostForm(
  compile: (input: Record<string, unknown>) => { args: Record<string, unknown> },
  args: Record<string, unknown> | undefined
): SendForm {
  if (!args) return 'unclassifiable'
  try {
    return classifySendForm(compile(args).args)
  } catch {
    return 'unclassifiable'
  }
}

/** Arm B's registry: the façade, with `sendMessage` withheld. */
export function armBTools(facade: EvaluationToolDefinition): {
  tools: EvaluationToolDefinition[]
  hideProductTools: string[]
} {
  return { tools: [facade], hideProductTools: ['sendMessage'] }
}
