// Records the runtime's own approval of a restricted MCP call from ACP, for the credential proxy to check (mcp-tool-permissions.md §7.3, §7.4).
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate
} from '@agentclientprotocol/sdk/unstable'
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import type { ClaudePermissionRules } from '../acp/claude-auto-mode.js'
import { argumentsDigest, type ApprovalRecords, type ApprovalSource } from './approval-records.js'

/** The runtimes whose gates and call ids were verified (§12.1); any other records nothing. */
export type GateRuntime = 'claude' | 'codex' | 'other'

type Gated = 'approval' | 'ask'

/** One restricted tool an ACP call names: its provider, its own name, and its decision. */
interface GatedTool {
  provider: string
  tool: string
  decision: Gated
}

/** What the gate keeps of one ACP tool call. */
interface CallState {
  rawInput?: unknown
  toolName?: string
  server?: string
  /** A Claude Auto record follows this call's arguments until the classifier refuses it. */
  following?: boolean
  /** A Codex Guardian review's target call. */
  reviews?: string
}

/** The most calls one session's gate remembers. */
const MAX_CALLS_PER_SESSION = 512

/** Claude's spelling of a server or tool name inside `mcp__<server>__<tool>`. */
export function claudeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The name Claude gives a restricted tool, which its permission rules match. */
export function claudeToolName(server: string, tool: string): string {
  return `mcp__${claudeMcpName(server)}__${claudeMcpName(tool)}`
}

function tableNames(decisions: McpToolDecisions): string[] {
  return [...new Set([...decisions.allow, ...decisions.approval, ...decisions.ask, ...decisions.block])]
}

function gatedDecision(decisions: McpToolDecisions, tool: string): Gated | undefined {
  if (decisions.allow.includes(tool)) return undefined
  if (decisions.ask.includes(tool)) return 'ask'
  return decisions.approval.includes(tool) ? 'approval' : undefined
}

/** A Claude session's rules for restricted tools: allow and deny always, ask where §7.3 needs Claude to ask a person. */
export function claudeMcpRules(
  restricted: ReadonlyMap<string, McpToolDecisions>,
  mode: string | undefined
): ClaudePermissionRules {
  const rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] }
  // An unknown mode may be bypass, so a Needs approval tool is asked about rather than left to run unrecorded.
  const askApproval = mode === undefined || mode === 'bypassPermissions'
  for (const [server, decisions] of restricted) {
    for (const tool of tableNames(decisions)) {
      const name = claudeToolName(server, tool)
      const decision = gatedDecision(decisions, tool)
      if (decisions.allow.includes(tool)) rules.allow.push(name)
      else if (decision === 'ask' || (decision === 'approval' && askApproval)) rules.ask.push(name)
      else if (decision === undefined) rules.deny.push(name)
    }
  }
  return Object.fromEntries(Object.entries(rules).filter(([, list]) => list.length > 0))
}

/** Whether a person's allow on the card records an approval in this runtime and mode (§7.3). */
export function personRecords(runtime: GateRuntime, mode: string | undefined, decision: Gated): boolean {
  if (runtime === 'claude') return mode !== 'dontAsk'
  if (runtime !== 'codex') return false
  if (mode === 'read-only' || mode === 'workspace-write') return true
  // Auto review is decided by its reviewer, and Always ask wants a person; Full access asks no one.
  return mode === 'agent' && decision === 'approval'
}

