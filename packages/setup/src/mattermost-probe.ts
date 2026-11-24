/**
 * Unauthenticated Mattermost instance floor probe for Setup Server (`#4340`).
 *
 * When validating a self-hosted Mattermost Server URL before or after saving
 * `logto.mattermostConnector`, issue `GET <serverUrl>/api/v4/system/ping` with
 * no credentials and `redirect: 'manual'`. A healthy Mattermost API root answers
 * `200` with its ping JSON (`{ status: "OK", ... }`), or `401`/`403` with a JSON
 * error body if an upstream gateway protects the endpoint — proving DNS, TLS
 * trust, and subpath shape.
 *
 * ONLY the URL shape blocks saving (`invalid_url`). The Setup Server, Control
 * Plane, and Logto may run in different network zones, so `unreachable`,
 * `tls_untrusted`, and `not_a_mattermost_api_root` surface as diagnostics rather
 * than blocking saves.
 */
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

export type MattermostProbeStatus = 'ok' | 'invalid_url' | 'unreachable' | 'tls_untrusted' | 'not_a_mattermost_api_root'

export interface MattermostProbeResult {
  status: MattermostProbeStatus
  message: string
  /** The normalized server URL the probe addressed; absent when the shape was refused. */
  serverUrl?: string
}

export interface MattermostProbeOptions {
  /** Override probe timeout in milliseconds (defaults to 5000ms). */
  timeoutMs?: number
}

/** Give up on a silent instance rather than hold diagnostic requests open. */
const PROBE_TIMEOUT_MS = 5_000
/** Cap ping JSON response size so a hostile endpoint cannot OOM Setup Server. */
const MAX_PROBE_BYTES = 64 * 1024

class ProbeBlockedError extends Error {
  constructor() {
    super('ssrf: blocked address')
  }
}

class ProbeSizeError extends Error {
  constructor() {
    super('probe: response too large')
  }
}

/** Node's TLS verification failures, as they surface through `fetch`/`https`'s cause chain. */
const TLS_FAILURE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
])

/** Whether a probe verdict must stop the save (URL shape or blocked destination only). */
export function probeMattermostBlocksSave(probe: MattermostProbeResult): boolean {
  return probe.status === 'invalid_url'
}

function makePinnedLookup(resolve: typeof dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      if (!addresses || addresses.length === 0) return callback(new Error('probe: unresolved host'), '', 0)
      if (addresses.some((a) => isLinkLocalOrUnspecifiedIp(a.address))) {
        return callback(new ProbeBlockedError(), '', 0)
      }
      if ((options as { all?: boolean } | undefined)?.all) {
        return (callback as unknown as (e: Error | null, a: typeof addresses) => void)(null, addresses)
      }
      const pick = addresses[0]!
      return callback(null, pick.address, pick.family)
    })
  }
}

async function resolveAndValidateHost(
  hostname: string,
  resolve: typeof dnsLookup
): Promise<'ok' | 'blocked' | 'unreachable'> {
  if (isIP(hostname) !== 0) {
    return isLinkLocalOrUnspecifiedIp(hostname) ? 'blocked' : 'ok'
  }
  return await new Promise((resolvePromise) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolvePromise('unreachable')
        return
      }
      resolvePromise(addresses.some((a) => isLinkLocalOrUnspecifiedIp(a.address)) ? 'blocked' : 'ok')
    })
  })
}

async function nodePinnedProbeGet(
  pingUrl: string,
  lookupImpl: typeof dnsLookup,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const target = new URL(pingUrl)
  const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest
  const lookup = makePinnedLookup(lookupImpl)

  return await new Promise((resolve, reject) => {
    let settled = false
    let responseStarted = false
    let ended = false
    const controller = new AbortController()
    const timerBox: { id?: ReturnType<typeof setTimeout> } = {}

    const finish = (err: unknown, value?: { status: number; body: Record<string, unknown> | undefined }) => {
      if (settled) return
      settled = true
      clearTimeout(timerBox.id)
      if (err !== null && err !== undefined) reject(err)
      else resolve(value!)
    }

    const req = reqFn(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        lookup,
        signal: controller.signal,
        ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
      },
      (res) => {
        responseStarted = true
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          size += buf.byteLength
          if (size > MAX_PROBE_BYTES) {
            const sizeErr = new ProbeSizeError()
            res.destroy(sizeErr)
            req.destroy(sizeErr)
            finish(sizeErr)
            return
          }
          chunks.push(buf)
        })
        res.on('end', () => {
          ended = true
          let body: Record<string, unknown> | undefined
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              body = parsed as Record<string, unknown>
            }
          } catch {
            body = undefined
          }
          finish(null, { status: res.statusCode ?? 0, body })
        })
        res.on('close', () => {
          if (!ended) {
            finish(new Error('probe: response stream closed prematurely'))
          }
        })
        res.on('error', (err) => finish(err))
      }
    )
    timerBox.id = setTimeout(() => {
      const timeoutErr = new Error('Timed out')
      controller.abort(timeoutErr)
      req.destroy(timeoutErr)
      finish(timeoutErr)
    }, timeoutMs)
    timerBox.id.unref?.()
    req.on('close', () => {
      if (!responseStarted) {
        finish(new Error('probe: request closed prematurely'))
      }
    })
    req.on('error', (err) => finish(err))
    req.end()
  })
}

