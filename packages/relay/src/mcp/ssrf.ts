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

function parseIpv6Hextets(addr: string): number[] | null {
  const compressed = addr.split('::')
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

/**
 * True if `ip` is an address the relay must NOT proxy to. Covers IPv4 (via CIDR table + Alibaba IMDS)
 * and IPv6: loopback (`::1`), unspecified (`::`), ULA (`fc00::/7`), link-local (`fe80::/10`),
 * multicast (`ff00::/8`), AWS IMDS (`fd00:ec2::254`), and embedded IPv4 forms.
 */
export function isBlockedIp(ip: string): boolean {
  const addr =
    ip
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? ''
  if (addr.includes('.') && !addr.includes(':')) {
    return addr === '100.100.100.200' || blockedV4(addr)
  }
  const h = parseIpv6Hextets(addr)
  if (!h) return false
  if (h.every((x) => x === 0)) return true // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true // ::1
  const v4 = embeddedV4FromHextets(h)
  if (v4) return v4 === '100.100.100.200' || blockedV4(v4)
  if ((h[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 ULA (incl. fd00:ec2::254)
  if ((h[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h[0]! & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * A `net.LookupFunction` that resolves `hostname`, blocks the request if ANY resolved
 * address is disallowed (unless `allowPrivate`), and returns only the validated
 * addresses (all of them when `options.all` is truthy so Node Happy Eyeballs works
 * across dual-stack AAAA/A records, or `addresses[0]` otherwise) — pinning the
 * connection without DNS re-resolution. Reject-if-any (not just the chosen IP) defeats
 * round-robin rebinding. On block/failure it errors the lookup, which fails the
 * outbound connection.
 */
export function makeGuardedLookup(allowPrivate: boolean, resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  const fn: LookupFunction = (hostname, options, callback) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      if (!addresses || addresses.length === 0) {
        return callback(new Error(`ssrf: no address for ${hostname}`), '', 0)
      }
      if (!allowPrivate) {
        const bad = addresses.find((a) => isBlockedIp(a.address))
        if (bad) return callback(new Error(`ssrf: blocked address ${bad.address} for ${hostname}`), '', 0)
      }
      // Respect the caller's `all` shape (http.request may request either form).
      if ((options as { all?: boolean } | undefined)?.all) {
        return (callback as unknown as (e: Error | null, a: Array<{ address: string; family: number }>) => void)(
          null,
          addresses.map(({ address, family }) => ({ address, family }))
        )
      }
      const pick = addresses[0]!
      callback(null, pick.address, pick.family)
    })
  }
  return fn
}
