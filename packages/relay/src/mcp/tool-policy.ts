// Judges a restricted agent grant's MCP traffic against its decision table (mcp-tool-permissions.md §6.2).
import { Transform, type TransformCallback } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** The tools a restricted grant may call; every other name, approval-gated ones included until approvals ship, is Blocked. */
export interface ToolDecisions {
  allow: ReadonlySet<string>
}

/** The most a filtered `tools/list` response, or one of its SSE events, may buffer. */
export const TOOLS_LIST_BUFFER_LIMIT = 4 * 1024 * 1024

type Message = Record<string, unknown>

/** What to do with one POST: forward the re-serialized message, or answer it here. */
export type Judgment =
  | { kind: 'forward'; body: string; listIds: Set<string>; refused: [] }
  | { kind: 'respond'; status: number; json?: unknown; refused: string[] }

const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A JSON-RPC id as a map key; ids of different types never collide. */
const idKey = (id: unknown): string => JSON.stringify(id ?? null)

const hasId = (message: Message): boolean => 'id' in message && message.id !== undefined

function blockedResult(name: string): Message {
  return { content: [{ type: 'text', text: `The tool "${name}" is blocked for this agent.` }], isError: true }
}

function rpcError(id: unknown, code: number, message: string): Message {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** The tool a call names, when it is not allowed; undefined when the message is anything but a refused call. */
function refusedTool(message: Message, decisions: ToolDecisions): string | undefined {
  if (message.method !== 'tools/call') return undefined
  const name = isMessage(message.params) ? message.params.name : undefined
  if (typeof name === 'string' && decisions.allow.has(name)) return undefined
  return typeof name === 'string' ? name : '(unnamed)'
}

/** Judge one POST body: refuse calls outside the table here, and forward what was judged rather than the original bytes. */
export function judgeRequest(body: Buffer | undefined, decisions: ToolDecisions): Judgment {
  if (!body || body.length === 0) return { kind: 'forward', body: '', listIds: new Set(), refused: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { kind: 'respond', status: 400, json: rpcError(null, -32700, 'parse error'), refused: [] }
  }
  const batch = Array.isArray(parsed)
  const messages = batch ? (parsed as unknown[]) : [parsed]
  if (messages.length === 0 || !messages.every(isMessage)) {
    return { kind: 'respond', status: 400, json: rpcError(null, -32600, 'invalid request'), refused: [] }
  }
  const refusals = messages.map((message) => refusedTool(message as Message, decisions))
  const refused = refusals.filter((name): name is string => name !== undefined)
  if (refused.length > 0) {
    const answers = (messages as Message[]).flatMap((message, i) => {
      if (!hasId(message)) return []
      const name = refusals[i]
      if (name !== undefined) return [{ jsonrpc: '2.0', id: message.id, result: blockedResult(name) }]
      return [rpcError(message.id, -32600, 'batch rejected: it contains a tool call blocked for this agent')]
    })
    if (answers.length === 0) return { kind: 'respond', status: 202, refused }
    return { kind: 'respond', status: 200, json: batch ? answers : answers[0], refused }
  }
  const listIds = new Set<string>()
  for (const message of messages as Message[]) {
    if (message.method === 'tools/list' && hasId(message)) listIds.add(idKey(message.id))
  }
  return { kind: 'forward', body: JSON.stringify(parsed), listIds, refused: [] }
}

/** Keep only allowed tools in a response to one of `listIds`; anything that cannot be filtered becomes an error, never unfiltered data. */
export function filterMessage(message: unknown, decisions: ToolDecisions, listIds: ReadonlySet<string>): unknown {
  if (!isMessage(message) || !hasId(message) || !listIds.has(idKey(message.id)) || !('result' in message)) {
    return message
  }
  const result = message.result
  if (!isMessage(result) || !Array.isArray(result.tools)) {
    return rpcError(message.id, -32603, 'tools/list result could not be filtered')
  }
  const tools = result.tools.filter(
    (tool) => isMessage(tool) && typeof tool.name === 'string' && decisions.allow.has(tool.name)
  )
  return { ...message, result: { ...result, tools } }
}

/** Filter a buffered `application/json` response; an unparseable one answers each listed id with an error. */
export function filterJsonBody(text: string, decisions: ToolDecisions, listIds: ReadonlySet<string>): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const errors = [...listIds].map((key) =>
      rpcError(JSON.parse(key) as unknown, -32603, 'tools/list result could not be filtered')
    )
    return JSON.stringify(errors.length === 1 ? errors[0] : errors)
  }
  const filtered = Array.isArray(parsed)
    ? parsed.map((message) => filterMessage(message, decisions, listIds))
    : filterMessage(parsed, decisions, listIds)
  return JSON.stringify(filtered)
}

/** Split off the next complete SSE event: its text, and the separator that ended it. */
function nextEvent(buffer: string): { event: string; separator: string; rest: string } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
  if (!match) return undefined
  return {
    event: buffer.slice(0, match.index),
    separator: match[0],
    rest: buffer.slice(match.index + match[0].length)
  }
}

/** Rewrite the `data:` of an event that answers a listed id; pass every other event through unchanged. */
function filterEvent(event: string, decisions: ToolDecisions, listIds: ReadonlySet<string>): string {
  const lines = event.split(/\r\n|\n|\r/)
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''))
  if (data.length === 0) return event
  let message: unknown
  try {
    message = JSON.parse(data.join('\n'))
  } catch {
    return event
  }
  const filtered = filterMessage(message, decisions, listIds)
  if (filtered === message) return event
  return [...lines.filter((line) => !line.startsWith('data:')), `data: ${JSON.stringify(filtered)}`].join('\n')
}

/** Filters a `text/event-stream` response event by event; an oversized event ends the stream with an error, never unfiltered data. */
export class SseToolsListFilter extends Transform {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private failed = false

  constructor(
    private readonly decisions: ToolDecisions,
    private readonly listIds: ReadonlySet<string>
  ) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.failed) return done()
    this.buffer += this.decoder.write(chunk)
    this.drain()
    if (this.buffer.length > TOOLS_LIST_BUFFER_LIMIT) {
      this.failed = true
      this.buffer = ''
      const errors = [...this.listIds].map((key) =>
        rpcError(JSON.parse(key) as unknown, -32603, 'tools/list result too large to filter')
      )
      for (const error of errors) this.push(`event: message\ndata: ${JSON.stringify(error)}\n\n`)
      this.push(null)
    }
    done()
  }

  // An event without its terminating blank line is discarded, as an SSE client would discard it.
  override _flush(done: TransformCallback): void {
    if (!this.failed) {
      this.buffer += this.decoder.end()
      this.drain()
    }
    done()
  }

  private drain(): void {
    for (let next = nextEvent(this.buffer); next; next = nextEvent(this.buffer)) {
      this.push(filterEvent(next.event, this.decisions, this.listIds) + next.separator)
      this.buffer = next.rest
    }
  }
}
