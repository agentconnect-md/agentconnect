import { RESERVED_MCP_SERVER_NAME } from '@agentconnect.md/protocol'

/** Transcript titles of the retired model-authored `setSessionTitle` tool call. No live session
 *  can produce one anymore; the store still hides rows recorded while the tool existed. */
export const SESSION_TITLE_TOOL_TITLES = [
  `mcp.${RESERVED_MCP_SERVER_NAME}.setSessionTitle`,
  `mcp__${RESERVED_MCP_SERVER_NAME}__setSessionTitle`
] as const
