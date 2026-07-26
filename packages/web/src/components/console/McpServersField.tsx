// MCP-server helper functions (no component — MCP is agent-scoped and enabled
// from the agent's Tools & Skills card, the sole enablement surface).

import type { McpServerInfo } from '@/lib/data'

/** MCP transports a runtime accepts at session/new (protocol `McpTransportCapabilities`). */
export interface McpTransportCaps {
  http: boolean
  sse: boolean
}

// stdio is the ACP baseline every runtime can attach; http/sse need the runtime
// to advertise them. `caps` null ⇒ the runtime wasn't probed for MCP support yet
// (older daemon, or a probe sweep still running) ⇒ optimistic, matching the
// daemon's resolve-servers rule — a transient null must not strip saved names.
export function mcpTransportSupported(
  transport: McpServerInfo['transport'],
  caps: McpTransportCaps | null | undefined
): boolean {
  if (transport === 'stdio' || !caps) return true
  return transport === 'http' ? caps.http : caps.sse
}

/** The probed MCP transport caps of one runtime on a daemon (null ⇒ not probed). */
export function mcpCapsFor(
  runtimeModels: { runtime: string; mcpCapabilities?: McpTransportCaps | null }[] | undefined,
  runtime: string
): McpTransportCaps | null {
  return runtimeModels?.find((r) => r.runtime === runtime)?.mcpCapabilities ?? null
}

// ── Shared MCP definition source ────────────────────────────────────────────
// The "what servers, and what each one is" lives here, once — consumed by the
// agent's Tools & Skills card (the enablement surface), never restated at a
// call site.

/** The daemon-configured MCP servers a given runtime can actually attach: the
 *  daemon's `servers` gated by that runtime's advertised transport support
 *  (stdio always; http/sse only if probed on). `caps` null ⇒ not probed ⇒
 *  optimistic, matching the daemon's own resolve-servers rule. */
export function mcpServersForRuntime(
  servers: McpServerInfo[],
  caps: McpTransportCaps | null | undefined
): McpServerInfo[] {
  return servers.filter((s) => mcpTransportSupported(s.transport, caps))
}

/** One MCP server's definition line — its transport. Shared so every surface
 *  labels a server identically. A registry-only candidate the daemon hasn't
 *  reported yet is labelled by origin. */
export function mcpServerMeta(s: McpServerInfo): string {
  return s.registry ? `${s.transport} · org registry` : s.transport
}

/** Candidate MCP servers an agent can enable: the daemon-configured servers plus
 *  any org MCP-provider registry names the daemon hasn't reported yet — the latter
 *  synthesized as `http` servers (the proxy transport) so they can be enabled BEFORE
 *  the daemon holds the def; the CP pushes the proxy def on enable. */
export function mcpCandidates(servers: McpServerInfo[], registryNames: readonly string[]): McpServerInfo[] {
  const known = new Set(servers.map((s) => s.name))
  const extra = registryNames
    .filter((n) => !known.has(n))
    .map((name): McpServerInfo => ({ name, transport: 'http', registry: true }))
  return [...servers, ...extra]
}