export async function probeMattermostInstance(
  rawServerUrl: string,
  fetchImpl?: typeof fetch,
  lookupImpl?: typeof dnsLookup,
  opts: MattermostProbeOptions = {}
): Promise<MattermostProbeResult> {
  const normalized = normalizeMattermostProbeUrl(rawServerUrl)
  if (!normalized.ok) {
    return { status: 'invalid_url', message: normalized.reason }
  }
  const { serverUrl } = normalized
  const parsed = new URL(serverUrl)
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS

  let status: number
  let body: Record<string, unknown> | undefined
  try {
    if (fetchImpl && fetchImpl !== globalThis.fetch) {
      if (lookupImpl) {
        const verdict = await resolveAndValidateHost(host, lookupImpl)
        if (verdict === 'blocked') {
          return { status: 'invalid_url', message: 'This Mattermost server address is not allowed.' }
        }
        if (verdict === 'unreachable') {
          return {
            status: 'unreachable',
            serverUrl,
            message: `${serverUrl} could not be reached from the Setup Server; check intranet connectivity or save anyway if the Control Plane and Logto can reach it`
          }
        }
      }
      const response = await fetchImpl(`${serverUrl}/api/v4/system/ping`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      })
      status = response.status
      body = await readJsonObject(response)
    } else {
      const result = await nodePinnedProbeGet(`${serverUrl}/api/v4/system/ping`, lookupImpl ?? dnsLookup, timeoutMs)
      status = result.status
      body = result.body
    }
  } catch (error) {
    if (error instanceof ProbeBlockedError) {
      return { status: 'invalid_url', message: 'This Mattermost server address is not allowed.' }
    }
    if (error instanceof ProbeSizeError) {
      return {
        status: 'not_a_mattermost_api_root',
        serverUrl,
        message: `${serverUrl}/api/v4/system/ping returned a response larger than ${MAX_PROBE_BYTES} bytes`
      }
    }
    if (isTlsFailure(error)) {
      return {
        status: 'tls_untrusted',
        serverUrl,
        message: `the certificate at ${serverUrl} was not trusted by this process; mount your internal CA bundle and set NODE_EXTRA_CA_CERTS on Setup Server, Control Plane, and Logto`
      }
    }
    return {
      status: 'unreachable',
      serverUrl,
      message: `${serverUrl} could not be reached from the Setup Server; check intranet connectivity or save anyway if the Control Plane and Logto can reach it`
    }
  }

  if (status === 200) {
    const validPing =
      body !== undefined &&
      (!('status' in body) || typeof body.status !== 'string' || body.status.toUpperCase() === 'OK')
    if (validPing) {
      return { status: 'ok', serverUrl, message: `${serverUrl} answered as a Mattermost API root` }
    }
  } else if ((status === 401 || status === 403) && body !== undefined) {
    return { status: 'ok', serverUrl, message: `${serverUrl} answered as a Mattermost API root` }
  }

  return {
    status: 'not_a_mattermost_api_root',
    serverUrl,
    message: `${serverUrl}/api/v4/system/ping answered ${status} rather than a Mattermost API root; check the server URL and any path prefix`
  }
}

