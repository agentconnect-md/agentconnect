import type { RuntimeDef } from '../config/config-schema.js'

// Audited: these runtimes hand an MCP tool result's `image` content to the model, which computer use needs (computer-use.md §5.2).
const SHOWS_MCP_IMAGES_RUNTIMES: ReadonlySet<string> = new Set(['claude-acp', 'codex-acp'])

/** Whether a runtime shows the model MCP image content: as its RuntimeDef declares, else as audited for its id. */
export function showsMcpImages(runtimeId: string, runtime?: Pick<RuntimeDef, 'mcpImageContent'>): boolean {
  return runtime?.mcpImageContent ?? SHOWS_MCP_IMAGES_RUNTIMES.has(runtimeId)
}
