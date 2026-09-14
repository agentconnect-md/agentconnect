/**
 * SSRF-guarded outbound HTTP for operator-supplied URLs the CP itself must dial.
 *
 * Until MCP-provider OAuth the CP never dialed an upstream — `blockedUpstreamUrl`
 * (`orchestrator/mcpProvider.ts`) was a write-time fast-fail and the relay owned the
 * authoritative egress guard (`packages/relay/src/mcp/ssrf.ts`). OAuth discovery changes
 * that: protected-resource metadata, authorization-server metadata, dynamic client
 * registration, and every token/refresh exchange are CP-originated calls to hosts a
 * console user typed. So the relay's two guarantees are restated here.
 *
 *  1. REJECT an address that can never be reached from the public internet — private,
 *     loopback, link-local (incl. the 169.254.169.254 metadata IP), CGNAT, multicast,
 *     reserved — and reject it for EVERY address the name resolves to, so round-robin
 *     rebinding cannot slip one past.
 *  2. PIN the connection to the exact address that was validated, so a name cannot be
 *     re-resolved to a private IP between the check and the connect (TOCTOU).
 *
 * Two deliberate differences from the relay's copy. The allowlist is the CP's own deploy
 * permission, never the relay's — `ssrf.ts` records why two egress permissions must never
 * be merged, and CP egress is a third. And a redirect is never
 * followed: `node:http` does not follow one on its own, and the caller treats a 3xx as a
 * failure, because following it would re-resolve the host past the pin.
 *
 * SECURITY: a request built here carries client secrets, authorization codes, and refresh
 * tokens. NEVER log the url, the headers, the body, or a DNS error — the opaque reason
 * codes this module returns are what callers may surface.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import { privateV4, privateV6 } from './private-address.js'

/** Default ceilings. A discovery/token endpoint that needs more than this is not one. */
export const GUARDED_TIMEOUT_MS = 10_000
export const GUARDED_MAX_BYTES = 1024 * 1024

/** Non-routable IPv4 beyond `privateV4`: IETF protocol/benchmark, multicast, reserved. */
function unroutableV4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  const a = o[0] ?? -1
  const b = o[1] ?? -1
  if (a === 192 && b === 0 && (o[2] ?? -1) === 0) return true // 192.0.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false
}

/** True when the CP must not dial `ip`. Literals only — the caller supplies resolved addresses. */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (isIP(addr) === 4) return privateV4(addr) || unroutableV4(addr)
  return privateV6(addr)
}

/**
 * A `net.LookupFunction` that resolves the name, refuses the request if ANY resolved
 * address is blocked, and returns exactly one validated address so the socket is pinned
 * to it. Reject-if-any (not just the chosen address) is what defeats round-robin
 * rebinding; erroring the lookup fails the outbound connection.
 */
export function makeGuardedLookup(allowPrivate: boolean): LookupFunction {
  const fn: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      if (!addresses || addresses.length === 0) return callback(new Error('ssrf: unresolved host'), '', 0)
      if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(new Error('ssrf: blocked address'), '', 0)
      }
      const pick = addresses[0]!
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: Error | null, a: Array<{ address: string; family: number }>) => void)(null, [
          { address: pick.address, family: pick.family }
        ])
      }
      callback(null, pick.address, pick.family)
    })
  }
  return fn
}

/** Why a guarded call did not produce a response. Safe to surface; carries no url or secret. */
export type GuardedFailure =
  /** The url itself is unusable: bad syntax, non-http(s) scheme, or embedded userinfo. */
  | 'url_rejected'
  /** The host is, or resolves to, an address the CP must not dial. */
  | 'address_blocked'
  /** DNS/TCP/TLS failure, or the timeout elapsed. Says nothing about the host. */
  | 'unreachable'
  /** The response exceeded `maxBytes`, or its body was not the JSON the caller expected. */
  | 'malformed_response'

export interface GuardedResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** Raw body text, truncated at `maxBytes`. `json()` is the usual way in. */
  text: string
  /** Parsed body, or undefined when it is not a JSON object/array. */
  json: unknown
}

export type GuardedResult = { ok: true; response: GuardedResponse } | { ok: false; failure: GuardedFailure }

export interface GuardedRequestInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Request body; `content-length` is computed from it. */
  body?: string
  /** Hosts the deployment opted out of the private-address block. Pinning still applies. */
  allowlist?: ReadonlySet<string>
  timeoutMs?: number
  maxBytes?: number
}

/** The `LookupFunction` factory to use. Injectable so tests can drive resolution without DNS. */
export type LookupFactory = (allowPrivate: boolean) => LookupFunction

/**
 * One guarded request. Resolves to a `GuardedResult` rather than throwing, because every
 * caller here has to branch on the failure anyway and none of them may leak the reason
 * into a log line. A 3xx comes back as an ordinary response for the caller to reject.
 */
export function guardedRequest(
  rawUrl: string,
  init: GuardedRequestInit = {},
  lookupFactory: LookupFactory = makeGuardedLookup
): Promise<GuardedResult> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return Promise.resolve({ ok: false, failure: 'url_rejected' })
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.resolve({ ok: false, failure: 'url_rejected' })
  }
  // Userinfo is an implicit Authorization source in Node's client and would bypass the
  // reviewed header contract — the same rule the relay enforces at its egress boundary.
  if (target.username || target.password) return Promise.resolve({ ok: false, failure: 'url_rejected' })

  const host = target.hostname.replace(/^\[|\]$/g, '')
  const allowPrivate = init.allowlist?.has(host.toLowerCase()) === true
  // An IP-literal host never reaches `lookup` (node connects straight to it), so the pin
  // would not run — check literals here or the guard is bypassed by e.g. http://[::1].
  if (!allowPrivate && isIP(host) && isBlockedAddress(host)) {
    return Promise.resolve({ ok: false, failure: 'address_blocked' })
  }

  const timeoutMs = init.timeoutMs ?? GUARDED_TIMEOUT_MS
  const maxBytes = init.maxBytes ?? GUARDED_MAX_BYTES
  const body = init.body
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise<GuardedResult>((resolve) => {
    let settled = false
    const done = (result: GuardedResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = requestFn(
      target,
      {
        method: init.method ?? 'GET',
        headers: {
          ...init.headers,
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) })
        },
        lookup: lookupFactory(allowPrivate),
        ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
      },
      (res) => {
        let text = ''
        let over = false
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (over) return
          text += chunk
          if (Buffer.byteLength(text) > maxBytes) {
            // Settle here rather than on `end`: a destroyed response emits `close`, not `end`.
            over = true
            res.destroy()
            done({ ok: false, failure: 'malformed_response' })
          }
        })
        res.on('end', () => {
          let json: unknown
          try {
            json = text.length > 0 ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          done({ ok: true, response: { status: res.statusCode ?? 0, headers: res.headers, text, json } })
        })
        res.on('error', () => done({ ok: false, failure: 'unreachable' }))
      }
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done({ ok: false, failure: 'unreachable' })
    })
    // A guarded-lookup refusal surfaces here. NEVER log the error: it carries the host.
    req.on('error', (err) => {
      done({ ok: false, failure: /^ssrf: blocked address/.test(err.message) ? 'address_blocked' : 'unreachable' })
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}
