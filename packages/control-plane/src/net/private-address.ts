/**
 * One definition of "this literal address can never be reached from the public
 * internet", shared by the SSRF fast-fail on user-supplied upstream URLs
 * (`orchestrator/mcpProvider.ts`) and the public-ingress gate on http-transport
 * bots (`http/relay-ingress.ts`). Pure — literals only, no DNS.
 */

/** This-host, link-local, cloud metadata (AWS/GCP/Azure/Alibaba/Oracle), benchmark, and multicast/reserved IPv4. */
export function linkLocalOrUnspecifiedV4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c, d] = o as [number, number, number, number]
  if (a === 0 || (a === 169 && b === 254)) return true // unspecified + 169.254/16 link-local & cloud IMDS
  if (a === 100 && b === 100 && c === 100 && d === 200) return true // Alibaba Cloud IMDS
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments (incl. Oracle Cloud IMDS 192.0.0.192)
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/** RFC 1918 / loopback / link-local / CGNAT IPv4, plus cloud metadata and unroutable ranges. */
export function privateV4(ip: string): boolean {
  if (linkLocalOrUnspecifiedV4(ip)) return true
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = o as [number, number, number, number]
  if (a === 127) return true // loopback
  if (a === 10) return true // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
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

/** Expand an IPv6 literal into 8 16-bit hextets (handles brackets, zone IDs, `::`, and embedded dotted IPv4). */
export function parseIpv6Hextets(ip: string): number[] | null {
  const clean = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
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

/** Extract embedded IPv4 from `::ffff:0:0/96`, `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96` & `64:ff9b:1::/48`, or `::/96`. */
export function embeddedV4FromHextets(h: readonly number[]): string | null {
  const toV4 = (hi: number, lo: number): string => `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  const zero0to4 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0
  if (zero0to4 && h[5] === 0xffff) return toV4(h[6]!, h[7]!) // ::ffff:0:0/96
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0) {
    return toV4(h[6]!, h[7]!) // ::ffff:0:0:0/96 (SIIT / RFC 2765)
  }
  if (zero0to4 && h[5] === 0 && (h[6] !== 0 || (h[7] ?? 0) > 1)) {
    return toV4(h[6]!, h[7]!) // deprecated IPv4-compatible ::/96 (excluding :: and ::1)
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return toV4(h[6]!, h[7]!) // NAT64 64:ff9b::/96
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) {
    return toV4(h[6]!, h[7]!) // NAT64 local-use 64:ff9b:1::/48
  }
  return null
}

/** Unspecified (`::`), link-local (`fe80::/10`), multicast (`ff00::/8`), AWS IPv6 IMDS (`fd00:ec2::254`), and embedded IPv4 equivalents. */
export function linkLocalOrUnspecifiedV6(ip: string): boolean {
  const h = parseIpv6Hextets(ip)
  if (!h) return false
  if (h.every((x) => x === 0)) return true // unspecified ::
  if ((h[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h[0]! & 0xff00) === 0xff00) return true // ff00::/8 multicast
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
    return true // fd00:ec2::254 AWS IPv6 IMDS
  }
  const v4 = embeddedV4FromHextets(h)
  return v4 ? linkLocalOrUnspecifiedV4(v4) : false
}

/** Loopback / unspecified / ULA / link-local / multicast IPv6, plus embedded IPv4 equivalents. */
export function privateV6(ip: string): boolean {
  if (linkLocalOrUnspecifiedV6(ip)) return true
  const h = parseIpv6Hextets(ip)
  if (!h) return false
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true // ::1 loopback
  const v4 = embeddedV4FromHextets(h)
  if (v4) return privateV4(v4)
  if ((h[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  return false
}
