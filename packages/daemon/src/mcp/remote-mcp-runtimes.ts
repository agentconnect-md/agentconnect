import type { RuntimeDef } from '../config/config-schema.js'
import { isClaudeRuntimeDef } from '../acp/claude-runtime.js'

/** Same launch-line predicate as `Daemon.isCodexRuntime`: registry ids are
 *  canonical, command/args matching keeps user-defined runtime aliases working. */
const CODEX_ACP_RE = /(?:^|[\\/])codex-acp(?:@[^\\/]*)?$/

/**
 * Runtimes validated for the remote `agentconnect-admin` descriptor.
 *
 * Advertising generic HTTPS MCP support proves only descriptor transport. The
 * bearer in the descriptor additionally requires that the runtime keeps MCP
 * transport headers out of model-visible context, logs, diagnostics, and any
 * agent-wide shared-session state — a behavioral property that
 * docs/designs/webchat-preset-agentconnect-mcp.md §13 forbids inferring from
 * operating system, executable presence, or generic MCP capability alone.
 *
 * This is therefore a narrow allowlist of the two curated adapters whose
 * descriptor handling is covered by runtime integration testing (claude-acp and
 * codex-acp): both consume `mcpServers[].headers` purely as transport
 * configuration and scope descriptors per ACP session. Extending this list
 * requires equivalent integration coverage for the new adapter, not just an
 * `initialize` capability bit.
 */
export function isValidatedRemoteMcpRuntime(runtimeId: string, def: RuntimeDef | undefined): boolean {
  if (!def) return false
  if (isClaudeRuntimeDef(def)) return true
  return [runtimeId, def.command, ...def.args].some(
    (part) => typeof part === 'string' && CODEX_ACP_RE.test(part.toLowerCase())
  )
}
