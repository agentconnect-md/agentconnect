/**
 * Linear's **streaming turn-output surface** (linear-integration.md §5).
 *
 * Linear activities are APPEND-ONLY snapshots: `agentActivityCreate` never
 * coalesces, so even identical `(action, parameter)` pairs stack in the feed.
 * The converger therefore runs in a discrete-update posture — coalesce
 * aggressively, post meaningfully — and every collapse rule below is ours, not
 * the platform's. GitHub's turn-FINAL shape is deliberately not used: Linear's
 * product is the live feed, so this surface emits as it goes.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { appendGithubMarkdownChrome, GithubReplyCollector } from '../../github/poster.js'
import { renderAttributionMessage } from '../../messages/attribution.js'
import { splitAtParagraphBoundary } from '../../messages/stream-boundary.js'
import { isNoResponseBody, isNoResponsePrefix } from '../../session/no-response.js'
import { extractToolOutput } from '../../session/tool-output.js'
import type { TurnOutputContext } from '../turn-output.js'

/** Linear's plan-entry vocabulary. `canceled` has no ACP source today; it exists because
 *  the plan array is a full replace and a future entry may need it. */
export type LinearPlanStatus = 'pending' | 'inProgress' | 'completed' | 'canceled'

export interface LinearPlanEntry {
  content: string
  status: LinearPlanStatus
}

export interface LinearExternalUrl {
  label: string
  url: string
}

/** The converger's Linear-shaped IR (§5). `activity` becomes `agentActivityCreate`;
 *  `plan` / `external-urls` become `agentSessionUpdate`. */
export type LinearAction =
  | { kind: 'activity'; type: 'thought'; body: string; ephemeral?: boolean }
  | { kind: 'activity'; type: 'action'; action: string; parameter: string; result?: string }
  | { kind: 'activity'; type: 'response'; body: string }
  | { kind: 'activity'; type: 'error'; body: string }
  | { kind: 'activity'; type: 'elicitation'; body: string }
  | { kind: 'plan'; entries: LinearPlanEntry[] }
  | { kind: 'external-urls'; add: LinearExternalUrl[] }

/** One `agentActivityCreate` input, flattened. The egress port owns the GraphQL shape. */
export interface LinearActivityInput {
  type: 'thought' | 'action' | 'response' | 'error' | 'elicitation'
  body?: string
  action?: string
  parameter?: string
  result?: string
  ephemeral?: boolean
}

/** One `agentSessionUpdate` input. Both fields are full-array replace on Linear's side. */
export interface LinearSessionUpdateInput {
  plan?: LinearPlanEntry[]
  addedExternalUrls?: LinearExternalUrl[]
}

/**
 * What `apply` needs from Linear, and nothing more (§4.6 single-writer egress).
 *
 * The per-integration connection satisfies this structurally, and it — not this
 * module — owns the send queue, the brokered token, and the retry ladder. Kept
 * as a port so the surface can be tested without a connection at all.
 */
export interface LinearEgressPort {
  /** Append one activity to the AgentSession's feed. */
  postActivity(sessionId: string, activity: LinearActivityInput): Promise<void>
  /** Patch the AgentSession's plan / external URLs. */
  updateSession(sessionId: string, update: LinearSessionUpdateInput): Promise<void>
}

/** The core turn, as Linear's applier sees it. `Pending` satisfies it structurally. */
export interface LinearTurn {
  conn?: unknown
  plan: {
    /** The Linear AgentSession UUID — the normalized `thread` coordinate (§4.5). */
    thread?: string
    platform: string
    agentId: string
    sessionKey: string
  }
}

/** Linear's opaque per-turn state (§5): the hard chrome budget and the last plan
 *  actually pushed, so an unchanged plan costs no `agentSessionUpdate`. */
export interface LinearTurnState {
  /** Remaining non-settling activities; a settling `response`/`error` never draws on it. */
  activityBudget: number
  lastPlanHash?: string
  /** The egress transport CAPTURED at turn start. Held rather than looked up per action
   *  because reconciliation can drop the integration's binding mid-turn, and a turn that
   *  cannot reach Linear can never post the settling activity that ends its session. */
  conn?: LinearEgressPort
}

