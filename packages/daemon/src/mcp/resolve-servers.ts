import type { McpServer } from '@agentclientprotocol/sdk'
import { RESERVED_MCP_SERVER_NAME, type McpTransportCapabilities } from '@agentconnect.md/protocol'
import type { McpServerDef } from '../config/config-schema.js'

export { RESERVED_MCP_SERVER_NAME }

/**
 * Resolve an agent's enabled MCP-server names against the daemon's configured
 * definitions, producing the ACP `McpServer` entries to attach at
 * session/new|load (after the daemon's own bridge entry).
 *
 * Skips (with a warn) rather than fails: an unknown name, the reserved bridge
 * name, and an http/sse server the agent's runtime is KNOWN not to accept
 * (`caps` from the runtime probe). When `caps` is undefined (runtime not probed
 * yet) http/sse entries are included optimistically — the runtime rejecting an
 * unsupported transport at session/new is a clearer failure than silently
 * withholding a server the user enabled.
 */
export function resolveAgentMcpServers(opts: {
  /** Names the agent enabled (`agent.mcpServers`). */
  enabled: string[]
  /** Daemon-configured definitions (config `mcpServers`, reserved key pre-stripped). */
  defs: Record<string, McpServerDef>
  /** Probed MCP transport caps of the agent's runtime; undefined ⇒ not probed. */
  caps?: McpTransportCapabilities
  warn?: (msg: string) => void
}): McpServer[] {
  const out: McpServer[] = []
  for (const name of opts.enabled) {
    if (name === RESERVED_MCP_SERVER_NAME) {
      opts.warn?.(`mcp: server name "${name}" is reserved for the daemon bridge — skipped`)
      continue
    }
    const def = opts.defs[name]
    if (!def) {
      opts.warn?.(`mcp: server "${name}" is not configured on this daemon — skipped`)
      continue
    }
    if (def.transport === 'stdio') {
      // The untagged variant IS the stdio one (ACP McpServer union).
      out.push({ name, command: def.command!, args: def.args, env: def.env })
      continue
    }
    if (opts.caps && !opts.caps[def.transport]) {
      opts.warn?.(
        `mcp: server "${name}" needs the ${def.transport} transport, which the runtime doesn't accept — skipped`
      )
      continue
    }
    out.push({ type: def.transport, name, url: def.url!, headers: def.headers })
  }
  return out
}
