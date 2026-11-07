// A GET the credential proxy sends upstream itself (azure-devops-integration.md §6.2's pull-request lookup), by the route its forwarded requests take.
import type { IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { LookupFunction, Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import {
  connectViaParentProxy,
  directRequestOptions,
  selectParentProxyUrl,
  shouldBypassParentProxy,
  type ResolvedParentProxy
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'

/** How an upstream leg leaves: the daemon's own outbound proxy, the guarded resolver for a direct dial, and the authorities it is verified with. */
export interface UpstreamRoute {
  parentProxy?: ResolvedParentProxy
  lookup?: LookupFunction
  trustedCa?: string | string[]
}

export interface UpstreamAnswer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** An answer larger than this is refused rather than buffered. */
const MAX_ANSWER_BYTES = 1 << 20
const TIMEOUT_MS = 30_000

/** The upstream answered with more than the proxy buffers, which a caller may treat apart from an unreachable upstream. */
export class UpstreamAnswerTooLarge extends Error {
  constructor() {
    super('the upstream answer is too large')
  }
}

/** GET `path` on `hostname:port` over HTTPS: through the outbound proxy unless NO_PROXY names the host, else a guarded direct dial. */
export async function upstreamGet(
  hostname: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  route: UpstreamRoute
): Promise<UpstreamAnswer> {
  const authority = port === 443 ? hostname : `${hostname}:${port}`
  const ca = route.trustedCa !== undefined && route.trustedCa.length > 0 ? { ca: route.trustedCa } : {}
  const base: RequestOptions = { method: 'GET', path, headers: { ...headers, host: authority }, ...ca }
  const parent =
    route.parentProxy && !shouldBypassParentProxy(route.parentProxy, hostname)
      ? selectParentProxyUrl(route.parentProxy, { isHttps: true })
      : undefined
  let options: RequestOptions
  let tunnel: Socket | undefined
  if (parent) {
    const socket = await connectViaParentProxy(parent, hostname, port)
    tunnel = socket
    // No agent, so the request takes this TLS session over the tunnel as its socket.
    options = { ...base, createConnection: () => tlsConnect({ socket, servername: hostname, ...ca }) }
  } else {
    options = { ...base, ...(await directRequestOptions(hostname, port, route.lookup, true)) }
  }
  try {
    return await new Promise<UpstreamAnswer>((resolve, reject) => {
      const req = httpsRequest(options, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_ANSWER_BYTES) {
            // Settled before the destroy, whose own errors then change nothing.
            reject(new UpstreamAnswerTooLarge())
            req.destroy()
          } else chunks.push(chunk)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('the upstream did not answer in time')))
      req.on('error', reject)
      req.end()
    })
  } finally {
    // The tunnel is this request's alone; released even when the request failed before its TLS session took it over.
    tunnel?.destroy()
  }
}
