import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { McpBindingTable } from './binding-table.js'
import {
  filterJsonBody,
  filterMessage,
  judgeRequest,
  SseToolsListFilter,
  TOOLS_LIST_BUFFER_LIMIT,
  type ToolDecisions
} from './tool-policy.js'
import type { MemoryConnectionBindingTable } from '../memory/binding-table.js'
import { isBlockedIp, makeGuardedLookup } from './ssrf.js'
import type { Logger } from '../log.js'
import {
  isOpenConnectorBinding,
  openConnectorBase,
  readBindingHeader,
  respondOpenConnector,
  OPEN_CONNECTOR_ALIAS_HEADER,
  OPEN_CONNECTOR_SERVICE_HEADER
} from './open-connector.js'

/** POST JSON-RPC bodies are small; cap generously. GET (SSE) carries no body. */
const MCP_BODY_LIMIT = 4 * 1024 * 1024

// Relay-made failures avoid 502/504: a CDN in front of the relay swaps those for its own body, hiding the reason.
const MISCONFIGURED = 424 // the binding cannot work until an admin repairs it
const UNAVAILABLE = 503 // transient; a retry can succeed

// Hop-by-hop headers (RFC 7230 §6.1) + auth/host, stripped before forwarding upstream.
const STRIP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization', // replaced by the upstream's injected headers
  'content-length', // recomputed by the outbound request
  'x-ac-tool-approval' // the daemon's approval marker for the relay, never the upstream's
])
// Hop-by-hop + the upstream's own auth challenge, which must never reach the caller (see the 401/403 arm).
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'www-authenticate',
  'proxy-authenticate'
])

export interface McpProxyDeps {
  bindings: McpBindingTable
  /** Lowercased hostnames allowed to resolve to private addresses (deploy-level opt-in). */
  allowlist: Set<string>
  log: Logger
  /** open-connector origin override (docs: connectors). Unset ⇒ derived from the
   *  binding's upstreamUrl (`<OC>/mcp` → `<OC>`). */
  openConnectorUrl?: string
  /** Optional bearer for open-connector's runtime API (unset ⇒ no auth header). */
  openConnectorToken?: string
}

export interface MemoryPluginProxyDeps {
  bindings: MemoryConnectionBindingTable
  /** Lowercased hostnames allowed to resolve to private addresses (deploy-level opt-in). */
  allowlist: Set<string>
  log: Logger
}

interface GrantProxyDeps {
  bindings: {
    resolve(
      id: string,
      grantKey: string
    ): { upstreamUrl: string; headers: Array<{ name: string; value: string }>; policy?: ToolDecisions } | null
  }
  allowlist: Set<string>
  log: Logger
  route: string
  param: string
  noun: string
  logPrefix: string
  /** open-connector integration (docs: connectors) — only set on the MCP provider proxy. */
  openConnectorUrl?: string
  openConnectorToken?: string
}

function bearer(auth: string | undefined): string | null {
  if (!auth) return null
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1]!.trim() : null
}

function forwardRequestHeaders(
  incoming: IncomingHttpHeaders,
  inject: Array<{ name: string; value: string }>,
  hostHeader: string,
  judged = false
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  const injectedNames = new Set(inject.map((header) => header.name.toLowerCase()))
  for (const [k, v] of Object.entries(incoming)) {
    const lower = k.toLowerCase()
    if (v === undefined || STRIP_REQUEST_HEADERS.has(lower) || injectedNames.has(lower)) continue
    // A judged exchange must come back in a form the relay can read and filter.
    if (judged && lower === 'accept-encoding') continue
    out[k] = v
  }
  out.host = hostHeader
  for (const h of inject) out[h.name] = h.value // upstream credential — never logged
  return out
}

/** Serve an open-connector connection as a local request/response MCP server pinned to the operator origin (docs: connectors). */
async function serveOpenConnector(
  req: FastifyRequest,
  reply: FastifyReply,
  up: { upstreamUrl: string; headers: Array<{ name: string; value: string }> },
  operatorUrl: string,
  deps: GrantProxyDeps,
  judged: { body: Buffer | undefined; policy?: ToolDecisions; listIds: ReadonlySet<string> }
): Promise<FastifyReply> {
  const method = req.method.toUpperCase()
  if (method === 'GET') return reply.code(405).send({ error: 'server-initiated stream not supported' })
  if (method === 'DELETE') return reply.code(200).send({})

  const buf = judged.body
  let parsed: unknown
  try {
    parsed = buf && buf.length > 0 ? JSON.parse(buf.toString('utf8')) : {}
  } catch {
    return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }

  const service = readBindingHeader(up.headers, OPEN_CONNECTOR_SERVICE_HEADER)
  const profile = readBindingHeader(up.headers, OPEN_CONNECTOR_ALIAS_HEADER)
  if (!service || !profile) {
    return reply
      .code(MISCONFIGURED)
      .send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'incomplete connector binding' } })
  }

  try {
    const { status, json } = await respondOpenConnector(
      {
        // Pinned to the operator origin — NEVER the (attacker-influenceable) binding url.
        base: openConnectorBase(operatorUrl),
        service,
        profile,
        ...(deps.openConnectorToken ? { token: deps.openConnectorToken } : {}),
        log: deps.log
      },
      parsed
    )
    if (json === undefined) return reply.code(status).send()
    const { policy, listIds } = judged
    if (!policy || listIds.size === 0) return reply.code(status).send(json)
    const filtered = Array.isArray(json)
      ? json.map((message) => filterMessage(message, policy, listIds))
      : filterMessage(json, policy, listIds)
    return reply.code(status).send(filtered)
  } catch (e) {
    deps.log.warn(`${deps.logPrefix}: open-connector request failed: ${e instanceof Error ? e.message : String(e)}`)
    return reply
      .code(UNAVAILABLE)
      .send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'open-connector unavailable' } })
  }
}