/** Raw attribution identity for the response footer. Structurally the same record the
 *  code-host posters take, so core resolves it once for every Markdown surface. */
export interface LinearAttribution {
  agentName: string
  agentUrl: string
  runtime: string
  model: string
  sessionUrl: string
}

/**
 * Core's shared per-turn attribution record, as this surface names it.
 *
 * A pure rename, and it earns its existence: core calls the identity `bot`, but on Linear the
 * bot is the deployment's one OAuth app (§4.3), so the footer must name the ACTING AGENT —
 * which is the same field core already resolves from the agent, not from the app.
 */
export function linearAttributionOf(info: {
  botName: string
  botUrl: string
  runtime: string
  model: string
  sessionUrl: string
}): LinearAttribution {
  return {
    agentName: info.botName,
    agentUrl: info.botUrl,
    runtime: info.runtime,
    model: info.model,
    sessionUrl: info.sessionUrl
  }
}

export type LinearOutputMode = 'none' | 'minimal' | 'low' | 'medium' | 'high'

/** What one output mode lets the converger emit (§5.2). */
export interface LinearModePolicy {
  /** `agent_thought_chunk` → ephemeral thought. */
  readonly reasoning: boolean
  /** Intermediate `agent_message_chunk` → non-ephemeral progress thought. */
  readonly progress: boolean
  readonly actions: boolean
  /** Tool output carried on the action's `result` field. */
  readonly actionResults: boolean
  readonly plan: boolean
  /** The settling `response` — and, with it, `error` and `elicitation`: `none` is truly silent. */
  readonly response: boolean
}

// The default is `low`, and it already includes actions and plan: an agent-session feed is
// FOR progress visibility, which is the opposite of a chat channel's default.
const MODE_POLICY: Record<LinearOutputMode, LinearModePolicy> = {
  none: { reasoning: false, progress: false, actions: false, actionResults: false, plan: false, response: false },
  minimal: { reasoning: false, progress: false, actions: false, actionResults: false, plan: false, response: true },
  low: { reasoning: false, progress: true, actions: true, actionResults: false, plan: true, response: true },
  medium: { reasoning: true, progress: true, actions: true, actionResults: false, plan: true, response: true },
  high: { reasoning: true, progress: true, actions: true, actionResults: true, plan: true, response: true }
}

/** Reasoning tail clamp, matching every other renderer's `MAX_REASONING`. */
export const MAX_REASONING = 2800
/** Head clamp on an action's `result` (§5.1). */
export const MAX_ACTION_RESULT = 2800
/** Clamp on an action's `parameter` summary. */
export const MAX_ACTION_PARAMETER = 500
/** Soft per-turn action cap; the overflow is reported once as "… and N more". */
export const MAX_TURN_ACTIONS = 40
/** Hard per-turn CHROME budget enforced at the egress edge, under every soft cap. The settling
 *  `response`/`error` is exempt: the cap bounds progress noise, never the turn's one answer. */
export const MAX_TURN_ACTIVITIES = 200
/** Message-text tail kept for sentinel detection — far more than the sentinel's own line needs. */
const SENTINEL_TAIL_CHARS = 512

/** Posted when the turn produced no final text but still owes Linear a settling `response`. */
export const EMPTY_RESPONSE_BODY = 'Done.'
/** v1 elicitation copy (§10.4): a pointer to the console, not an approval protocol. */
export const PERMISSION_ELICITATION_BODY = 'This step needs approval — open the session in the console.'

export function linearModePolicy(mode: LinearOutputMode): LinearModePolicy {
  return MODE_POLICY[mode]
}

function normalizeMode(mode: string): LinearOutputMode {
  return mode in MODE_POLICY ? (mode as LinearOutputMode) : 'low'
}

