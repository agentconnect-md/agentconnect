import type { RuntimeDef } from '../config/config-schema.js'

export type SessionMcpServersScope = NonNullable<RuntimeDef['sessionMcpServers']>

// Audited against opencode 2.2.5 and kilo 7.5.6: ACP session MCP servers register on the cwd's instance by name, replacing the one an earlier session registered.
const PER_PROCESS_SESSION_MCP_RUNTIMES: ReadonlySet<string> = new Set(['opencode', 'kilo'])

/** The scope a RuntimeDef declares, else the audited one for its id — a replacement harness under a reused id inherits it until it declares its own. */
export function sessionMcpServersScope(
  runtimeId: string,
  runtime?: Pick<RuntimeDef, 'sessionMcpServers'>
): SessionMcpServersScope {
  return runtime?.sessionMcpServers ?? (PER_PROCESS_SESSION_MCP_RUNTIMES.has(runtimeId) ? 'per-process' : 'per-session')
}
