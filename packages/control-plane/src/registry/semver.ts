// Minimal semver precedence for daemon versions (`X.Y.Z` or `X.Y.Z-rc.N`); mirrors web `lib/version.ts`.

interface Parsed {
  core: [number, number, number]
  pre: (string | number)[]
}

function parse(v: string | null | undefined): Parsed | null {
  if (!v) return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre }
}

function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!
  }
  // A prerelease ranks below its release (1.0.0 > 1.0.0-rc.1).
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]!
    const y = b.pre[i]!
    if (x === y) continue
    // Numeric identifiers rank below alphanumeric ones.
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return a.pre.length - b.pre.length
}

/** Whether `a` is strictly older than `b`; false when either does not parse. */
export function isOlderVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parse(a)
  const y = parse(b)
  return Boolean(x && y && compare(x, y) < 0)
}
