// Mattermost serverUrl SSRF policy, URL pinning, and credentialed file upload/download helpers.
import { lookup as dnsLookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { MattermostFileInfo } from '@agentconnect.md/message'
import type { UploadOutcome } from '../../mcp/ops/context.js'
import { isSendQueueTimeout } from '../send-queue.js'
import { abortableSleep, parseRetryAfterMs, type MattermostRateLimiter } from './rate-limit.js'

export const MATTERMOST_DOWNLOAD_TIMEOUT_MS = 30_000
export const MATTERMOST_UPLOAD_MAX_FILES = 10
const MATTERMOST_FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const NAME_MAX_CHARS = 200
const UPLOAD_NAME_MAX_BYTES = 256
const MAX_DOWNLOAD_RETRIES = 2

function normalizeLiteralIp(ip: string): string {
  return ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
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
  const clean = normalizeLiteralIp(ip).split('%')[0]
  if (!clean) return null
  const compressed = clean.split('::')
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
  if (zero0to4 && h[5] === 0xffff) return toV4(h[6]!, h[7]!) // ::ffff:0:0/96
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0) {
    return toV4(h[6]!, h[7]!) // ::ffff:0:0:0/96
  }
  if (zero0to4 && h[5] === 0 && (h[6] !== 0 || (h[7] ?? 0) > 1)) return toV4(h[6]!, h[7]!) // ::/96
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return toV4(h[6]!, h[7]!) // NAT64 64:ff9b::/96
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return toV4(h[6]!, h[7]!) // NAT64 64:ff9b:1::/48
  return null
}

/** This-host (`0.0.0.0/8`), link-local (`169.254.0.0/16`), cloud IMDS (`100.100.100.200`, `192.0.0.0/24`), benchmarking, and multicast/reserved IPv4. */
export function linkLocalOrUnspecifiedV4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c, d] = o as [number, number, number, number]
  if (a === 0 || (a === 169 && b === 254)) return true
  if (a === 100 && b === 100 && c === 100 && d === 200) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/** Unspecified (`::`), link-local (`fe80::/10`), multicast (`ff00::/8`), AWS IMDS (`fd00:ec2::254`), plus embedded IPv4 equivalents. */
export function linkLocalOrUnspecifiedV6(ip: string): boolean {
  const h = parseIpv6Hextets(ip)
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
  return v4 ? linkLocalOrUnspecifiedV4(v4) : false
}

/**
 * Always-blocked address guard: link-local (`169.254.0.0/16`, `fe80::/10`), cloud IMDS (`100.100.100.200`, `192.0.0.192`,
 * `fd00:ec2::254`), multicast/reserved, and unspecified (`0.0.0.0/8`, `::`), including NAT64 and mapped/translated IPv6 forms.
 */
export function isLinkLocalOrUnspecifiedAddress(ip: string): boolean {
  const addr = normalizeLiteralIp(ip)
  if (isIP(addr) === 4) return linkLocalOrUnspecifiedV4(addr)
  if (isIP(addr) === 6) return linkLocalOrUnspecifiedV6(addr)
  return false
}

function privateV4(ip: string): boolean {
  if (linkLocalOrUnspecifiedV4(ip)) return true
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = o as [number, number, number, number]
  if (a === 127 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Full private + loopback + ULA + link-local + IMDS address block (enforced in shared cloud workers). */
export function isBlockedPrivateAddress(ip: string): boolean {
  if (isLinkLocalOrUnspecifiedAddress(ip)) return true
  const addr = normalizeLiteralIp(ip)
  if (isIP(addr) === 4) return privateV4(addr)
  const h = parseIpv6Hextets(addr)
  if (!h) return false
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true // ::1
  const v4 = embeddedV4FromHextets(h)
  if (v4) return privateV4(v4)
  return (h[0]! & 0xfe00) === 0xfc00 // fc00::/7
}

/** Whether private/loopback Mattermost targets are permitted in this daemon process. */
export function allowMattermostPrivateNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MATTERMOST_ALLOW_PRIVATE_NETWORK === 'true') return true
  if (env.MATTERMOST_ALLOW_PRIVATE_NETWORK === 'false') return false
  return env.AGENTCONNECT_SUPERVISOR !== 'k8s'
}