function flatText(raw: string | undefined, max = 200): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Escape the Markdown punctuation that would otherwise break a link label. */
function escapeMarkdown(raw: string): string {
  return raw.replace(/([\\`*_[\]<>])/g, '\\$1')
}

function httpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

function markdownLink(label: string, raw: string | undefined): string {
  const url = httpUrl(raw)
  const text = escapeMarkdown(label)
  return url ? `[${text}](${url})` : text
}

/**
 * The response footer, in plain Markdown.
 *
 * The sentence itself is the platform-neutral one every surface shares; the code hosts'
 * `<sub>`/`<img>` chrome is deliberately not reused, because Linear renders Markdown and
 * not raw HTML.
 */
export function linearAttributionFooter(attribution?: LinearAttribution): string {
  if (!attribution) return ''
  const sessionUrl = httpUrl(attribution.sessionUrl)
  const message = renderAttributionMessage({
    agent: markdownLink(flatText(attribution.agentName) || 'unknown agent', attribution.agentUrl),
    runtime: escapeMarkdown(flatText(attribution.runtime)),
    model: escapeMarkdown(flatText(attribution.model)),
    ...(sessionUrl ? { renderSession: (label: string) => markdownLink(label, sessionUrl) } : {})
  })
  return `\n\n${message}`
}

/** Pull a compact input summary out of a tool call's `rawInput` for the `parameter` field. */
export function summarizeToolInput(rawInput: unknown): string {
  if (typeof rawInput === 'string') return flatText(rawInput, MAX_ACTION_PARAMETER)
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return ''
  const input = rawInput as Record<string, unknown>
  for (const key of ['command', 'cmd', 'path', 'file_path', 'query', 'url', 'pattern', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return flatText(value, MAX_ACTION_PARAMETER)
  }
  const scalars = Object.entries(input)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map(([key, value]) => `${key}=${String(value)}`)
  return flatText(scalars.join(' '), MAX_ACTION_PARAMETER)
}

/** Head-clamp a tool result: the head is where a command says what it did. */
function clampResult(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  return text.length > MAX_ACTION_RESULT ? `${text.slice(0, MAX_ACTION_RESULT)}\n…` : text
}

function toPlanEntry(entry: { content?: unknown; status?: unknown }): LinearPlanEntry {
  const status = entry.status === 'in_progress' ? 'inProgress' : entry.status === 'completed' ? 'completed' : 'pending'
  return { content: typeof entry.content === 'string' ? entry.content : '', status }
}

/** The subset of an ACP update this converger reads. */
interface LinearUpdateView {
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  toolCallId?: string
  title?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  entries?: { content?: unknown; status?: unknown }[]
}

/** A run of consecutive same-title tool calls, held until something separates it from the next. */
interface PendingAction {
  title: string
  parameters: string[]
  result?: string
  count: number
}

/**
 * One turn's Linear production rules (§5.1).
 *
 * The idle WINDOW is core's (it re-arms the shared ~2 s timer on `hasBuffered()` and
 * flushes through `flushBuffered()`), so this class holds no timers of its own and is
 * deterministic under test on every platform.
 */
export class LinearConverger {
  private readonly policy: LinearModePolicy
  private readonly collector = new GithubReplyCollector()
  // The collector reports a suppressed turn as "no final answer", which is indistinguishable
  // from a silent one — so the sentinel is detected here, on a mode-independent message tail.
  private sentinelTail = ''
  private narration = ''
  private reasoning = ''
  private reasoningDirty = false
  private readonly toolTitles = new Map<string, string>()
  private readonly toolParameters = new Map<string, string>()
  private readonly toolResults = new Map<string, string>()
  private readonly openTools = new Set<string>()
  private readonly settledTools = new Set<string>()
  private pending?: PendingAction
  private actionsEmitted = 0
  private droppedActions = 0
  private planEntries?: LinearPlanEntry[]
  private planDirty = false
  private lastPlanKey?: string
  private lastElicitation?: string
  private settled = false

  constructor(
    private readonly mode: LinearOutputMode,
    private readonly showFooter: boolean
  ) {
    this.policy = MODE_POLICY[mode]
  }

  /** Diagnostic only; never parsed. */
  outputMode(): LinearOutputMode {
    return this.mode
  }

  /** True while anything is pending — core (re)arms the shared idle timer on it. */
  hasBuffered(): boolean {
    if (this.settled) return false
    return (
      this.pending !== undefined ||
      this.reasoningDirty ||
      this.planDirty ||
      (this.openTools.size > 0 && this.narration.trim().length > 0)
    )
  }

  onUpdate(update: SessionUpdate): LinearAction[] {
    if (this.settled) return []
    // The collector reads the WHOLE stream, independently of what this mode emits: it is
    // what selects the one logical final answer at turn end.
    this.collector.onUpdate(update)
    const u = update as LinearUpdateView
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        if (u.content?.type !== 'text') return []
        const text = u.content.text ?? ''
        this.sentinelTail = (this.sentinelTail + text).slice(-SENTINEL_TAIL_CHARS)
        if (this.policy.progress) this.narration += text
        return []
      }
      case 'agent_thought_chunk': {
        if (!this.policy.reasoning) return []
        const text = u.content?.text ?? ''
        if (!text) return []
        this.reasoning += text
        if (this.reasoning.length > MAX_REASONING * 2) this.reasoning = this.reasoning.slice(-MAX_REASONING * 2)
        this.reasoningDirty = true
        return []
      }
      case 'tool_call':
      case 'tool_call_update':
        return this.onToolUpdate(u)
      case 'plan': {
        if (!this.policy.plan) return []
        // Last write wins inside the window; the emit happens on the next flush (§5.3).
        this.planEntries = (u.entries ?? []).map(toPlanEntry)
        this.planDirty = true
        return []
      }
      default:
        return []
    }
  }

  /** Idle-window flush. Narration is cut here only while a tool call is in flight — that is
   *  the one proof the text is progress and not the closing answer the `response` will carry. */
  flushBuffered(): LinearAction[] {
    if (this.settled) return []
    const narration = this.openTools.size > 0 ? this.flushNarration(false) : []
    return [...narration, ...this.takePending(), ...this.drainReasoning(), ...this.drainPlan()]
  }

  /** Drain everything for a turn ending abnormally: the runtime narrated its terminal error
   *  into the message stream and there is no later flush, so take the WHOLE buffer. */
  flushTerminal(): LinearAction[] {
    if (this.settled) return []
    return [...this.flushNarration(true), ...this.takePending(), ...this.drainReasoning(), ...this.drainPlan()]
  }

  /**
   * Turn end: the settling `response`.
   *
   * A `response` is what drives the Linear session to `complete`, so exactly one is emitted
   * per turn — and it OPENS the settled state, after which this converger emits nothing.
   * `AC_NO_RESPONSE` is the one exception: the pre-spawn ack already exists, so a suppressed
   * turn is ack-only and no settling response follows (§5.1).
   */
  onFinal(attribution?: LinearAttribution): LinearAction[] {
    if (this.settled) return []
    this.settled = true
    if (isNoResponseBody(this.sentinelTail.trim())) return this.discard()
    if (!this.policy.response) return this.discard()
    const final = this.collector.finalText(true)?.trim() ?? ''
    // The residual narration IS the final answer on an append-only feed, so it is never
    // re-posted as a thought here; the trailing ephemeral reasoning would be replaced by the
    // response on arrival, so it is dropped rather than paying an API call.
    this.narration = ''
    this.reasoningDirty = false
    const out: LinearAction[] = [...this.takePending(), ...this.drainPlan()]
    if (this.droppedActions > 0) {
      out.push({ kind: 'activity', type: 'thought', body: `… and ${this.droppedActions} more tool calls` })
    }
    out.push({ kind: 'activity', type: 'response', body: this.responseBody(final, attribution) })
    return out
  }

  /**
   * Turn failure: the settling `error`, carrying core's `turnFailureReason`.
   *
   * The buffer is flushed FIRST so a runtime that narrated its own terminal error into the
   * message stream is not repeated — a flushed thought that already states the reason is
   * dropped in favor of the `error` activity, which is what moves the Linear session to
   * `error` rather than leaving it active.
   */
  onFailure(reason: string): LinearAction[] {
    if (this.settled) return []
    this.settled = true
    if (!this.policy.response) return this.discard()
    const flushed = [...this.flushNarration(true), ...this.takePending()]
    const deduped = flushed.filter((a) => !(a.kind === 'activity' && a.type === 'thought' && a.body.includes(reason)))
    return [...deduped, { kind: 'activity', type: 'error', body: reason }]
  }

  /** A permission gate would block the turn: point at the console (§10.4). Repeated identical
   *  gates collapse, because an append-only feed would otherwise stack them. */
  onPermissionBlocked(sessionUrl?: string): LinearAction[] {
    if (this.settled || !this.policy.response) return []
    const link = httpUrl(sessionUrl)
    const body = link
      ? `${PERMISSION_ELICITATION_BODY} ${markdownLink('open in session', link)}`
      : PERMISSION_ELICITATION_BODY
    if (this.lastElicitation === body) return []
    this.lastElicitation = body
    return [...this.flushNarration(true), ...this.takePending(), { kind: 'activity', type: 'elicitation', body }]
  }

  private discard(): LinearAction[] {
    this.narration = ''
    this.reasoning = ''
    this.reasoningDirty = false
    this.pending = undefined
    this.planDirty = false
    return []
  }

  private responseBody(final: string, attribution?: LinearAttribution): string {
    const footer = this.showFooter ? linearAttributionFooter(attribution) : ''
    return appendGithubMarkdownChrome(final || EMPTY_RESPONSE_BODY, footer)
  }

  private onToolUpdate(u: LinearUpdateView): LinearAction[] {
    if (!this.policy.actions) return []
    const id = u.toolCallId
    const title = this.rememberTool(u)
    if (id) {
      if (u.rawInput !== undefined) {
        const parameter = summarizeToolInput(u.rawInput)
        if (parameter) this.toolParameters.set(id, parameter)
      }
      if (u.content !== undefined || u.rawOutput !== undefined) {
        const output = extractToolOutput(u)
        if (output) this.toolResults.set(id, output)
      }
    }
    const terminal = u.status === 'completed' || u.status === 'failed'
    if (id) {
      if (terminal) this.openTools.delete(id)
      else this.openTools.add(id)
    }
    // A tool boundary is a semantic boundary: whatever narration preceded it was progress.
    const boundary = this.flushNarration(true)
    // §15-1 is resolved live — Linear stacks every create, so an action is emitted ONCE, at
    // terminal status. A start-status call contributes nothing but its title and input.
    if (!terminal || !id || this.settledTools.has(id)) return boundary
    this.settledTools.add(id)
    const parameter = this.toolParameters.get(id) ?? ''
    const result = this.policy.actionResults ? clampResult(this.toolResults.get(id)) : undefined
    this.toolParameters.delete(id)
    this.toolResults.delete(id)
    if (this.pending?.title === title) {
      this.pending.count += 1
      if (parameter) this.pending.parameters.push(parameter)
      if (result) this.pending.result = result
      return boundary
    }
    const released = this.takePending()
    this.pending = { title, parameters: parameter ? [parameter] : [], count: 1, ...(result ? { result } : {}) }
    return [...boundary, ...released]
  }

  private rememberTool(u: LinearUpdateView): string {
    const id = u.toolCallId
    if (u.title) {
      if (id) this.toolTitles.set(id, u.title)
      return u.title
    }
    return (id && this.toolTitles.get(id)) ?? id ?? 'tool'
  }

  /** Release the held run as one action row. Over the cap it is counted, not emitted. */
  private takePending(): LinearAction[] {
    const held = this.pending
    if (!held) return []
    this.pending = undefined
    if (this.actionsEmitted >= MAX_TURN_ACTIONS) {
      this.droppedActions += 1
      return []
    }
    this.actionsEmitted += 1
    return [
      {
        kind: 'activity',
        type: 'action',
        action: held.count > 1 ? `${held.title} ×${held.count}` : held.title,
        parameter: flatText(held.parameters.join('\n'), MAX_ACTION_PARAMETER),
        ...(held.result ? { result: held.result } : {})
      }
    ]
  }

  /** Emit buffered narration as a progress thought. Always releases a held action first, so
   *  the feed keeps the order the stream had — and so a run split by narration stops collapsing. */
  private flushNarration(whole: boolean): LinearAction[] {
    const trimmed = this.narration.trim()
    if (!trimmed) {
      this.narration = ''
      return []
    }
    // Hold while the body could still become the bare sentinel, so a suppressed turn never
    // leaks a partial thought before `onFinal` drops it.
    if (isNoResponsePrefix(trimmed)) return []
    let text: string
    if (whole) {
      text = this.narration
      this.narration = ''
    } else {
      const { ready, tail } = splitAtParagraphBoundary(this.narration)
      if (!ready.trim()) return []
      this.narration = tail
      text = ready
    }
    return [...this.takePending(), { kind: 'activity', type: 'thought', body: text.trim() }]
  }

  /** Emit the reasoning accumulated SINCE THE LAST FLUSH. The in-place renderers keep a
   *  cumulative buffer because they edit one message; an append-only feed must send deltas,
   *  or every flush re-posts the whole turn's thinking. */
  private drainReasoning(): LinearAction[] {
    if (!this.reasoningDirty) return []
    this.reasoningDirty = false
    const trimmed = this.reasoning.trim()
    this.reasoning = ''
    if (!trimmed) return []
    const tail = trimmed.length > MAX_REASONING ? `…${trimmed.slice(-MAX_REASONING)}` : trimmed
    return [{ kind: 'activity', type: 'thought', body: tail, ephemeral: true }]
  }

  private drainPlan(): LinearAction[] {
    if (!this.planDirty || !this.planEntries) return []
    this.planDirty = false
    const key = JSON.stringify(this.planEntries)
    if (key === this.lastPlanKey) return []
    this.lastPlanKey = key
    return [{ kind: 'plan', entries: this.planEntries }]
  }
}

/** Build this turn's converger. Fresh per turn, so a config change applies from the next one. */
export function createLinearConverger(ctx: TurnOutputContext<unknown>): LinearConverger {
  return new LinearConverger(normalizeMode(ctx.mode), ctx.showFooter)
}

/** Seed the opaque per-turn state slot core stores and never reads. */
export function initialLinearTurnState(): LinearTurnState {
  return { activityBudget: MAX_TURN_ACTIVITIES }
}

function toActivityInput(action: Extract<LinearAction, { kind: 'activity' }>): LinearActivityInput {
  switch (action.type) {
    case 'action':
      return {
        type: 'action',
        action: action.action,
        parameter: action.parameter,
        ...(action.result ? { result: action.result } : {})
      }
    case 'thought':
      return { type: 'thought', body: action.body, ...(action.ephemeral ? { ephemeral: true } : {}) }
    default:
      return { type: action.type, body: action.body }
  }
}

/** The two activities that drive the Linear session out of `active` — a turn owes exactly one. */
function isSettlingActivity(action: Extract<LinearAction, { kind: 'activity' }>): boolean {
  return action.type === 'response' || action.type === 'error'
}

/**
 * Apply one converger action to Linear, through the connection's own send queue.
 *
 * The port is the one CAPTURED on the turn state at turn start, falling back to whatever the
 * turn carries — so an integration unbound mid-turn still settles through the transport this
 * turn holds a lease on. A headless turn or a session with no AgentSession coordinate no-ops.
 */
export async function applyLinearAction<TTurn extends LinearTurn>(
  turn: TTurn,
  state: LinearTurnState,
  action: LinearAction
): Promise<void> {
  const port = state.conn ?? (turn.conn as LinearEgressPort | undefined)
  const sessionId = turn.plan.thread
  if (!port || !sessionId) return
  switch (action.kind) {
    case 'activity': {
      // The hard backstop under every soft cap: a runaway turn cannot exhaust the workspace's
      // hourly budget on one session's feed. It bounds CHROME only — a settling activity is
      // exempt, because dropping it would lose the answer and leave the session active forever.
      if (!isSettlingActivity(action)) {
        if (state.activityBudget <= 0) return
        state.activityBudget -= 1
      }
      await port.postActivity(sessionId, toActivityInput(action))
      return
    }
    case 'plan': {
      const hash = JSON.stringify(action.entries)
      if (hash === state.lastPlanHash) return
      state.lastPlanHash = hash
      await port.updateSession(sessionId, { plan: action.entries })
      return
    }
    case 'external-urls': {
      if (action.add.length === 0) return
      await port.updateSession(sessionId, { addedExternalUrls: action.add })
      return
    }
  }
}
