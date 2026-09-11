import type { McpServer } from '@agentclientprotocol/sdk'
import { RESERVED_MCP_SERVER_NAME, type McpTransportCapabilities } from '@agentconnect.md/protocol'
import type { McpServerDef } from '../config/config-schema.js'

export { RESERVED_MCP_SERVER_NAME }

/**
 * Resolve an agent's enabled MCP-server names against the daemon's configured
 * definitions, producing the ACP `McpServer` entries to attach at
 * session/new|load (after the daemon's own bridge entry).
 *
 * A `ui: true` server the daemon ACTUALLY HOSTS is skipped silently and is not a failure: it is
 * daemon-hosted (webchat-mcp-apps.md §4), so its tools reach the runtime through the daemon bridge
 * instead. Handing it over here as well would make every one of its tools callable on two paths,
 * and only the bridge path renders the interface.
 *
 * A `ui: true` server the daemon does NOT host — a CP-pushed definition, which v1's Apps host does
 * not dial (§4) — is attached as an ordinary server with a warn. Skipping it here would delete the
 * tools entirely, since nothing else would carry them: losing the interface is a degradation, and
 * losing the tools is a hole.
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
  /** Whether this daemon's MCP Apps host actually hosts `name` — the only thing that makes a
   *  `ui` server safe to withhold from the runtime. Absent ⇒ nothing hosts any of them, and a
   *  `ui` server is attached as an ordinary one. */
  hostsUiServer?: (name: string) => boolean
  /** Sandbox launches normalize trusted commands before HOME is hidden. */
  resolveStdioCommand?: (command: string, env: McpServerDef['env']) => string
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
    if (def.ui === true) {
      // Daemon-hosted: the bridge carries its tools, so the runtime must not also dial it.
      if (opts.hostsUiServer?.(name) === true) continue
      opts.warn?.(
        `mcp: server "${name}" asks to be daemon-hosted, which this daemon does not do for it — attached without its interface`
      )
    }
    if (def.transport === 'stdio') {
      // The untagged variant IS the stdio one (ACP McpServer union).
      out.push({
        name,
        command: opts.resolveStdioCommand?.(def.command!, def.env) ?? def.command!,
        args: def.args,
        env: def.env
      })
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