/** Answer a forwarded `tools/list` with only the allowed tools: JSON is buffered and rewritten, SSE is rewritten event by event, anything else fails closed. */
function filterToolsList(
  upstreamRes: IncomingMessage,
  out: ServerResponse,
  headers: OutgoingHttpHeaders,
  policy: ToolDecisions,
  listIds: ReadonlySet<string>,
  resolve: () => void
): void {
  const type = String(upstreamRes.headers['content-type'] ?? '').toLowerCase()
  // The rewritten body is identity-encoded and freshly sized.
  for (const name of Object.keys(headers)) {
    if (['content-length', 'content-encoding'].includes(name.toLowerCase())) delete headers[name]
  }
  if (type.includes('text/event-stream')) {
    out.writeHead(200, headers)
    const filter = new SseToolsListFilter(policy, listIds)
    upstreamRes.pipe(filter).pipe(out)
    filter.on('end', () => {
      upstreamRes.destroy()
      resolve()
    })
    upstreamRes.on('error', () => {
      out.destroy()
      resolve()
    })
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  let answered = false
  // Not JSON, or too large to judge: every listed id gets an error instead of the unfiltered body.
  const answer = (text: string) => {
    if (answered) return
    answered = true
    const json = filterJsonBody(text, policy, listIds)
    out.writeHead(200, { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
    out.end(json)
    resolve()
  }
  upstreamRes.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= TOOLS_LIST_BUFFER_LIMIT) return void chunks.push(chunk)
    upstreamRes.destroy()
    answer('')
  })
  upstreamRes.on('end', () => answer(type.includes('application/json') ? Buffer.concat(chunks).toString('utf8') : ''))
  upstreamRes.on('error', () => {
    if (answered) return
    answered = true
    out.destroy()
    resolve()
  })
}

