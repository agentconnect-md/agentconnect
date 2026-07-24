#!/usr/bin/env node
import { startMem0OpenTelemetry } from './observability.js'

const dialect = process.env.MEM0_DIALECT?.trim().toLowerCase() || 'cloud'
if (dialect !== 'cloud' && dialect !== 'oss') throw new Error('MEM0_DIALECT must be cloud or oss')
const mcpTransport = process.env.MCP_TRANSPORT?.trim().toLowerCase() || 'http'
if (mcpTransport !== 'http' && mcpTransport !== 'stdio') throw new Error('MCP_TRANSPORT must be http or stdio')
const host = process.env.HOST?.trim() || '0.0.0.0'
const port = Number(process.env.PORT ?? 8788)
if (mcpTransport === 'http' && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
  throw new Error('PORT must be an integer from 1 to 65535')
}

// Start the SDK before dynamically loading server -> cloud -> metrics. OTel's
// Metrics API returns permanent no-op instruments when they are constructed
// before a global MeterProvider is registered.
const telemetry = startMem0OpenTelemetry()
let running: { close(): Promise<void> }
try {
  if (mcpTransport === 'stdio') {
    const secret = process.env.MEM0_API_KEY?.trim()
    if (!secret) throw new Error('MEM0_API_KEY is required for stdio')
    // Retain the credential only in the server closure; it is not needed in the
    // wrapper's ambient process environment after operator-controlled startup.
    delete process.env.MEM0_API_KEY
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    const mcp =
      dialect === 'oss'
        ? await (async () => {
            const [{ Mem0OssClient }, { createMem0OssMcpServer }] = await Promise.all([
              import('./oss.js'),
              import('./oss-server.js')
            ])
            return createMem0OssMcpServer(
              new Mem0OssClient({ baseUrl: process.env.MEM0_OSS_BASE_URL?.trim() || undefined }),
              () => secret
            )
          })()
        : await (async () => {
            const [{ Mem0CloudClient }, { createMem0CloudMcpServer }] = await Promise.all([
              import('./cloud.js'),
              import('./server.js')
            ])
            return createMem0CloudMcpServer(new Mem0CloudClient(), () => secret)
          })()
    await mcp.connect(new StdioServerTransport())
    running = { close: () => mcp.close() }
  } else if (dialect === 'oss') {
    const { startMem0OssServer } = await import('./oss-server.js')
    running = await startMem0OssServer({
      host,
      port,
      ...(process.env.MEM0_OSS_BASE_URL?.trim() ? { baseUrl: process.env.MEM0_OSS_BASE_URL.trim() } : {})
    })
  } else {
    const { startMem0CloudServer } = await import('./server.js')
    running = await startMem0CloudServer({ host, port })
  }
} catch (error) {
  await telemetry.shutdown().catch(() => undefined)
  throw error
}

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  const results = await Promise.allSettled([running.close(), telemetry.shutdown()])
  if (results.some((result) => result.status === 'rejected')) process.exitCode = 1
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
if (mcpTransport === 'http') console.log(`AgentConnect Mem0 ${dialect} memory plugin listening on ${host}:${port}`)
