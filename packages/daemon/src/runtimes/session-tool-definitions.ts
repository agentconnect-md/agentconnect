import type { RuntimeDef } from '../config/config-schema.js'

// Audited against claude-agent-acp 0.93.0: a loaded session renders the tool definitions its transcript recorded, adding only new names.
const KEEPS_SESSION_TOOL_DEFINITIONS_RUNTIMES: ReadonlySet<string> = new Set(['claude-acp'])

/** Whether a runtime keeps a session's earlier tool definitions across a load: as its RuntimeDef declares, else as audited for its id. */
export function keepsSessionToolDefinitions(
  runtimeId: string,
  runtime?: Pick<RuntimeDef, 'keepsSessionToolDefinitions'>
): boolean {
  return runtime?.keepsSessionToolDefinitions ?? KEEPS_SESSION_TOOL_DEFINITIONS_RUNTIMES.has(runtimeId)
}