/** The relay's MCP reverse proxy (centralized-tool-management.md §5): grant → SSRF-guarded upstream, bytes through, MCP parsed only for restricted grants. */
function registerGrantProxy(app: FastifyInstance, deps: GrantProxyDeps): void {
  void app.register(async (scope) => {
    // Forward the request body raw for ANY content-type — drop the inherited parsers
    // (esp. the default application/json one) so nothing is parsed; we proxy bytes, not MCP.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MCP_BODY_LIMIT }, (_req, body, done) =>
      done(null, body)
    )

    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: deps.route,
      handler: async (req, reply) => {
        const key = bearer(req.headers.authorization)
        if (!key) return reply.code(401).send({ error: 'missing bearer grant key' })
        const resourceId = (req.params as Record<string, string>)[deps.param] ?? ''
        const up = deps.bindings.resolve(resourceId, key)
        if (!up) return reply.code(401).send({ error: `unknown ${deps.noun} or invalid grant key` })

        // A restricted agent grant is judged here; everything else stays a byte proxy (mcp-tool-permissions.md §6.2).
        let body = req.body as Buffer | undefined
        let listIds: ReadonlySet<string> = new Set()
        if (up.policy && req.method.toUpperCase() === 'POST') {
          const judgment = judgeRequest(body, up.policy)
          if (judgment.refused.length > 0) {
            const names = judgment.refused.map((name) => JSON.stringify(name.slice(0, 128))).join(', ')
            deps.log.info(`${deps.logPrefix}: refused blocked tool ${names} for ${deps.noun} ${resourceId}`)
          }
          if (judgment.kind === 'respond') {
            return judgment.json === undefined
              ? reply.code(judgment.status).send()
              : reply.code(judgment.status).send(judgment.json)
          }
          body = Buffer.from(judgment.body, 'utf8')
          listIds = judgment.listIds
        }
        const policy = up.policy

        // open-connector connections aren't raw-proxied: the relay serves a synthesized
        // MCP server backed by open-connector's runtime REST API, scoped to this
        // connection's (service, profile). Gated on the OPERATOR-configured
        // openConnectorUrl — the egress target is pinned to it, never the binding url, so
        // a forged binding can't point this unguarded path at an attacker/internal host
        // (the CP also refuses the x-oomol-connector-* markers on custom providers). When
        // it's unset we fall through to the guarded raw-proxy path instead.
        if (deps.noun === 'provider' && deps.openConnectorUrl && isOpenConnectorBinding(up.headers)) {
          return serveOpenConnector(req, reply, up, deps.openConnectorUrl, deps, { body, policy, listIds })
        }

        let target: URL
        try {
          target = new URL(up.upstreamUrl)
        } catch {
          return reply.code(MISCONFIGURED).send({ error: 'bad upstream url' })
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          return reply.code(MISCONFIGURED).send({ error: 'unsupported upstream scheme' })
        }
        // URL userinfo would be implicit upstream auth outside the injected headers; stale bindings can still carry it.
        if (target.username || target.password) {
          return reply.code(MISCONFIGURED).send({ error: 'upstream url credentials rejected' })
        }
        // Forward the incoming query string (rare for MCP) when the upstream url has none.
        const qi = (req.raw.url ?? '').indexOf('?')
        if (qi >= 0 && !target.search) target.search = (req.raw.url ?? '').slice(qi)

        // Strip IPv6-literal brackets (`[::1]`), which isIP() rejects, so the literal check fires.
        const host = target.hostname.replace(/^\[|\]$/g, '')
        const allowPrivate = deps.allowlist.has(host.toLowerCase())
        // An IP literal never reaches the guarded `lookup`, so check it here; hostnames are guarded and pinned below.
        if (!allowPrivate && isIP(host) && isBlockedIp(host)) {
          return reply.code(MISCONFIGURED).send({ error: 'blocked upstream address' })
        }
        const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest

        // Proxy inside an awaited promise so the handler stays pending until the exchange
        // finishes — otherwise Fastify auto-sends a 200 on return and the later hijack throws.
        await new Promise<void>((resolve) => {
          let hijacked = false
          const upstreamReq = requestFn(
            target,
            {
              method: req.method,
              headers: forwardRequestHeaders(req.headers, up.headers, target.host, policy !== undefined),
              lookup: makeGuardedLookup(allowPrivate),
              ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
            },
            (upstreamRes) => {
              const status = upstreamRes.statusCode ?? 502
              // Never relay a redirect: the client would follow it around the SSRF guard; register the final URL.
              if (status >= 300 && status < 400) {
                upstreamRes.resume()
                void reply.code(MISCONFIGURED).send({ error: 'upstream redirect rejected' })
                resolve()
                return
              }
              // Never relayed: the challenge would start the upstream's own OAuth; an admin repairs the credential.
              if (status === 401 || status === 403) {
                upstreamRes.resume()
                deps.log.warn(`${deps.logPrefix}: upstream rejected the binding credential (${status})`)
                void reply.code(MISCONFIGURED).send({
                  error: `upstream rejected this ${deps.noun}'s configured credential; an admin must update it`
                })
                resolve()
                return
              }
              hijacked = true
              reply.hijack() // take over the socket for a raw (streamable/SSE) response
              const resHeaders: OutgoingHttpHeaders = {}
              for (const [k, v] of Object.entries(upstreamRes.headers)) {
                if (v !== undefined && !STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) resHeaders[k] = v
              }
              if (policy && listIds.size > 0 && status === 200) {
                filterToolsList(upstreamRes, reply.raw, resHeaders, policy, listIds, resolve)
                return
              }
              reply.raw.writeHead(status, resHeaders)
              upstreamRes.pipe(reply.raw)
              upstreamRes.on('end', () => resolve())
              upstreamRes.on('error', () => {
                reply.raw.destroy()
                resolve()
              })
            }
          )
          upstreamReq.on('error', (err) => {
            // A guarded-lookup SSRF block lands here too; log only the opaque id, never the url, DNS error or headers.
            deps.log.warn(`${deps.logPrefix}: upstream request failed for ${deps.noun} ${resourceId}`)
            if (hijacked) {
              if (!reply.raw.writableEnded) reply.raw.destroy()
            } else if (err.message.startsWith('ssrf: blocked address')) {
              void reply.code(MISCONFIGURED).send({ error: 'blocked upstream address' })
            } else {
              void reply.code(UNAVAILABLE).send({ error: 'upstream unreachable' })
            }
            resolve()
          })

          if (body && body.length > 0) upstreamReq.write(body)
          upstreamReq.end()
        })
      }
    })
  })
}

export function registerMcpProxy(app: FastifyInstance, deps: McpProxyDeps): void {
  registerGrantProxy(app, {
    ...deps,
    route: '/mcp/:providerId',
    param: 'providerId',
    noun: 'provider',
    logPrefix: 'mcp-proxy'
  })
}

/**
 * Daemon-private memory-plugin reverse proxy. The byte-stream/SSRF machinery is
 * intentionally shared with MCP, while route, bindings, and grants are not.
 */
export function registerMemoryPluginProxy(app: FastifyInstance, deps: MemoryPluginProxyDeps): void {
  registerGrantProxy(app, {
    ...deps,
    route: '/memory/:connectionId',
    param: 'connectionId',
    noun: 'connection',
    logPrefix: 'memory-proxy'
  })
}
