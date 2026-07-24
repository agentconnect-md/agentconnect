import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { McpBindingTable } from './binding-table.js'
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
  'content-length' // recomputed by the outbound request
])
const STRIP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade'])

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
    ): { upstreamUrl: string; headers: Array<{ name: string; value: string }> } | null
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
  hostHeader: string
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  const injectedNames = new Set(inject.map((header) => header.name.toLowerCase()))
  for (const [k, v] of Object.entries(incoming)) {
    const lower = k.toLowerCase()
    if (v === undefined || STRIP_REQUEST_HEADERS.has(lower) || injectedNames.has(lower)) continue
    out[k] = v
  }
  out.host = hostHeader
  for (const h of inject) out[h.name] = h.value // upstream credential — never logged
  return out
}

/**
 * Serve an open-connector connection as a local MCP server (docs: connectors) instead
 * of raw-proxying. The (service, profile) come from the binding headers; the OC origin
 * from the relay override or the binding upstreamUrl. Streamable HTTP, request/response:
 * POST carries JSON-RPC (answered application/json), GET has no server stream (405),
 * DELETE (session teardown) is a no-op 200.
 */
async function serveOpenConnector(
  req: FastifyRequest,
  reply: FastifyReply,
  up: { upstreamUrl: string; headers: Array<{ name: string; value: string }> },
  operatorUrl: string,
  deps: GrantProxyDeps
): Promise<FastifyReply> {
  const method = req.method.toUpperCase()
  if (method === 'GET') return reply.code(405).send({ error: 'server-initiated stream not supported' })
  if (method === 'DELETE') return reply.code(200).send({})

  const buf = req.body as Buffer | undefined
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
      .code(502)
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
    return json === undefined ? reply.code(status).send() : reply.code(status).send(json)
  } catch (e) {
    deps.log.warn(`${deps.logPrefix}: open-connector request failed: ${e instanceof Error ? e.message : String(e)}`)
    return reply
      .code(502)
      .send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'open-connector unavailable' } })
  }
}

/**
 * `registerMcpProxy` — the relay's MCP reverse proxy (centralized-tool-management.md §5).
 * `ALL /mcp/:providerId` with `Authorization: Bearer <grantKey>`: resolves the grant to
 * its upstream binding, SSRF-guards + IP-pins the operator-supplied upstream (§5.3), swaps
 * the agent bearer for the real upstream headers, and streams the exchange through (SSE
 * passthrough). The relay does NOT parse MCP — it is a byte/stream reverse proxy.
 * Supports Streamable HTTP (single endpoint) only; legacy HTTP+SSE is out of scope.
 */
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

        // open-connector connections aren't raw-proxied: the relay serves a synthesized
        // MCP server backed by open-connector's runtime REST API, scoped to this
        // connection's (service, profile). Gated on the OPERATOR-configured
        // openConnectorUrl — the egress target is pinned to it, never the binding url, so
        // a forged binding can't point this unguarded path at an attacker/internal host
        // (the CP also refuses the x-oomol-connector-* markers on custom providers). When
        // it's unset we fall through to the guarded raw-proxy path instead.
        if (deps.noun === 'provider' && deps.openConnectorUrl && isOpenConnectorBinding(up.headers)) {
          return serveOpenConnector(req, reply, up, deps.openConnectorUrl, deps)
        }

        let target: URL
        try {
          target = new URL(up.upstreamUrl)
        } catch {
          return reply.code(502).send({ error: 'bad upstream url' })
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          return reply.code(502).send({ error: 'unsupported upstream scheme' })
        }
        // URL userinfo is an implicit Authorization source in Node's client and
        // bypasses the reviewed header-injection contract. New CP writes reject
        // it too; enforce again at the egress boundary for legacy/stale bindings.
        if (target.username || target.password) {
          return reply.code(502).send({ error: 'upstream url credentials rejected' })
        }
        // Forward the incoming query string (rare for MCP) when the upstream url has none.
        const qi = (req.raw.url ?? '').indexOf('?')
        if (qi >= 0 && !target.search) target.search = (req.raw.url ?? '').slice(qi)

        // URL.hostname keeps the brackets on an IPv6 literal (`[::1]`), which isIP()
        // rejects — strip them so the literal check below actually fires.
        const host = target.hostname.replace(/^\[|\]$/g, '')
        const allowPrivate = deps.allowlist.has(host.toLowerCase())
        // An IP-LITERAL host is never passed to `lookup` (node connects directly), so the
        // guarded-lookup pinning wouldn't run — validate literals here or the SSRF guard is
        // bypassed by e.g. http://169.254.169.254 or http://[::1]. Hostnames are guarded+pinned below.
        if (!allowPrivate && isIP(host) && isBlockedIp(host)) {
          return reply.code(502).send({ error: 'blocked upstream address' })
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
              headers: forwardRequestHeaders(req.headers, up.headers, target.host),
              lookup: makeGuardedLookup(allowPrivate),
              ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
            },
            (upstreamRes) => {
              const status = upstreamRes.statusCode ?? 502
              // Never relay Location to the MCP client. `fetch` follows 3xx by
              // default, which would let an upstream redirect the daemon around
              // this proxy's DNS/private-address guard. MCP endpoints are pinned
              // installation metadata; owners must register the final URL.
              if (status >= 300 && status < 400) {
                upstreamRes.resume()
                void reply.code(502).send({ error: 'upstream redirect rejected' })
                resolve()
                return
              }
              hijacked = true
              reply.hijack() // take over the socket for a raw (streamable/SSE) response
              const resHeaders: OutgoingHttpHeaders = {}
              for (const [k, v] of Object.entries(upstreamRes.headers)) {
                if (v !== undefined && !STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) resHeaders[k] = v
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
            // SSRF block surfaces here (guarded lookup errors the connection) — never leak the url/headers.
            // Do not include the upstream URL, DNS error, headers, or body: all can
            // contain connection-specific secret material. The opaque id is enough.
            void err
            deps.log.warn(`${deps.logPrefix}: upstream request failed for ${deps.noun} ${resourceId}`)
            if (hijacked) {
              if (!reply.raw.writableEnded) reply.raw.destroy()
            } else {
              void reply.code(502).send({ error: 'upstream unreachable' })
            }
            resolve()
          })

          const body = req.body as Buffer | undefined
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
