import type { Tool } from '@modelcontextprotocol/server'
import type { AskAnswer, AskModes, AskWire } from './ask.js'

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
  /** What the agent's own MCP host can render (#1965), read from its `initialize` capabilities.
   *  Absent ⇒ this connection cannot ask, so no tool is handed an ask port at all. */
  ask?: AskModes
  /** The host's answers to an earlier round of THIS tool call, keyed by ask key. */
  askAnswers?: Record<string, AskAnswer>
}

export type IpcRequest = IpcListToolsReq | IpcCallToolReq

/** Private-broker-only startup authentication. Shared MCP control sockets never
 * send this operation; it binds one persistent bridge connection to one cell
 * before that bridge exposes its stdio MCP server. */
export interface IpcAttachReq {
  id: number
  token: string
  op: 'attach'
}

export type IpcPrivateRequest = IpcAttachReq | IpcRequest

export interface IpcListToolsResult {
  tools: Tool[]
}

/** A `callTool` that answered with a QUESTION instead of a result (#1965). The bridge
 *  recognizes this marker and re-issues the call once the host has answered. */
export interface IpcAskRequiredResult {
  mcpAsk: AskWire
}

/** Whether a tool result is the ask marker rather than a real result. */
export function isAskRequiredResult(result: unknown): result is IpcAskRequiredResult {
  if (result === null || typeof result !== 'object') return false
  const ask = (result as { mcpAsk?: unknown }).mcpAsk
  return ask !== null && typeof ask === 'object' && typeof (ask as { key?: unknown }).key === 'string'
}

export interface IpcResponse {
  id: number
  ok: boolean
  /** On `listTools`: IpcListToolsResult. On `callTool`: the tool's plain result. */
  result?: unknown
  error?: string
}

/** Frame a message for the wire: compact JSON + a single trailing newline. */
export function encodeFrame(msg: IpcPrivateRequest | IpcResponse): string {
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
