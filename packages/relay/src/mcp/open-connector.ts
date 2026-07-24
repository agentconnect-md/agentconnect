/**
 * Synthesized MCP server for open-connector connections (docs: connectors).
 *
 * open-connector's own /mcp endpoint is context-free (it exposes 4 generic discovery
 * tools against the "default" connection). For a per-connection MCP tool we instead
 * translate the MCP protocol into open-connector's runtime REST API, pinned to one
 * (service, connection-profile):
 *   - tools/list  → GET  <base>/v1/actions?service=<service>   (one tool per action)
 *   - tools/call  → POST <base>/v1/actions/<actionId>          ({ input, connectionName })
 *
 * The (service, profile) pair rides as binding headers set by the CP
 * (x-oomol-connector-service / x-oomol-connector-alias); the relay reads them here and
 * never forwards them as raw HTTP headers. Request/response only — no SSE.
 */
import type { Logger } from '../log.js'

export const OPEN_CONNECTOR_ALIAS_HEADER = 'x-oomol-connector-alias'
export const OPEN_CONNECTOR_SERVICE_HEADER = 'x-oomol-connector-service'

const PROTOCOL_VERSION = '2025-06-18'

type BindingHeader = { name: string; value: string }

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface OpenConnectorContext {
  /** open-connector origin (no trailing /mcp), e.g. http://localhost:3000. */
  base: string
  /** The service whose actions this connection exposes (e.g. "gmail"). */
  service: string
  /** The connection profile passed as connectionName on every action run. */
  profile: string
  /** Optional bearer for open-connector's runtime API (unset ⇒ no auth header). */
  token?: string
  fetchImpl?: typeof fetch
  log?: Logger
}

export function readBindingHeader(headers: BindingHeader[], name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lower)?.value
}

/** A binding is an open-connector connection iff it carries both markers. */
export function isOpenConnectorBinding(headers: BindingHeader[]): boolean {
  return (
    readBindingHeader(headers, OPEN_CONNECTOR_ALIAS_HEADER) !== undefined &&
    readBindingHeader(headers, OPEN_CONNECTOR_SERVICE_HEADER) !== undefined
  )
}

/**
 * The open-connector origin the relay talks to — ALWAYS the operator-configured relay
 * OPEN_CONNECTOR_URL, never the binding's upstreamUrl. Binding data is attacker-influenceable
 * (a custom provider could forge the marker headers), so deriving the egress target from it
 * would be an SSRF hole; pinning to the operator origin closes it. A trailing slash and an
 * accidental `/mcp` suffix are tolerated.
 */
export function openConnectorBase(operatorUrl: string): string {
  return operatorUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/mcp$/, '')
}

/**
 * Handle one parsed JSON-RPC message. Returns a response, or null for a notification
 * (no `id`) — the caller answers those with 202 and no body.
 */
export async function handleOpenConnectorMessage(
  ctx: OpenConnectorContext,
  msg: JsonRpcMessage
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null
  const isNotification = msg.id === undefined || msg.id === null
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })

  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: readProtocolVersion(msg.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `open-connector:${ctx.service}`, version: '1.0.0' }
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null // notification — no response
    case 'ping':
      return ok({})
    case 'tools/list':
      try {
        return ok({ tools: await listTools(ctx) })
      } catch (e) {
        return fail(-32603, e instanceof Error ? e.message : 'failed to list tools')
      }
    case 'tools/call':
      try {
        return ok(await callTool(ctx, msg.params))
      } catch (e) {
        return fail(-32603, e instanceof Error ? e.message : 'tool call failed')
      }
    default:
      if (isNotification) return null // ignore unknown notifications
      return fail(-32601, `method not found: ${msg.method ?? '(none)'}`)
  }
}

/** Handle a parsed body (single message or JSON-RPC batch). */
export async function respondOpenConnector(
  ctx: OpenConnectorContext,
  parsed: unknown
): Promise<{ status: number; json?: unknown }> {
  if (Array.isArray(parsed)) {
    const out = await Promise.all(parsed.map((m) => handleOpenConnectorMessage(ctx, m as JsonRpcMessage)))
    const responses = out.filter((r): r is JsonRpcResponse => r != null)
    return responses.length > 0 ? { status: 200, json: responses } : { status: 202 }
  }
  const res = await handleOpenConnectorMessage(ctx, (parsed ?? {}) as JsonRpcMessage)
  return res ? { status: 200, json: res } : { status: 202 }
}

// ── open-connector runtime API ────────────────────────────────────────────────
interface OcAction {
  id: string
  name?: string
  description?: string
  inputSchema?: unknown
}
interface OcEnvelope<T> {
  success: boolean
  message?: string
  data?: T
  errorCode?: string
}

async function ocFetch<T>(ctx: OpenConnectorContext, path: string, init?: RequestInit): Promise<OcEnvelope<T>> {
  const doFetch = ctx.fetchImpl ?? fetch
  const res = await doFetch(`${ctx.base}${path}`, {
    ...init,
    // Never follow redirects: the base is the operator origin, so a 3xx could only walk
    // the request (and any Authorization bearer) off it — treat it as a hard error, the
    // same egress contract the relay's raw MCP proxy enforces.
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
      ...(init?.headers ?? {})
    }
  })
  const body = (await res.json().catch(() => null)) as OcEnvelope<T> | null
  if (!body) throw new Error(`open-connector ${path} returned ${res.status} (non-JSON)`)
  return body
}

async function listTools(
  ctx: OpenConnectorContext
): Promise<Array<{ name: string; description: string; inputSchema: object }>> {
  const env = await ocFetch<OcAction[]>(ctx, `/v1/actions?service=${encodeURIComponent(ctx.service)}`)
  if (!env.success || !Array.isArray(env.data)) {
    throw new Error(env.message || 'open-connector did not return actions')
  }
  return env.data.map((a) => ({
    name: a.id,
    description: a.description || a.name || a.id,
    inputSchema: toolInputSchema(a.inputSchema)
  }))
}

async function callTool(ctx: OpenConnectorContext, params: unknown): Promise<unknown> {
  const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown }
  if (!name) throw new Error('tools/call requires a tool name')
  const env = await ocFetch<unknown>(ctx, `/v1/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify({ input: args ?? {}, connectionName: ctx.profile })
  })
  if (!env.success) {
    // Surface the failure to the model as a tool error, not a protocol error.
    return { content: [{ type: 'text', text: env.message || env.errorCode || 'action failed' }], isError: true }
  }
  return { content: [{ type: 'text', text: stringify(env.data) }] }
}

function toolInputSchema(schema: unknown): object {
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as object) : { type: 'object' }
}

function readProtocolVersion(params: unknown): string {
  const v = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
  return typeof v === 'string' ? v : PROTOCOL_VERSION
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}
