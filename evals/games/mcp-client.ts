/**
 * Minimal daemon-IPC client for scripted ACP hosts — the minimal slice of the
 * deferred §14 evaluation tool surface the routing acceptance suite needs.
 *
 * A scripted host must be able to issue REAL product tool calls (sendMessage)
 * during a turn — never a world shortcut. Hosts receive the bridge MCP server
 * definition at `session/new` (AC_MCP_ENDPOINT + AC_MCP_TOKEN in its env)
 * exactly like a real runtime, and this client speaks the same newline-framed
 * IPC the `mcp-bridge` subprocess speaks, so the call runs the production
 * path: trusted SessionContext, gateway resolution, identity stamping,
 * transcript recording, and the world's §7.2 authorization.
 */
import net from 'node:net'

export interface DaemonMcpBinding {
  endpoint: string
  token: string
}

/** Extract the bridge binding from the `mcpServers` array passed to
 *  `session/new`. Returns undefined when the session has no daemon tools. */
export function daemonMcpBinding(mcpServers: unknown): DaemonMcpBinding | undefined {
  if (!Array.isArray(mcpServers)) return undefined
  for (const server of mcpServers) {
    const env = (server as { env?: { name?: unknown; value?: unknown }[] }).env
    if (!Array.isArray(env)) continue
    const endpoint = env.find((entry) => entry?.name === 'AC_MCP_ENDPOINT')?.value
    const token = env.find((entry) => entry?.name === 'AC_MCP_TOKEN')?.value
    if (typeof endpoint === 'string' && typeof token === 'string') return { endpoint, token }
  }
  return undefined
}

export interface DaemonToolCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** One `listTools` round-trip: the descriptor names THIS session actually
 *  carries — how a test proves a surface was presented (or withheld). */
export async function listDaemonTools(binding: DaemonMcpBinding, timeoutMs = 30_000): Promise<string[]> {
  const response = await ipcRequest(binding, { op: 'listTools' }, timeoutMs)
  if (!response.ok) throw new Error(response.error ?? 'listTools failed')
  const tools = (response.result as { tools?: { name?: unknown }[] } | undefined)?.tools ?? []
  return tools.map((tool) => String(tool.name))
}

function ipcRequest(
  binding: DaemonMcpBinding,
  request: Record<string, unknown>,
  timeoutMs: number
): Promise<DaemonToolCallResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(binding.endpoint)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`daemon ipc request timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      settle()
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, token: binding.token, ...request })}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      try {
        const response = JSON.parse(line) as { ok?: boolean; result?: unknown; error?: string }
        finish(() =>
          resolve({
            ok: response.ok === true,
            ...(response.result !== undefined ? { result: response.result } : {}),
            ...(typeof response.error === 'string' ? { error: response.error } : {})
          })
        )
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
    })
    socket.on('error', (error) => finish(() => reject(error)))
  })
}

/** One `callTool` round-trip over the daemon's MCP control socket. */
export function callDaemonTool(
  binding: DaemonMcpBinding,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<DaemonToolCallResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(binding.endpoint)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`daemon tool call ${name} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      settle()
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, token: binding.token, op: 'callTool', name, args })}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      try {
        const response = JSON.parse(line) as { ok?: boolean; result?: unknown; error?: string }
        finish(() =>
          resolve({
            ok: response.ok === true,
            ...(response.result !== undefined ? { result: response.result } : {}),
            ...(typeof response.error === 'string' ? { error: response.error } : {})
          })
        )
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
    })
    socket.on('error', (error) => finish(() => reject(error)))
  })
}
