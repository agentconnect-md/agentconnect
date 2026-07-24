import { RESERVED_MCP_SERVER_NAME } from '@agentconnect.md/protocol'

export const SESSION_TITLE_TOOL_NAME = 'setSessionTitle'
export const SESSION_TITLE_TOOL_TITLES = [
  `mcp.${RESERVED_MCP_SERVER_NAME}.${SESSION_TITLE_TOOL_NAME}`,
  `mcp__${RESERVED_MCP_SERVER_NAME}__${SESSION_TITLE_TOOL_NAME}`
] as const

const SESSION_TITLE_TOOL_TITLE_SET = new Set<string>(SESSION_TITLE_TOOL_TITLES)

/**
 * True when a Codex ACP tool event is the daemon's session-title fallback. codex-acp
 * exposes MCP identity structurally in rawInput and currently titles the event
 * `mcp.<server>.<tool>`; the exact-title fallbacks cover older adapter renderings
 * without hiding a same-named tool from another MCP server.
 */
export function isSessionTitleToolCall(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const u = update as { sessionUpdate?: unknown; rawInput?: unknown; title?: unknown }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return false
  const rawInput =
    u.rawInput && typeof u.rawInput === 'object' ? (u.rawInput as { server?: unknown; tool?: unknown }) : undefined
  return (
    (rawInput?.server === RESERVED_MCP_SERVER_NAME && rawInput.tool === SESSION_TITLE_TOOL_NAME) ||
    (typeof u.title === 'string' && SESSION_TITLE_TOOL_TITLE_SET.has(u.title))
  )
}