interface AllowedHost {
  host: string
  port?: string
}

/** Allowlist entries for when private networks are off: a bare host covers every port, `host:port` or `[v6]:port` only that one. */
function mattermostAllowedEntries(env: NodeJS.ProcessEnv = process.env): AllowedHost[] {
  return [env.MATTERMOST_ALLOWED_HOSTS, env.AGENTCONNECT_INTERNAL_ALLOWED_HOSTS]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((raw) => raw.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
      if (bracketed) return { host: bracketed[1]!, ...(bracketed[2] ? { port: bracketed[2] } : {}) }
      const withPort = isIP(entry) === 0 ? /^(.+):(\d+)$/.exec(entry) : null
      return withPort ? { host: withPort[1]!, port: withPort[2]! } : { host: entry }
    })
}

/** Allowed intranet hostnames when `allowMattermostPrivateNetwork()` is false, whatever port each entry names. */
export function mattermostAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(mattermostAllowedEntries(env).map((entry) => entry.host))
}

/** Whether the allowlist admits this host on this port; a host named only with other ports is not admitted. */
function mattermostPortAllowed(host: string, port: string, env: NodeJS.ProcessEnv): boolean {
  const named = mattermostAllowedEntries(env).filter((entry) => entry.host === host)
  return named.some((entry) => entry.port === undefined || entry.port === port)
}

/**
 * Validate and normalize a Mattermost base URL:
 * - requires `http://` or `https://`
 * - forbids embedded userinfo, query strings, fragments, whitespace, and control characters
 * - always forbids link-local, IMDS, multicast/reserved, and unspecified literal IPs
 * - forbids private/loopback literal IPs when `allowMattermostPrivateNetwork()` is false unless explicitly allowlisted
 * - preserves subpath and strips trailing slashes
 */
export function validateMattermostServerUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; serverUrl: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: 'Mattermost serverUrl must be a valid http(s) URL without whitespace' }
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, reason: 'Mattermost serverUrl must not contain a query string or fragment' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'Mattermost serverUrl is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Mattermost serverUrl must use http:// or https://' }
  }
  const authority = trimmed.slice(url.protocol.length + 2).split('/')[0] ?? ''
  if (url.username || url.password || authority.includes('@')) {
    return { ok: false, reason: 'Mattermost serverUrl must not include userinfo' }
  }
  if (!url.hostname) {
    return { ok: false, reason: 'Mattermost serverUrl must include a hostname' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (isIP(host) !== 0) {
    if (isLinkLocalOrUnspecifiedAddress(host)) {
      return { ok: false, reason: 'Mattermost serverUrl address is blocked (link-local or unspecified)' }
    }
    if (!allowMattermostPrivateNetwork(env) && !mattermostPortAllowed(host.toLowerCase(), port, env)) {
      if (isBlockedPrivateAddress(host)) {
        return { ok: false, reason: 'Mattermost serverUrl private address is blocked unless allowlisted' }
      }
    }
  } else if (
    !allowMattermostPrivateNetwork(env) &&
    mattermostAllowedHosts(env).has(host.toLowerCase()) &&
    !mattermostPortAllowed(host.toLowerCase(), port, env)
  ) {
    // The DNS check sees only the hostname, so a host allowlisted for particular ports is held to them here.
    return { ok: false, reason: 'Mattermost serverUrl port is not allowlisted for this host' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, serverUrl: `${url.origin}${path}` }
}

/** DNS lookup pinning: always rejects link-local/IMDS/unspecified addresses, and rejects private/loopback IPs when private network access is disabled. */
export function makeMattermostLookup(resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      if (!addresses.length || addresses.some((entry) => isLinkLocalOrUnspecifiedAddress(entry.address))) {
        return callback(new Error('mattermost: host resolves to a blocked address'), '', 0)
      }
      const normalizedHost = normalizeLiteralIp(hostname)
      if (
        !allowMattermostPrivateNetwork() &&
        !mattermostAllowedHosts().has(normalizedHost) &&
        addresses.some((entry) => isBlockedPrivateAddress(entry.address))
      ) {
        return callback(new Error('mattermost: host resolves to a private address'), '', 0)
      }
      if (options.all) return (callback as (e: null, a: typeof addresses) => void)(null, addresses)
      return callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }
}

let sharedDispatcher: Dispatcher | undefined

export function getMattermostDispatcher(): Dispatcher {
  sharedDispatcher ??= new Agent({ connect: { lookup: makeMattermostLookup() } })
  return sharedDispatcher
}

export function mattermostFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) return fetchImpl
  const dispatcher = getMattermostDispatcher()
  return (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher
    }) as unknown as Promise<Response>
}

