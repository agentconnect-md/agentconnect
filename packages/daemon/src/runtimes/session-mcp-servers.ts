import type { RuntimeDef } from '../config/config-schema.js'
import { OPENCODE_LINEAGE_RUNTIMES } from '../runtime-defs/opencode-runtime.js'

/** The scope a RuntimeDef declares, else the audited one for its id — a replacement harness under a reused id inherits it until it declares its own. */
export function sessionMcpServersScope(runtimeId: string, runtime?: Pick<RuntimeDef, 'sessionMcpServers'>) {
  return runtime?.sessionMcpServers ?? (OPENCODE_LINEAGE_RUNTIMES.has(runtimeId) ? 'per-process' : 'per-session')
}
