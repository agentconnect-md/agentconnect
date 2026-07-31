import type { ResolvedRuntimeEntry } from '../runtimes/registry.js'

/**
 * Adapter ids validated for the remote `agentconnect-admin` descriptor.
 *
 * These are the two curated adapters whose descriptor handling is covered by
 * runtime integration testing: both consume `mcpServers[].headers` purely as
 * transport configuration (never model context, logs, or diagnostics) and
 * scope descriptors per ACP session. Extending this set requires equivalent
 * integration coverage for the new adapter
 * (docs/designs/webchat-preset-agentconnect-mcp.md §13).
 */
const VALIDATED_REMOTE_MCP_RUNTIME_IDS: ReadonlySet<string> = new Set(['claude-acp', 'codex-acp'])

/**
 * Whether a runtime may receive the bearer-bearing remote MCP descriptor.
 *
 * The binding is daemon-owned adapter PROVENANCE, not launch-line inference:
 * the id must be one of the validated canonical adapters AND its definition
 * must come from the daemon's own resolution of the curated catalog / public
 * ACP registry document (`source: 'curated' | 'registry'`). A user-configured
 * runtime — including one that shadows a validated id or aliases a
 * claude/codex-looking command — is `source: 'user'` and is never admitted:
 * an arbitrary executable proves nothing about private transport headers,
 * per-session descriptor isolation, or stable invocation ids (§13 explicitly
 * forbids inferring support from executable presence or generic MCP support).
 *
 * Callers additionally require the daemon's own ACP probe of that exact id to
 * have succeeded and advertised HTTP MCP transport (`runtimeMcpCaps`), so a
 * validated id that is not actually installed/behaving stays out.
 */
export function isValidatedRemoteMcpRuntime(runtimeId: string, entry: ResolvedRuntimeEntry | undefined): boolean {
  if (!entry || !VALIDATED_REMOTE_MCP_RUNTIME_IDS.has(runtimeId)) return false
  return entry.source === 'curated' || entry.source === 'registry'
}