/** Extract a safe base filename from a `Content-Disposition` header, stripping traversal segments and control chars. */
export function mattermostDispositionName(header: string | null): string | undefined {
  if (!header) return undefined
  const raw = /filename\*=UTF-8''([^;\s]+)/i.exec(header)?.[1] ?? /filename="?([^";]+)"?/i.exec(header)?.[1]
  if (!raw) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const base = (decoded.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!base || base === '.' || base === '..') return undefined
  return base.length > NAME_MAX_CHARS ? base.slice(base.length - NAME_MAX_CHARS) : base
}

/**
 * Resolve a Mattermost file reference (bare file ID or full URL) strictly pinned to the configured `serverUrl` origin and subpath.
 * Rejects mismatched origins, userinfo, non-file API paths, or path-traversal attempts.
 */
export function resolveMattermostFileUrl(serverUrl: string, fileIdOrUrl: string): URL | undefined {
  const checkedBase = validateMattermostServerUrl(serverUrl)
  if (!checkedBase.ok) return undefined
  const base = new URL(checkedBase.serverUrl)
  const basePath = base.pathname.replace(/\/+$/, '')
  const trimmed = fileIdOrUrl.trim()
  if (!trimmed) return undefined

  if (MATTERMOST_FILE_ID_RE.test(trimmed)) {
    return new URL(`${base.origin}${basePath}/api/v4/files/${trimmed}`)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== base.protocol || parsed.origin !== base.origin) return undefined
  if (parsed.username || parsed.password || parsed.hash) return undefined

  const prefix = `${basePath}/api/v4/files/`
  if (!parsed.pathname.startsWith(prefix)) return undefined
  const rest = parsed.pathname.slice(prefix.length)
  const segments = rest.split('/')
  if (segments.length === 1) {
    if (!MATTERMOST_FILE_ID_RE.test(segments[0] ?? '')) return undefined
  } else if (segments.length === 2) {
    if (!MATTERMOST_FILE_ID_RE.test(segments[0] ?? '') || segments[1] !== 'thumbnail') return undefined
  } else {
    return undefined
  }
  return parsed
}

