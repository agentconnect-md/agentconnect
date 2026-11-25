import type { RuntimeDef } from '../config/config-schema.js'

/** The Antigravity CLI's ACP server (`agy acp`), under any path to the binary. */
export function isAntigravityRuntimeDef(runtime: RuntimeDef): boolean {
  return /(?:^|[\\/])agy(?:\.exe)?$/i.test(runtime.command) && runtime.args[0] === 'acp'
}

// These verified releases omit the MCP transport declaration but handle Streamable HTTP.
export function antigravityMcpFallback(id?: string, name?: string, version?: string) {
  if (id === 'antigravity-acp' && name === 'Antigravity ACP Server' && (version === '1.5.14' || version === '1.5.17')) {
    return { http: true, sse: false }
  }
  return undefined
}
