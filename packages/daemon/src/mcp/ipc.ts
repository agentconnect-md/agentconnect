import type { ToolDescriptor } from './tools.js'

/**
 * Tiny newline-delimited JSON-RPC-ish protocol spoken over the daemon's MCP
 * control socket. The `agentconnect mcp-bridge` subprocess is the client; the
 * daemon is the server. Each request carries the per-session `token` minted at
 * `session/new` so the daemon can resolve which channel/thread/agent it belongs
 * to. This is daemon-internal IPC — NOT a daemon↔CP protocol frame.
 */
export interface IpcListToolsReq {
  id: number
  token: string
  op: 'listTools'
}

export interface IpcCallToolReq {
  id: number
  token: string
  op: 'callTool'
  name: string
  args: Record<string, unknown>
}

export type IpcRequest = IpcListToolsReq | IpcCallToolReq

export interface IpcListToolsResult {
  tools: ToolDescriptor[]
}

export interface IpcResponse {
  id: number
  ok: boolean
  /** On `listTools`: IpcListToolsResult. On `callTool`: the tool's plain result. */
  result?: unknown
  error?: string
}

/** Frame a message for the wire: compact JSON + a single trailing newline. */
export function encodeFrame(msg: IpcRequest | IpcResponse): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Split a buffer of newline-delimited frames into parsed objects plus the
 * trailing partial line. Callers keep `rest` and prepend it to the next chunk.
 *
 * Per-line tolerant: a malformed (non-JSON) line is skipped, not thrown — so one
 * bad frame can't crash a stream reader or discard the good frames batched
 * alongside it in the same chunk. `onError` lets callers log dropped lines.
 */
export function decodeFrames<T>(
  buf: string,
  onError?: (line: string, err: unknown) => void
): { messages: T[]; rest: string } {
  const parts = buf.split('\n')
  const rest = parts.pop() ?? ''
  const messages: T[] = []
  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as T)
    } catch (err) {
      onError?.(trimmed, err)
    }
  }
  return { messages, rest }
}
