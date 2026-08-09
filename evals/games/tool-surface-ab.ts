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
