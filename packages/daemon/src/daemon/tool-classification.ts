import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { ALL_TOOL_NAMES } from '../mcp/tools.js'
import { RESERVED_MCP_SERVER_NAME } from '../mcp/resolve-servers.js'

// ACP runtime identities for this daemon's own MCP tools; both approval transports below trust only these.
const BUILTIN_TOOL_NAMES = new Set(ALL_TOOL_NAMES)
const BUILTIN_TOOL_FQNS = new Set(
  ALL_TOOL_NAMES.flatMap((name) => [
    `mcp__${RESERVED_MCP_SERVER_NAME}__${name}`,
    `mcp.${RESERVED_MCP_SERVER_NAME}.${name}`,
    // Gemini CLI flattens with a SINGLE underscore (`MCP_TOOL_PREFIX` + its
    // `MCP_QUALIFIED_NAME_SEPARATOR`), so its function name is mcp_<server>_<tool>.
    `mcp_${RESERVED_MCP_SERVER_NAME}_${name}`
  ])
)

// Gemini CLI's `<tool> (<server> MCP Server)` title; another server's tool gets its own suffix, so it cannot spoof ours.
const BUILTIN_TOOL_DISPLAY_TITLES = new Set(
  ALL_TOOL_NAMES.map((name) => `${name} (${RESERVED_MCP_SERVER_NAME} MCP Server)`)
)

// Ids built from the flattened name: qwen-code's `mcp__<server>__<tool>-<suffix>`, gemini-cli's `mcp_<server>_<tool>__<suffix>`.
const BUILTIN_TOOL_CALL_ID_PREFIXES = ALL_TOOL_NAMES.flatMap((name) => [
  `mcp__${RESERVED_MCP_SERVER_NAME}__${name}-`,
  `mcp_${RESERVED_MCP_SERVER_NAME}_${name}__`
])

// A free-text field names one of our tools only as the whole string, never inside a longer one such as a shell command.
function isBuiltinToolLabel(value: unknown): boolean {
  return typeof value === 'string' && (BUILTIN_TOOL_FQNS.has(value) || BUILTIN_TOOL_DISPLAY_TITLES.has(value))
}

/** Identify a structured ACP tool event for one of this daemon's own MCP tools. */
export function isBuiltinSystemToolCall(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const u = update as { sessionUpdate?: unknown; name?: unknown; rawInput?: unknown; title?: unknown }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return false
  // ACP's programmatic tool name outranks rawInput, which some runtimes fill with the model's own arguments.
  if (typeof u.name === 'string' && u.name) return BUILTIN_TOOL_FQNS.has(u.name)
  const rawInput =
    u.rawInput && typeof u.rawInput === 'object' ? (u.rawInput as { server?: unknown; tool?: unknown }) : undefined
  // Structured server/tool identity outranks a friendly or misleading display title.
  if (rawInput && (rawInput.server !== undefined || rawInput.tool !== undefined)) {
    return (
      rawInput.server === RESERVED_MCP_SERVER_NAME &&
      typeof rawInput.tool === 'string' &&
      BUILTIN_TOOL_NAMES.has(rawInput.tool)
    )
  }
  return typeof u.title === 'string' && BUILTIN_TOOL_FQNS.has(u.title)
}

/** True when an ACP permission request is for one of this daemon's own MCP tools; anything unrecognized still gets a card. */
export function isBuiltinSystemTool(
  params: RequestPermissionRequest,
  correlatedToolCallIds?: ReadonlySet<string>
): boolean {
  const tc = params.toolCall
  // ACP's programmatic tool name, when sent, outranks every free-text field and any correlated id.
  if (typeof tc?.name === 'string' && tc.name) return BUILTIN_TOOL_FQNS.has(tc.name)
  const id = tc?.toolCallId
  if (typeof id === 'string' && correlatedToolCallIds?.has(id)) return true
  if (isBuiltinToolLabel(tc?.title) || isBuiltinToolLabel(tc?.kind)) return true
  return typeof id === 'string' && BUILTIN_TOOL_CALL_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** Codex ACP carries MCP approval through form elicitation when the client supports it. */
export function isBuiltinSystemToolElicitation(
  params: CreateElicitationRequest,
  correlatedToolCallIds: ReadonlySet<string>
): boolean {
  const toolCallId = 'toolCallId' in params ? params.toolCallId : undefined
  return (
    params.mode === 'form' &&
    typeof toolCallId === 'string' &&
    correlatedToolCallIds.has(toolCallId) &&
    params._meta?.codex_approval_kind === 'mcp_tool_call'
  )
}

export function isMcpToolApprovalElicitation(params: CreateElicitationRequest): boolean {
  return params.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call'
}

function approvalSummary(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, 240)
}

function approvalInputSummary(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const input = value as Record<string, unknown>
  for (const key of ['command', 'cmd', 'path', 'file_path', 'query', 'url']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key]
  }
  // An MCP call's input is `{server, tool, arguments}`: the arguments are what it will act on.
  const args = input.arguments
  if (args && typeof args === 'object' && !Array.isArray(args))
    return mcpArgumentsSummary(args as Record<string, unknown>)
  return ''
}