export interface MattermostDownloadDeps {
  serverUrl: string
  botToken: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  rateLimiter?: MattermostRateLimiter
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface MattermostDownloaded {
  bytes: Buffer
  fileName?: string
  contentType?: string
}

/**
 * Download an attachment strictly from the configured Mattermost server with `redirect: 'error'` and Bearer auth.
 * Returns null on validation/network/size failures and never throws or leaks tokens.
 */
export async function downloadMattermostFile(
  deps: MattermostDownloadDeps,
  fileIdOrUrl: string,
  maxBytes: number,
  reportFailure: (reason: string) => void = () => {}
): Promise<MattermostDownloaded | null> {
  const unavailable = (reason: string): null => {
    reportFailure(reason)
    return null
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return unavailable('invalid_size_limit')
  const url = resolveMattermostFileUrl(deps.serverUrl, fileIdOrUrl)
  if (!url) return unavailable('refused_url')

  const fetcher = mattermostFetch(deps.fetchImpl)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? abortableSleep

  for (let attempt = 0; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    if (deps.signal.aborted) return unavailable('aborted')
    try {
      await deps.rateLimiter?.waitIfLimited(deps.signal)
      const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(MATTERMOST_DOWNLOAD_TIMEOUT_MS)])
      const response = await fetcher(url.href, {
        method: 'GET',
        headers: { Authorization: `Bearer ${deps.botToken}` },
        redirect: 'error',
        signal
      })

      if (response.status === 429 && attempt < MAX_DOWNLOAD_RETRIES) {
        const delayMs = parseRetryAfterMs(response.headers, now()) ?? 1_000
        await response.body?.cancel().catch(() => {})
        deps.rateLimiter?.backoff(delayMs)
        await (deps.rateLimiter ? deps.rateLimiter.waitIfLimited(deps.signal) : sleep(delayMs, deps.signal))
        continue
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return unavailable(`http_${response.status}`)
      }

      const contentType = response.headers.get('content-type') ?? undefined
      if (contentType && contentType.toLowerCase().includes('text/html')) {
        await response.body?.cancel().catch(() => {})
        return unavailable('unexpected_html')
      }

      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {})
        return unavailable('size_limit')
      }

      const reader = response.body?.getReader()
      if (!reader) return unavailable('empty_body')
      const chunks: Buffer[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) return unavailable('size_limit')
          chunks.push(Buffer.from(value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const fileName = mattermostDispositionName(response.headers.get('content-disposition'))
      return {
        bytes: Buffer.concat(chunks),
        ...(fileName ? { fileName } : {}),
        ...(contentType ? { contentType } : {})
      }
    } catch (error) {
      return unavailable(
        deps.signal.aborted
          ? 'aborted'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'fetch_failed'
      )
    }
  }
  return unavailable('http_429')
}

/** Sanitize and bound an uploaded file name to Mattermost's 256-byte cap while keeping its extension. */
export function mattermostUploadName(name: string): string {
  const clean = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'file'
  if (Buffer.byteLength(clean) <= UPLOAD_NAME_MAX_BYTES) return clean
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? ''
  let stem = ''
  for (const ch of clean.slice(0, clean.length - ext.length)) {
    if (Buffer.byteLength(stem + ch + ext) > UPLOAD_NAME_MAX_BYTES) break
    stem += ch
  }
  return (stem || 'file') + ext
}

export interface MattermostUploadPort {
  uploadFiles(
    channelId: string,
    files: readonly { bytes: Buffer; name: string; mimeType?: string }[]
  ): Promise<MattermostFileInfo[]>
  createPost(body: {
    channel_id: string
    message: string
    root_id?: string
    file_ids?: string[]
    props?: Record<string, unknown>
  }): Promise<{ id?: string }>
  getPost?(postId: string): Promise<{ root_id?: string }>
}

function isMediaInvalidRootIdError(error: unknown): boolean {
  const status = errorStatusOf(error)
  if (status !== 400) return false
  const id = typeof error === 'object' && error !== null ? (error as { id?: unknown }).id : undefined
  const message = error instanceof Error ? error.message : ''
  return (typeof id === 'string' && id.includes('root_id')) || /invalid\s+root_?id/i.test(message)
}

function errorStatusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status
  }
  return undefined
}

function maybeDeliveredOf(error: unknown): boolean {
  return (
    isSendQueueTimeout(error) ||
    (typeof error === 'object' && error !== null && (error as { maybeDelivered?: unknown }).maybeDelivered === true)
  )
}

function classifyMattermostUploadStatus(
  status: number | undefined
): 'too_large' | 'not_found' | 'forbidden' | 'platform_error' {
  if (status === 413) return 'too_large'
  if (status === 404) return 'not_found'
  if (status === 403 || status === 401) return 'forbidden'
  return 'platform_error'
}

/**
 * 2-step Mattermost file share:
 * 1. `POST /api/v4/files?channel_id=...` (multipart `files`) -> collects `file_ids`
 * 2. `POST /api/v4/posts` attaching `file_ids` (+ optional `message`, `root_id`, `props`)
 */
