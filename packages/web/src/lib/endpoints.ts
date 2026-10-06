// Public service URLs read from the runtime config (window.__AC_ENV in the browser, process.env on the server); no imports, so route handlers can use them.

// The CP's versioned API base (e.g. `https://api.example.test/v1`); an overriding CP_URL must carry the version path.
export function cpBase(): string {
  const runtime = typeof window !== 'undefined' ? window.__AC_ENV?.CP_URL : process.env.CP_URL
  return (runtime || process.env.NEXT_PUBLIC_CP_URL || 'http://localhost:8080/api/v1').replace(/\/+$/, '')
}

// The public MCP endpoint: the deployment's dedicated MCP origin (MCP_URL), else the CP API base + /mcp.
export function mcpEndpointUrl(): string {
  const dedicated = typeof window !== 'undefined' ? window.__AC_ENV?.MCP_URL : process.env.MCP_URL
  return (dedicated || `${cpBase()}/mcp`).replace(/\/+$/, '')
}