/** `key=value` pairs, each value cut short, so one long argument (a file's contents) can't crowd out the rest. */
function mcpArgumentsSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${(typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).slice(0, 80)}`)
    .join(', ')
}

/** One approval request, split the way a surface renders it: the action, then its one-line input. */
export interface ApprovalRequestParts {
  tool: string
  detail: string
}

/** What a tool call's own `tool_call` updates said about it, kept for an approval request that names only its id. */
export interface KnownToolCall {
  title?: string
  detail?: string
}

/** Remember a tool call's title and input summary from its updates. codex-acp asks to approve a running MCP call with
 *  just `{toolCallId, kind}`, leaving the call itself to say what it does (#3289). */
export function rememberToolCall(known: Map<string, KnownToolCall>, update: unknown): void {
  if (!update || typeof update !== 'object') return
  const u = update as { sessionUpdate?: unknown; toolCallId?: unknown; title?: unknown; rawInput?: unknown }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return
  if (typeof u.toolCallId !== 'string' || !u.toolCallId) return
  const prior = known.get(u.toolCallId)
  const title = approvalSummary(mcpToolLabel(u.rawInput) || u.title, '') || prior?.title
  const detail = approvalSummary(approvalInputSummary(u.rawInput), '') || prior?.detail
  if (title || detail) known.set(u.toolCallId, { ...(title ? { title } : {}), ...(detail ? { detail } : {}) })
}

/** `server · tool` for an MCP call's `{server, tool}` input, which names it better than a flattened title; '' otherwise. */
function mcpToolLabel(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== 'object') return ''
  const { server, tool } = rawInput as { server?: unknown; tool?: unknown }
  if (typeof server !== 'string' || typeof tool !== 'string' || !server.trim() || !tool.trim()) return ''
  return `${server.trim()} · ${tool.trim()}`
}

/** The request's first text content, where codex-acp puts an MCP approval's own question. */
function permissionMessage(params: RequestPermissionRequest): string {
  for (const item of params.toolCall?.content ?? []) {
    if (item.type === 'content' && item.content.type === 'text' && item.content.text.trim()) return item.content.text
  }
  return ''
}

/** The request with a title every card can name it by, when it came without one: the call's earlier label, else its own question. */
export function titledPermissionRequest(
  params: RequestPermissionRequest,
  known?: ReadonlyMap<string, KnownToolCall>
): RequestPermissionRequest {
  if (params.toolCall?.title?.trim()) return params
  const toolCallId = params.toolCall?.toolCallId
  const prior = typeof toolCallId === 'string' ? known?.get(toolCallId)?.title : undefined
  const title = approvalSummary(prior || permissionMessage(params), '')
  return title ? { ...params, toolCall: { ...params.toolCall, title } } : params
}

export function permissionRequestParts(
  params: RequestPermissionRequest,
  known?: ReadonlyMap<string, KnownToolCall>
): ApprovalRequestParts {
  const toolCallId = params.toolCall?.toolCallId
  const prior = typeof toolCallId === 'string' ? known?.get(toolCallId) : undefined
  // The request's own fields win; the call's earlier updates fill only what it left out.
  return {
    tool: approvalSummary(params.toolCall?.title ?? prior?.title ?? params.toolCall?.kind, 'Tool permission request'),
    detail: approvalSummary(approvalInputSummary(params.toolCall?.rawInput), '') || (prior?.detail ?? '')
  }
}

/** An MCP approval named by its call's `server · tool` when an earlier update said it, else by its message. */
export function elicitationApprovalParts(
  params: CreateElicitationRequest,
  known?: ReadonlyMap<string, KnownToolCall>
): ApprovalRequestParts {
  const toolCallId = 'toolCallId' in params ? params.toolCallId : undefined
  const prior = typeof toolCallId === 'string' ? known?.get(toolCallId) : undefined
  const message = approvalSummary((params as { message?: unknown }).message, 'MCP tool permission request')
  const toolParams = params._meta?.tool_params
  const args =
    toolParams && typeof toolParams === 'object' && !Array.isArray(toolParams)
      ? mcpArgumentsSummary(toolParams as Record<string, unknown>)
      : ''
  return { tool: prior?.title || message, detail: prior?.detail || approvalSummary(args, '') }
}

/** The same request as the one line the durable permission row stores. */
export function approvalRequestSummary(parts: ApprovalRequestParts): string {
  return approvalSummary(parts.detail ? `${parts.tool}: ${parts.detail}` : parts.tool, 'Tool permission request')
}

/** True when `none` removed this live IM turn's in-chat card: `hasChatInputCards` says its surface has an approval or elicitation card at all; frozen at dispatch. */
export function noneSuppressedApprovalSurface(
  mode: string,
  turn: { platform: string; webchat?: unknown; headless?: boolean },
  hasChatInputCards = false
): boolean {
  return mode === 'none' && hasChatInputCards && !turn.webchat && !turn.headless
}