function normalizeMattermostProbeUrl(
  rawServerUrl: string
): { ok: true; serverUrl: string } | { ok: false; reason: string } {
  const trimmed = rawServerUrl.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: 'Enter a valid Mattermost server URL (for example, https://mattermost.example.com).' }
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, reason: 'The Mattermost server URL must not include a query string or fragment.' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'Enter a valid Mattermost server URL (for example, https://mattermost.example.com).' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Mattermost server URL must use http:// or https://.' }
  }
  const authority = trimmed.slice(url.protocol.length + 2).split('/')[0] ?? ''
  if (url.username || url.password || authority.includes('@')) {
    return { ok: false, reason: 'The Mattermost server URL must not include a username or password.' }
  }
  if (!url.hostname) {
    return { ok: false, reason: 'Enter a valid Mattermost server URL (for example, https://mattermost.example.com).' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0 && isLinkLocalOrUnspecifiedIp(host)) {
    return { ok: false, reason: 'This Mattermost server address is not allowed.' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, serverUrl: `${url.origin}${path}` }
}

function isLinkLocalOrUnspecifiedV4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c, d] = octets as [number, number, number, number]
  if (a === 0 || (a === 169 && b === 254)) return true
  if (a === 100 && b === 100 && c === 100 && d === 200) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function parseIpv4Tail(part: string): [number, number] | null {
  const octets = part.split('.')
  if (octets.length !== 4 || octets.some((o) => !/^\d+$/.test(o))) return null
  const nums = octets.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  const [a, b, c, d] = nums as [number, number, number, number]
  return [((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff]
}

function expandIpv6Side(raw: string, allowTrailingV4: boolean): number[] | null {
  if (!raw) return []
  const parts = raw.split(':')
  const out: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!part) return null
    if (allowTrailingV4 && i === parts.length - 1 && part.includes('.')) {
      const pair = parseIpv4Tail(part)
      if (!pair) return null
      out.push(pair[0], pair[1])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    out.push(parseInt(part, 16))
  }
  return out
}

function parseIpv6Hextets(ip: string): number[] | null {
  const compressed = ip.split('::')
  if (compressed.length > 2) return null
  if (compressed.length === 1) {
    const hextets = expandIpv6Side(compressed[0]!, true)
    return hextets && hextets.length === 8 ? hextets : null
  }
  const left = expandIpv6Side(compressed[0]!, false)
  const right = expandIpv6Side(compressed[1]!, true)
  if (!left || !right || left.length + right.length >= 8) return null
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
}

function embeddedV4FromHextets(h: readonly number[]): string | null {
  const toV4 = (hi: number, lo: number): string => `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  const zero0to4 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0
  if (zero0to4 && h[5] === 0xffff) return toV4(h[6]!, h[7]!)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0) {
    return toV4(h[6]!, h[7]!)
  }
  if (zero0to4 && h[5] === 0 && (h[6] !== 0 || (h[7] ?? 0) > 1)) return toV4(h[6]!, h[7]!)
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return toV4(h[6]!, h[7]!)
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return toV4(h[6]!, h[7]!)
  return null
}

function isLinkLocalOrUnspecifiedIp(ip: string): boolean {
  const normalized = (
    ip
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? ''
  ).trim()
  if (isIP(normalized) === 4) return isLinkLocalOrUnspecifiedV4(normalized)
  const h = parseIpv6Hextets(normalized)
  if (!h) return false
  if (h.every((x) => x === 0)) return true
  if ((h[0]! & 0xffc0) === 0xfe80) return true
  if ((h[0]! & 0xff00) === 0xff00) return true
  if (
    h[0] === 0xfd00 &&
    h[1] === 0x0ec2 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0 &&
    h[6] === 0 &&
    h[7] === 0x0254
  ) {
    return true
  }
  const v4 = embeddedV4FromHextets(h)
  return v4 ? isLinkLocalOrUnspecifiedV4(v4) : false
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader()
  let raw: string
  if (reader) {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PROBE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new ProbeSizeError()
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    raw = Buffer.concat(chunks).toString('utf8')
  } else {
    raw = await response.text()
    if (Buffer.byteLength(raw) > MAX_PROBE_BYTES) throw new ProbeSizeError()
  }
  try {
    const body: unknown = JSON.parse(raw)
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** `fetch` reports TLS failures through nested `cause` (or `AggregateError.errors`), so walk a bounded tree. */
function isTlsFailure(error: unknown, depth = 0): boolean {
  if (error === undefined || error === null || depth >= 5) return false
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown }
  if (typeof candidate.code === 'string' && TLS_FAILURE_CODES.has(candidate.code)) return true
  if (Array.isArray(candidate.errors) && candidate.errors.some((item) => isTlsFailure(item, depth + 1))) {
    return true
  }
  return isTlsFailure(candidate.cause, depth + 1)
}
