import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { ALL_TOOL_NAMES } from '../mcp/tools.js'
import { RESERVED_MCP_SERVER_NAME } from '../mcp/resolve-servers.js'
import { turnChromeFor } from '../platforms/turn-chrome.js'

// ACP runtime identities for THIS daemon's own MCP tools. ALL_TOOL_NAMES is the
// registry of every tool the agentconnect MCP server can inject; both approval
// transports below derive their trust policy from this same set.
const BUILTIN_TOOL_NAMES = new Set(ALL_TOOL_NAMES)
const BUILTIN_PERMISSION_TOOL_FQNS = new Set(ALL_TOOL_NAMES.map((name) => `mcp__${RESERVED_MCP_SERVER_NAME}__${name}`))
const BUILTIN_TOOL_FQNS = new Set(
  ALL_TOOL_NAMES.flatMap((name) => [
    `mcp__${RESERVED_MCP_SERVER_NAME}__${name}`,
    `mcp.${RESERVED_MCP_SERVER_NAME}.${name}`
  ])
)

function containsBuiltinToolFqn(id: string): boolean {
  if (BUILTIN_TOOL_FQNS.has(id)) return true
  // Some ACP adapters suffix an opaque invocation id to the flattened MCP name.
  for (const fqn of BUILTIN_PERMISSION_TOOL_FQNS) if (id.includes(fqn)) return true
  return false
}

/** Identify a structured ACP tool event for one of this daemon's own MCP tools. */
export function isBuiltinSystemToolCall(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const u = update as { sessionUpdate?: unknown; rawInput?: unknown; title?: unknown }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return false
  const rawInput =
    u.rawInput && typeof u.rawInput === 'object' ? (u.rawInput as { server?: unknown; tool?: unknown }) : undefined
  // When the adapter provides structured identity, it is authoritative. Do not let
  // a friendly/misleading display title override a different MCP server identity.
  if (rawInput && (rawInput.server !== undefined || rawInput.tool !== undefined)) {
    return (
      rawInput.server === RESERVED_MCP_SERVER_NAME &&
      typeof rawInput.tool === 'string' &&
      BUILTIN_TOOL_NAMES.has(rawInput.tool)
    )
  }
  return typeof u.title === 'string' && BUILTIN_TOOL_FQNS.has(u.title)
}

/**
 * True when an ACP permission request is for one of the daemon's OWN built-in MCP tools.
 * Those are platform system tools the agent is always granted — a human should never have
 * to approve them per call (they carry no more authority than the agent already has). We
 * match the runtime-assigned `mcp__agentconnect__<name>` FQN against our registered tool
 * set across the request's identifying fields (`title`/`kind`/`toolCallId`). Deliberately
 * strict + fail-SAFE: an unrecognized/friendly title simply falls through to the normal
 * permission card, never a wrongful auto-allow. The runtime's own dangerous built-ins
 * (Bash/Edit/…) carry different names, are NOT in this set, and still prompt.
 */
export function isBuiltinSystemTool(
  params: RequestPermissionRequest,
  correlatedToolCallIds?: ReadonlySet<string>
): boolean {
  const tc = params.toolCall
  if (typeof tc?.toolCallId === 'string' && correlatedToolCallIds?.has(tc.toolCallId)) return true
  const ids = [tc?.title, tc?.kind, tc?.toolCallId]
  return ids.some((id) => typeof id === 'string' && containsBuiltinToolFqn(id))
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
 * Scoped narrowly to the surface `none` actually removes: an interactive card renders ONLY
 * on Slack (see `onAcpPermission`), and only for a live user turn. So this is true iff the
 * turn is `none` AND on Slack AND not webchat/headless. Telegram/Discord/Feishu have no card
 * surface, so `none` removes nothing there; webchat/headless are non-IM transports.
 * Computed once at dispatch (frozen for the turn) so a mid-turn mode flip can't desync it
 * from the connection it was derived from.
 */
export function noneSuppressedApprovalSurface(
  mode: string,
  turn: { platform: string; webchat?: unknown; headless?: boolean }
): boolean {
  return mode === 'none' && turnChromeFor(turn.platform).chatInputCards === true && !turn.webchat && !turn.headless
}
