/**
 * Pure mappers + grant-key mint for the centralized MCP-provider registry
 * (docs/designs/centralized-tool-management.md §5–§7). Sibling of placement.ts's
 * `integrationToSpec`/`agentRecordToSpec` — transport-free, Prisma-free.
 *
 * MCP-PROXY MODEL: a provider is pushed to daemons as a proxied `http` MCP def
 * whose `url` is a RELAY proxy URL and whose header is a short-lived PLAINTEXT
 * grant key (`Authorization: Bearer …`) — NEVER the upstream endpoint or its real
 * credential. The upstream url + secret headers go only to relays via rc/mcp-assign,
 * which carries sha256(grantKey), never the plaintext.
 *
 * SECURITY: the grant key (plaintext) and upstream headers are secrets — the outputs
 * of `mcpProxyDef`/`mcpRcAssign` are token-bearing frames; NEVER log them.
 */
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import type { McpServerSpec, RcMcpAssign } from '@agentconnect.md/protocol'

/** The provider fields the mappers read (structural subset of the McpProvider row). */
interface ProviderView {
  id: string
  orgId: string
  name: string
  url: string
}

function privateV4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  const a = o[0] ?? -1
  const b = o[1] ?? -1
  if (a === 0 || a === 127) return true // this-host / loopback
  if (a === 10) return true // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  return false
}

function privateV6(ip: string): boolean {
  const l = ip.toLowerCase()
  if (l === '::1' || l === '::') return true // loopback / unspecified
  const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped (dotted)
  if (mapped?.[1]) return privateV4(mapped[1])
  const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) // IPv4-mapped (URL-normalized hex)
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const head = l.split(':')[0] ?? ''
  if (/^f[cd]/.test(head)) return true // fc00::/7 ULA
  if (/^fe[89ab]/.test(head)) return true // fe80::/10 link-local
  return false
}

/**
 * Fast-fail SSRF gate for a user-supplied upstream MCP url (§5.3). Returns a reason
 * string when the url must be REJECTED at write time, or null when it may be stored.
 * The relay does the authoritative DNS-time guard on every outbound call; this only
 * bounces an obviously-bad url or a literal private/loopback/link-local/metadata IP.
 * ponytail: literal-IP + protocol check only; DNS-rebinding is the relay's job.
 */
export function blockedUpstreamUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'url must be a valid absolute URL'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must use http or https'
  if (u.username || u.password) return 'url must not contain credentials'
  let host = u.hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1) // IPv6 literal
  if (host.toLowerCase() === 'localhost') return 'url host resolves to a private/loopback address'
  const fam = net.isIP(host)
  if ((fam === 4 && privateV4(host)) || (fam === 6 && privateV6(host))) {
    return 'url host is a private, loopback, link-local, or metadata IP'
  }
  return null
}

/** A fresh opaque bearer grant key. `oct_` prefix + 24 random bytes (base64url). */
export function mintGrantKey(): string {
  return 'oct_' + randomBytes(24).toString('base64url')
}

/** sha256 hex of a grant key — what the relay stores/matches (never the plaintext). */
export function grantKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * The relay's public HTTP(S) origin for the MCP proxy, derived from the roster's
 * per-instance rd/* dial URL. The relay serves `/mcp/:id` over HTTP on the SAME
 * server/port it accepts the daemon WS on, so only the scheme differs: ws→http,
 * wss→https; any path is dropped. Without this the daemon def would advertise
 * `transport:'http'` against a `wss://…` URL and MCP clients wouldn't connect.
 */
export function relayHttpOrigin(relayUrl: string): string {
  const u = new URL(relayUrl)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

/**
 * The daemon proxy def for a provider: an `http` MCP server pointing at the relay
 * proxy URL with the PLAINTEXT grant key as its bearer. NEVER carries the upstream
 * url or upstream secret headers.
 */
export function mcpProxyDef(provider: ProviderView, grantKey: string, relayBaseUrl: string): McpServerSpec {
  return {
    orgId: provider.orgId,
    name: provider.name,
    transport: 'http',
    url: `${relayBaseUrl}/mcp/${provider.id}`,
    headers: [{ name: 'Authorization', value: `Bearer ${grantKey}` }],
    args: [],
    env: []
  }
}

/**
 * The rc/mcp-assign binding for a relay: the provider's UPSTREAM url + secret headers
 * plus the sha256 of each active grant key (never the plaintext keys themselves).
 */
export function mcpRcAssign(
  provider: ProviderView,
  upstreamHeaders: { name: string; value: string }[],
  grantKeys: string[]
): RcMcpAssign {
  return {
    providerId: provider.id,
    upstreamUrl: provider.url,
    headers: upstreamHeaders,
    grantKeyHashes: grantKeys.map(grantKeyHash)
  }
}
