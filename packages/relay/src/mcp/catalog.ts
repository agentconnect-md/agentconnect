// Lists a provider's tools for the console through the relay's own binding and egress (mcp-tool-permissions.md §4).
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import {
  MCP_CATALOG_DESCRIPTION_MAX,
  MCP_TOOL_LIST_MAX,
  MCP_TOOL_NAME_MAX,
  type McpCatalogFailure,
  type McpCatalogTool,
  type RcMcpCatalogOk
} from '@agentconnect.md/protocol'
import type { McpUpstream } from './binding-table.js'
import { isBlockedIp, makeGuardedLookup } from './ssrf.js'
import {
  isOpenConnectorBinding,
  openConnectorBase,
  readBindingHeader,
  respondOpenConnector,
  OPEN_CONNECTOR_ALIAS_HEADER,
  OPEN_CONNECTOR_SERVICE_HEADER
} from './open-connector.js'

export interface CatalogDeps {
  /** Lowercased hostnames allowed to resolve to private addresses, as for the proxy. */
  allowlist: Set<string>
  openConnectorUrl?: string
  openConnectorToken?: string
  /** The whole fetch's budget. */
  timeoutMs?: number
}

const TIMEOUT_MS = 10_000
const MAX_PAGES = 10
const MAX_RESPONSE_BYTES = 1024 * 1024
/** The reply must fit one relay frame, which the relay cannot fragment. */
const MAX_REPLY_BYTES = 200 * 1024
const PROTOCOL_VERSION = '2025-06-18'

class CatalogError extends Error {
  constructor(readonly failure: McpCatalogFailure) {
    super(failure)
  }
}

type Message = Record<string, unknown>
const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Fetch one provider's catalog, answering with tools or a closed failure code; never throws. */
export async function fetchMcpCatalog(up: McpUpstream | null, deps: CatalogDeps): Promise<RcMcpCatalogOk> {
  if (!up) return { failure: 'unknown_provider' }
  try {
    const raw =
      deps.openConnectorUrl && isOpenConnectorBinding(up.headers)
        ? await openConnectorTools(up, deps.openConnectorUrl, deps.openConnectorToken)
        : await upstreamTools(up, deps)
    return fitReply(raw.map(catalogTool).filter((tool): tool is McpCatalogTool => tool !== undefined))
  } catch (err) {
    return { failure: err instanceof CatalogError ? err.failure : 'unreachable' }
  }
}

/** Map one listed tool to its catalog entry; a tool without a usable name is skipped. */
export function catalogTool(tool: unknown): McpCatalogTool | undefined {
  if (!isMessage(tool) || typeof tool.name !== 'string' || tool.name.length === 0) return undefined
  if (tool.name.length > MCP_TOOL_NAME_MAX) return undefined
  const annotations = isMessage(tool.annotations) ? tool.annotations : {}
  const meta = isMessage(tool._meta) ? tool._meta : {}
  const ui = isMessage(meta.ui) ? meta.ui : {}
  const title = typeof tool.title === 'string' ? tool.title : annotations.title
  const hint = (key: string) => (typeof annotations[key] === 'boolean' ? { [key]: annotations[key] as boolean } : {})
  return {
    name: tool.name,
    ...(typeof title === 'string' ? { title: title.slice(0, 256) } : {}),
    ...(typeof tool.description === 'string'
      ? { description: tool.description.slice(0, MCP_CATALOG_DESCRIPTION_MAX) }
      : {}),
    ...hint('readOnlyHint'),
    ...hint('destructiveHint'),
    ...hint('idempotentHint'),
    ...hint('openWorldHint'),
    interactive: typeof ui.resourceUri === 'string' || typeof meta['ui/resourceUri'] === 'string'
  }
}

/** Keep the reply within one frame: drop descriptions first, then give up. */
function fitReply(tools: McpCatalogTool[]): RcMcpCatalogOk {
  if (tools.length > MCP_TOOL_LIST_MAX) return { failure: 'too_large' }
  if (Buffer.byteLength(JSON.stringify(tools)) <= MAX_REPLY_BYTES) return { tools }
  const bare = tools.map(({ description: _description, ...tool }) => tool)
  if (Buffer.byteLength(JSON.stringify(bare)) <= MAX_REPLY_BYTES) return { tools: bare }
  return { failure: 'too_large' }
}

async function openConnectorTools(up: McpUpstream, operatorUrl: string, token?: string): Promise<unknown[]> {
  const service = readBindingHeader(up.headers, OPEN_CONNECTOR_SERVICE_HEADER)
  const profile = readBindingHeader(up.headers, OPEN_CONNECTOR_ALIAS_HEADER)
  if (!service || !profile) throw new CatalogError('misconfigured')
  const { json } = await respondOpenConnector(
    { base: openConnectorBase(operatorUrl), service, profile, ...(token ? { token } : {}) },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  )
  const result = isMessage(json) && isMessage(json.result) ? json.result : undefined
  if (!result || !Array.isArray(result.tools)) throw new CatalogError('unreachable')
  return result.tools
}

