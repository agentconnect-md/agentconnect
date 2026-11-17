import type { RuntimeDef } from '../config/config-schema.js'

export type SessionMcpServersScope = NonNullable<RuntimeDef['sessionMcpServers']>

// Audited against opencode 2.2.5, kilo 7.5.6 and deepseek-harness-acp 0.4.41: session MCP servers mount once per process by name, a later session's spec replacing an earlier one's.
const PER_PROCESS_SESSION_MCP_RUNTIMES: ReadonlySet<string> = new Set(['opencode', 'kilo', 'dsh-acp'])

/** The scope a RuntimeDef declares, else the audited one for its id — a replacement harness under a reused id inherits it until it declares its own. */
export function sessionMcpServersScope(
  runtimeId: string,
  runtime?: Pick<RuntimeDef, 'sessionMcpServers'>
): SessionMcpServersScope {
  return runtime?.sessionMcpServers ?? (PER_PROCESS_SESSION_MCP_RUNTIMES.has(runtimeId) ? 'per-process' : 'per-session')
}
