import type { RuntimeDef } from '../config/config-schema.js'

/** The Antigravity CLI's ACP server (`agy acp`), under any path to the binary. */
export function isAntigravityRuntimeDef(runtime: RuntimeDef): boolean {
  return /(?:^|[\\/])agy(?:\.exe)?$/i.test(runtime.command) && runtime.args[0] === 'acp'
}

// Use native agy's known transports when its handshake omits MCP capabilities.
export function antigravityMcpFallback(id?: string, name?: string) {
  if (id === 'antigravity-acp' && name === 'Antigravity ACP Server') {
    return { http: true, sse: false }
  }
  return undefined
}