interface Exchange {
  status: number
  headers: IncomingHttpHeaders
  text: string
}

/** A minimal Streamable HTTP client session: initialize, page through tools/list, end the session. */
async function upstreamTools(up: McpUpstream, deps: CatalogDeps): Promise<unknown[]> {
  let target: URL
  try {
    target = new URL(up.upstreamUrl)
  } catch {
    throw new CatalogError('misconfigured')
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
    throw new CatalogError('misconfigured')
  }
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const allowPrivate = deps.allowlist.has(host.toLowerCase())
  if (!allowPrivate && isIP(host) && isBlockedIp(host)) throw new CatalogError('blocked_address')

  const deadline = Date.now() + (deps.timeoutMs ?? TIMEOUT_MS)
  let budget = MAX_RESPONSE_BYTES
  let session: string | undefined
  let version = PROTOCOL_VERSION
  const send = async (method: 'POST' | 'DELETE', message?: Message): Promise<Exchange> => {
    const extra: OutgoingHttpHeaders = {
      accept: 'application/json, text/event-stream',
      ...(message ? { 'content-type': 'application/json' } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
      ...(method === 'POST' && message?.method !== 'initialize' ? { 'mcp-protocol-version': version } : {})
    }
    const exchange = await guardedExchange(target, method, up.headers, extra, message, allowPrivate, deadline, budget)
    budget -= Buffer.byteLength(exchange.text)
    return exchange
  }

  let nextId = 1
  const call = async (method: string, params: Message): Promise<{ result: Message; headers: IncomingHttpHeaders }> => {
    const id = nextId++
    const exchange = await send('POST', { jsonrpc: '2.0', id, method, params })
    checkStatus(exchange.status)
    const reply = findReply(exchange, id)
    if (!reply || !isMessage(reply.result)) throw new CatalogError('invalid_response')
    return { result: reply.result, headers: exchange.headers }
  }

  try {
    const init = await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agentconnect-relay-catalog', version: '1' }
    })
    if (typeof init.result.protocolVersion === 'string') version = init.result.protocolVersion
    session = firstHeader(init.headers, 'mcp-session-id')
    checkStatus((await send('POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).status)
    const tools: unknown[] = []
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) throw new CatalogError('too_large')
      const { result } = await call('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(result.tools)) throw new CatalogError('invalid_response')
      tools.push(...result.tools)
      if (tools.length > MCP_TOOL_LIST_MAX) throw new CatalogError('too_large')
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length === 0) return tools
      cursor = result.nextCursor
    }
  } finally {
    if (session) await send('DELETE').catch(() => undefined)
  }
}

function checkStatus(status: number): void {
  if (status >= 300 && status < 400) throw new CatalogError('misconfigured')
  if (status === 401 || status === 403) throw new CatalogError('upstream_rejected')
  if (status < 200 || status >= 300) throw new CatalogError('invalid_response')
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** The JSON-RPC response with `id`, from a JSON body or an SSE stream. */
function findReply(exchange: Exchange, id: number): Message | undefined {
  const type = String(exchange.headers['content-type'] ?? '').toLowerCase()
  const candidates: unknown[] = []
  if (type.includes('text/event-stream')) {
    for (const event of exchange.text.split(/\r\n\r\n|\n\n|\r\r/)) {
      const data = event
        .split(/\r\n|\n|\r/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
      if (data.length > 0) candidates.push(parseJson(data.join('\n')))
    }
  } else {
    const parsed = parseJson(exchange.text)
    candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]))
  }
  return candidates.find((message): message is Message => isMessage(message) && message.id === id)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One guarded request: the proxy's SSRF lookup, no redirects, the remaining byte budget, the shared deadline. */
function guardedExchange(
  target: URL,
  method: 'POST' | 'DELETE',
  inject: Array<{ name: string; value: string }>,
  extra: OutgoingHttpHeaders,
  message: Message | undefined,
  allowPrivate: boolean,
  deadline: number,
  budget: number
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new CatalogError('timeout'))
    const headers: OutgoingHttpHeaders = { ...extra, host: target.host }
    for (const h of inject) headers[h.name] = h.value // upstream credential — never logged
    const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requestFn(
      target,
      {
        method,
        headers,
        lookup: makeGuardedLookup(allowPrivate),
        ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > budget) {
            req.destroy(new CatalogError('too_large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', (err) => reject(err))
      }
    )
    const timer = setTimeout(() => req.destroy(new CatalogError('timeout')), remaining)
    req.on('close', () => clearTimeout(timer))
    req.on('error', (err) => {
      if (err instanceof CatalogError) return reject(err)
      reject(new CatalogError(err.message.startsWith('ssrf: blocked address') ? 'blocked_address' : 'unreachable'))
    })
    if (message) req.write(JSON.stringify(message))
    req.end()
  })
}
