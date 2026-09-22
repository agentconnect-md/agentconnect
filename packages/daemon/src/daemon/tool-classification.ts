import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { ALL_TOOL_NAMES } from '../mcp/tools.js'
import { RESERVED_MCP_SERVER_NAME } from '../mcp/resolve-servers.js'
import { turnChromeFor } from '../platforms/turn-chrome.js'

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
  return ''
}

/** One approval request, split the way a surface renders it: the action, then its one-line input. */
export interface ApprovalRequestParts {
  tool: string
  detail: string
}

export function permissionRequestParts(params: RequestPermissionRequest): ApprovalRequestParts {
  return {
    tool: approvalSummary(params.toolCall?.title ?? params.toolCall?.kind, 'Tool permission request'),
    detail: approvalSummary(approvalInputSummary(params.toolCall?.rawInput), '')
  }
}

export function elicitationApprovalParts(params: CreateElicitationRequest): ApprovalRequestParts {
  return { tool: approvalSummary((params as { message?: unknown }).message, 'MCP tool permission request'), detail: '' }
}

/** The same request as the one line the durable permission row stores. */
export function approvalRequestSummary(parts: ApprovalRequestParts): string {
  return approvalSummary(parts.detail ? `${parts.tool}: ${parts.detail}` : parts.tool, 'Tool permission request')
}

/**
 * True when `none` output mode removed THIS turn's interactive permission/elicitation
 * surface. Permission requests still enter the Agent-editor queue; this flag only prevents
 * a chat-side card from being rendered for the turn.
 *
 * Scoped narrowly to the surface `none` actually removes: a live user turn on a platform that
 * HAS an in-chat card at all. `hasChatInputCards` is that fact, and it is passed in rather than
 * looked up because it now has two independent sources — Slack's permission-approval chrome
 * (`turnChromeFor(...).chatInputCards`) and any platform's Layer-2 elicitation-card facet — and
 * either one means `none` removed something. Discord and Feishu still have neither, so `none`
 * removes nothing there; webchat/headless are non-IM transports. Computed once at dispatch
 * (frozen for the turn) so a mid-turn mode flip can't desync it from the connection it was
 * derived from.
 */
export function noneSuppressedApprovalSurface(
  mode: string,
  turn: { platform: string; webchat?: unknown; headless?: boolean },
  hasChatInputCards = false
): boolean {
  const surfaced = hasChatInputCards || turnChromeFor(turn.platform).chatInputCards === true
  return mode === 'none' && surfaced && !turn.webchat && !turn.headless
}
