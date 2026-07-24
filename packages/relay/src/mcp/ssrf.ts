import { lookup as dnsLookup } from 'node:dns'
import type { LookupFunction } from 'node:net'

/**
 * SSRF egress guard for the MCP reverse proxy (centralized-tool-management.md §5.3).
 *
 * The upstream URL is operator-supplied (CP registry), so proxying to it is an SSRF
 * primitive: without a guard it could reach the relay's own loopback, the pod/cluster
 * private network, or the cloud metadata endpoint (169.254.169.254). We (1) reject
 * private/loopback/link-local/reserved + metadata addresses, and (2) PIN the connection
 * to the exact validated IP via a custom `lookup`, so a name that validates public can't
 * be re-resolved to a private IP between check and connect (DNS rebinding / TOCTOU).
 *
 * Purpose-specific deploy allowlists (`RELAY_MCP_ALLOWED_UPSTREAMS` and
 * `RELAY_MEMORY_ALLOWED_UPSTREAMS`) let an operator opt specific hosts out of
 * the private-address block; callers supply the relevant set and pinning still
 * applies. The two permissions must never be merged.
 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(p)) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

// Disallowed IPv4 ranges: unspecified, private, CGNAT, loopback, link-local (incl. the
// 169.254.169.254 cloud metadata IP), IETF protocol/benchmark, multicast, reserved, broadcast.
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]

function blockedV4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip)
  if (ipInt === null) return false
  return BLOCKED_V4.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (ipInt & mask) === (baseInt & mask)
  })
}

/**
 * True if `ip` is an address the relay must NOT proxy to. Covers IPv4 (via CIDR table)
 * and IPv6: loopback (`::1`), unspecified (`::`), ULA (`fc00::/7`), link-local
 * (`fe80::/10`), and IPv4-mapped (`::ffff:a.b.c.d`, checked against the v4 table).
 */
export function isBlockedIp(ip: string): boolean {
  const addr = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (addr.includes('.') && !addr.includes(':')) return blockedV4(addr)
  // IPv4-mapped IPv6 — dotted (`::ffff:127.0.0.1`) or Node's canonical hex (`::ffff:7f00:1`).
  const mapped = addr.match(/^::ffff:(.+)$/)
  if (mapped) {
    const rest = mapped[1]!
    if (rest.includes('.')) return blockedV4(rest)
    const [hi = '0', lo = '0'] = rest.split(':')
    const h = parseInt(hi, 16)
    const l = parseInt(lo, 16)
    if (!Number.isNaN(h) && !Number.isNaN(l)) {
      return blockedV4(`${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`)
    }
  }
  if (addr === '::1' || addr === '::') return true
  const firstHextet = addr.split(':')[0] ?? ''
  const byte0 = parseInt(firstHextet.padStart(4, '0').slice(0, 2), 16)
  if (Number.isNaN(byte0)) return false
  if (byte0 === 0xfc || byte0 === 0xfd) return true // fc00::/7 ULA
  if (byte0 === 0xfe) {
    const byte1 = parseInt(firstHextet.padStart(4, '0').slice(2, 4) || '0', 16)
    if ((byte1 & 0xc0) === 0x80) return true // fe80::/10 link-local (top 10 bits 1111111010)
  }
  return false
}

/**
 * A `net.LookupFunction` that resolves `hostname`, blocks the request if ANY resolved
 * address is disallowed (unless `allowPrivate`), and returns a single validated address —
 * pinning the connection to it. Reject-if-any (not just the chosen IP) defeats round-robin
 * rebinding. On block/failure it errors the lookup, which fails the outbound connection.
 */
export function makeGuardedLookup(allowPrivate: boolean): LookupFunction {
  const fn: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      if (!addresses || addresses.length === 0) {
        return callback(new Error(`ssrf: no address for ${hostname}`), '', 0)
      }
      if (!allowPrivate) {
        const bad = addresses.find((a) => isBlockedIp(a.address))
        if (bad) return callback(new Error(`ssrf: blocked address ${bad.address} for ${hostname}`), '', 0)
      }
      const pick = addresses[0]!
      // Respect the caller's `all` shape (http.request may request either form).
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