export async function uploadMattermostMedia(
  port: MattermostUploadPort,
  channelId: string,
  files: readonly { bytes: Buffer; name: string; mimeType?: string }[],
  opts?: {
    caption?: string
    rootId?: string
    props?: Record<string, unknown>
    overflowCaptions?: readonly string[]
    onWarning?: (message: string) => void
  }
): Promise<UploadOutcome> {
  if (files.length === 0) return { ok: false, reason: 'platform_error', detail: 'no files to upload' }
  if (files.length > MATTERMOST_UPLOAD_MAX_FILES) {
    return {
      ok: false,
      reason: 'platform_error',
      detail: `Mattermost accepts at most ${MATTERMOST_UPLOAD_MAX_FILES} files per post`
    }
  }

  let infos: MattermostFileInfo[]
  try {
    infos = await port.uploadFiles(
      channelId,
      files.map((file) => ({
        bytes: file.bytes,
        name: mattermostUploadName(file.name),
        ...(file.mimeType ? { mimeType: file.mimeType } : {})
      }))
    )
  } catch (error) {
    const status = errorStatusOf(error)
    const detail = error instanceof Error ? error.message : 'file upload failed'
    return { ok: false, reason: classifyMattermostUploadStatus(status), detail }
  }

  const fileIds = infos.map((info) => info.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (fileIds.length !== files.length) {
    return { ok: false, reason: 'platform_error', detail: 'Mattermost returned fewer file ids than uploaded' }
  }

  let postId: string | undefined
  let effectiveRootId = opts?.rootId
  try {
    const post = await port.createPost({
      channel_id: channelId,
      message: opts?.caption ?? '',
      ...(effectiveRootId ? { root_id: effectiveRootId } : {}),
      file_ids: fileIds,
      ...(opts?.props ? { props: opts.props } : {})
    })
    postId = post.id
  } catch (error) {
    if (effectiveRootId && isMediaInvalidRootIdError(error)) {
      const parent = await port.getPost?.(effectiveRootId).catch(() => undefined)
      effectiveRootId = parent?.root_id && parent.root_id !== effectiveRootId ? parent.root_id : undefined
      try {
        const retried = await port.createPost({
          channel_id: channelId,
          message: opts?.caption ?? '',
          ...(effectiveRootId ? { root_id: effectiveRootId } : {}),
          file_ids: fileIds,
          ...(opts?.props ? { props: opts.props } : {})
        })
        postId = retried.id
      } catch (retryErr) {
        if (maybeDeliveredOf(retryErr)) return { ok: false, reason: 'indeterminate' }
        const status = errorStatusOf(retryErr)
        const detail = retryErr instanceof Error ? retryErr.message : 'post creation failed'
        return { ok: false, reason: classifyMattermostUploadStatus(status), detail }
      }
    } else {
      if (maybeDeliveredOf(error)) {
        return { ok: false, reason: 'indeterminate' }
      }
      const status = errorStatusOf(error)
      const detail = error instanceof Error ? error.message : 'post creation failed'
      return { ok: false, reason: classifyMattermostUploadStatus(status), detail }
    }
  }

  let captionWarning: string | undefined
  if (opts?.overflowCaptions?.length) {
    const replyRoot = effectiveRootId ?? postId
    for (const part of opts.overflowCaptions) {
      try {
        await port.createPost({
          channel_id: channelId,
          message: part,
          ...(replyRoot ? { root_id: replyRoot } : {}),
          ...(opts?.props ? { props: opts.props } : {})
        })
      } catch (error) {
        opts.onWarning?.(error instanceof Error ? error.message : 'caption overflow failed')
        captionWarning = 'Part of the caption was not delivered.'
        break
      }
    }
  }

  return {
    ok: true,
    ...(postId ? { messageId: postId } : {}),
    fileIds,
    ...(captionWarning ? { warning: captionWarning } : {})
  }
}
