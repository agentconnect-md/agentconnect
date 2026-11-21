// Native 1.5.14 omits the MCP transport declaration but handles streamable HTTP.
export function antigravityMcpFallback(id?: string, name?: string, version?: string) {
  if (id === 'antigravity-acp' && name === 'Antigravity ACP Server' && version === '1.5.14') {
    return { http: true, sse: false }
  }
  return undefined
}
