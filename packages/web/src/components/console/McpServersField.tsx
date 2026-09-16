// MCP-server helper functions (no component — MCP is agent-scoped and enabled
// from the agent's Tools & Skills card, the sole enablement surface).

import { ADMIN_MCP_SERVER_NAME } from '@agentconnect.md/protocol/consts'
import type { McpServerInfo } from '@/lib/data'

export { ADMIN_MCP_SERVER_NAME }

/** How the built-in admin catalog reads in the console — its wire name is a slug. */
export const ADMIN_MCP_LABEL = 'AgentConnect Admin MCP'

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

/** One MCP server's definition line — what KIND of server it is, worded exactly
 *  as the org registry tiles word it (Tools & Skills page) so the same server
 *  reads identically on both surfaces. Transport is an implementation detail and
 *  lives in the edit dialog. A server the org registry doesn't know (daemon-local
 *  definition) is a custom server by definition. */
export function mcpKindLabel(kind: string | undefined): string {
  if (kind === 'builtin') return 'Builtin'
  return kind === 'open_connector' ? 'Open connector' : 'Custom MCP server'
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
  // The built-in admin catalog belongs to no daemon and no registry: attaching its name IS the
  // entitlement, and the Control Plane installs the conversation-scoped descriptor over http.
  const builtin: McpServerInfo[] = known.has(ADMIN_MCP_SERVER_NAME)
    ? []
    : [{ name: ADMIN_MCP_SERVER_NAME, transport: 'http', builtin: true }]
  return [...builtin, ...servers, ...extra]
}

/** The display line of an MCP server an agent has attached — the built-in catalog states only
 *  what it is, since its transport and definition are the platform's, not the operator's. */
export function mcpServerLabel(name: string): string {
  return name === ADMIN_MCP_SERVER_NAME ? ADMIN_MCP_LABEL : name
}