/** Whether the runtime's own review records an approval in this mode: Claude's classifier and Codex's Guardian, for Needs approval only. */
export function runtimeReviewRecords(runtime: GateRuntime, mode: string | undefined, decision: Gated): boolean {
  if (decision !== 'approval') return false
  return (runtime === 'claude' && mode === 'auto') || (runtime === 'codex' && mode === 'agent')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function claudeMeta(meta: unknown): { toolName?: string; server?: string; nonExecutionKind?: string } {
  const claude = isObject(meta) && isObject(meta.claudeCode) ? meta.claudeCode : undefined
  const server = claude && isObject(claude.mcpServer) ? claude.mcpServer.name : undefined
  return {
    ...(typeof claude?.toolName === 'string' ? { toolName: claude.toolName } : {}),
    ...(typeof server === 'string' ? { server } : {}),
    ...(typeof claude?.nonExecutionKind === 'string' ? { nonExecutionKind: claude.nonExecutionKind } : {})
  }
}

/** One agent host's gate: it watches ACP tool calls and permission answers, and writes the records §7.3 yields. */
export class McpApprovalGate {
  private readonly sessions = new Map<string, Map<string, CallState>>()

  constructor(
    private readonly deps: {
      agentId: string
      runtime: GateRuntime
      records: ApprovalRecords
      /** The agent's restricted MCP definitions whose grant only this daemon holds, by name. */
      restricted: () => ReadonlyMap<string, McpToolDecisions>
      modeOf: (sessionId: string) => string | undefined
      log?: { info: (message: string) => void; warn: (message: string) => void }
    }
  ) {}

  /** Follow one session update: a tool call's arguments, Claude Auto's proposals and refusals, and Codex's Guardian verdicts. */
  observe(sessionId: string, update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    if (this.deps.runtime === 'other') return
    const id = update.toolCallId
    const calls = this.calls(sessionId)
    const call = calls.get(id) ?? {}
    const meta = claudeMeta(update._meta)
    const named = (update as { name?: unknown }).name
    if (update.sessionUpdate === 'tool_call') {
      call.toolName = meta.toolName ?? (typeof named === 'string' ? named : update.title)
      call.rawInput = update.rawInput
      if (meta.server) call.server = meta.server
      const target = isObject(update.rawInput) ? update.rawInput.targetItemId : undefined
      if (typeof target === 'string') call.reviews = target
      calls.delete(id)
      calls.set(id, call)
      for (const old of calls.keys()) {
        if (calls.size <= MAX_CALLS_PER_SESSION) break
        calls.delete(old)
      }
    } else {
      if (!calls.has(id)) return
      if (update.rawInput !== undefined) call.rawInput = update.rawInput
      if (meta.toolName) call.toolName = meta.toolName
    }
    if (this.deps.runtime === 'claude') this.observeClaude(sessionId, id, call, update, meta.nonExecutionKind)
    else this.observeCodex(sessionId, call, update)
  }

  private observeClaude(
    sessionId: string,
    id: string,
    call: CallState,
    update: SessionUpdate & { sessionUpdate: 'tool_call' | 'tool_call_update' },
    nonExecutionKind: string | undefined
  ): void {
    const { agentId, records } = this.deps
    if (update.sessionUpdate === 'tool_call') {
      const gated = this.claudeTool(call.toolName, call.server)
      if (!gated || !runtimeReviewRecords('claude', this.deps.modeOf(sessionId), gated.decision)) return
      // ACP shows no classifier verdict, so the proposal itself is the record, refused calls removed below.
      records.put({
        agentId,
        toolCallId: id,
        ...gated,
        argsDigest: argumentsDigest(call.rawInput),
        source: 'runtime-review'
      })
      call.following = true
      return
    }
    if (!call.following) return
    if (update.status === 'failed' || nonExecutionKind?.startsWith('automode-')) {
      records.delete(agentId, id)
      call.following = false
    } else if (update.rawInput !== undefined) {
      records.refresh(agentId, id, argumentsDigest(update.rawInput))
    }
  }

  private observeCodex(sessionId: string, call: CallState, update: SessionUpdate): void {
    if (!call.reviews || (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) return
    const output = isObject(update.rawOutput) ? update.rawOutput : undefined
    const input = isObject(update.rawInput) ? update.rawInput : undefined
    const review = isObject(output?.review) ? output.review : isObject(input?.review) ? input.review : undefined
    if (review?.status !== 'approved') return
    const targetId = typeof output?.targetItemId === 'string' ? output.targetItemId : call.reviews
    if (targetId !== call.reviews) return
    const target = this.calls(sessionId).get(targetId)
    const gated = target && this.codexTool(target)
    if (!target || !gated || !runtimeReviewRecords('codex', this.deps.modeOf(sessionId), gated.decision)) return
    this.deps.records.put({
      agentId: this.deps.agentId,
      toolCallId: targetId,
      ...gated,
      argsDigest: argumentsDigest((target.rawInput as Record<string, unknown>).arguments),
      source: 'runtime-review'
    })
  }

  /** A restricted gated tool's permission request: once-only options, the digested arguments on the card, and a person's allow recorded before the answer returns. */
  async permission(
    sessionId: string,
    params: RequestPermissionRequest,
    ask: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  ): Promise<RequestPermissionResponse> {
    const mode = this.deps.modeOf(sessionId)
    const id = params.toolCall.toolCallId
    let gated: GatedTool | undefined
    let args: unknown
    let shown: unknown
    if (this.deps.runtime === 'codex' && isObject(params._meta) && params._meta.is_mcp_tool_approval === true) {
      if (this.deps.restricted().size === 0) return await ask(params)
      // Codex's MCP approval carries no arguments; they come from the call's own `tool_call`, without which nothing is approved.
      const call = this.sessions.get(sessionId)?.get(id)
      if (!call || !isObject(call.rawInput) || typeof call.rawInput.tool !== 'string') {
        this.deps.log?.warn(
          `mcp approvals: refused an approval for call ${id} of agent "${this.deps.agentId}", whose call was never shown`
        )
        return refusal(params)
      }
      gated = this.codexTool(call)
      args = call.rawInput.arguments
      shown = call.rawInput
    } else if (this.deps.runtime === 'claude') {
      const meta = claudeMeta(params.toolCall._meta)
      gated = this.claudeTool(meta.toolName ?? params.toolCall.title ?? undefined, meta.server)
      args = params.toolCall.rawInput
      shown = args
      if (gated && args === undefined) return refusal(params)
    }
    if (!gated) return await ask(params)
    const argsDigest = argumentsDigest(args)
    // An "always" answer would leave every later call without a record, so only once-only options are offered.
    const options = params.options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once')
    const answer = await ask({ ...params, options, toolCall: { ...params.toolCall, rawInput: shown } })
    if (answer.outcome.outcome !== 'selected') return answer
    const selected = answer.outcome.optionId
    const picked = options.find((option) => option.optionId === selected)
    if (!picked) {
      this.deps.log?.warn(`mcp approvals: refused an answer naming an option the card for call ${id} did not offer`)
      return refusal(params)
    }
    if (picked.kind === 'allow_once' && personRecords(this.deps.runtime, mode, gated.decision)) {
      this.deps.records.put({
        agentId: this.deps.agentId,
        toolCallId: id,
        ...gated,
        argsDigest,
        source: 'person' satisfies ApprovalSource
      })
    }
    return answer
  }

  /** Forget a session's calls when it ends. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private calls(sessionId: string): Map<string, CallState> {
    let calls = this.sessions.get(sessionId)
    if (!calls) {
      calls = new Map()
      this.sessions.set(sessionId, calls)
    }
    return calls
  }

  /** A Claude tool name's restricted tool, matched through Claude's name spelling; an ambiguous spelling matches nothing. */
  private claudeTool(toolName: string | undefined, server: string | undefined): GatedTool | undefined {
    if (!toolName?.startsWith('mcp__')) return undefined
    const matches: { provider: string; tool: string; decisions: McpToolDecisions }[] = []
    for (const [provider, decisions] of this.deps.restricted()) {
      if (server !== undefined && server !== provider) continue
      const prefix = `mcp__${claudeMcpName(provider)}__`
      if (!toolName.startsWith(prefix)) continue
      const rest = toolName.slice(prefix.length)
      for (const tool of tableNames(decisions))
        if (claudeMcpName(tool) === rest) matches.push({ provider, tool, decisions })
    }
    if (matches.length !== 1) return undefined
    const { provider, tool, decisions } = matches[0]!
    const decision = gatedDecision(decisions, tool)
    return decision && { provider, tool, decision }
  }

  /** A Codex call's restricted tool, by the `server` and `tool` its input names. */
  private codexTool(call: CallState): GatedTool | undefined {
    if (!isObject(call.rawInput)) return undefined
    const { server, tool } = call.rawInput
    if (typeof server !== 'string' || typeof tool !== 'string') return undefined
    const decisions = this.deps.restricted().get(server)
    const decision = decisions && gatedDecision(decisions, tool)
    return decision && { provider: server, tool, decision }
  }
}

/** The runtime's reject-once answer, or a cancellation when it offered none. */
function refusal(params: RequestPermissionRequest): RequestPermissionResponse {
  const reject = params.options.find((option: PermissionOption) => option.kind === 'reject_once')
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}
