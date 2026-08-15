/**
 * One definition of "this literal address can never be reached from the public
 * internet", shared by the SSRF fast-fail on user-supplied upstream URLs
 * (`orchestrator/mcpProvider.ts`) and the public-ingress gate on http-transport
 * bots (`http/relay-ingress.ts`). Pure — literals only, no DNS.
 */

/** RFC 1918 / loopback / link-local / CGNAT IPv4, plus the cloud metadata address. */
export function privateV4(ip: string): boolean {
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

/** Loopback / unspecified / ULA / link-local IPv6, and IPv4-mapped forms of the above. */
export function privateV6(ip: string): boolean {
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
