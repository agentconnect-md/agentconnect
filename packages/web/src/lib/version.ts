// Minimal semver comparison for the daemon "update available" hint. The repo has no
// semver dependency and daemon versions are plain `X.Y.Z` or `X.Y.Z-rc.N` (the only
// two channels are npm `latest` = stable and `rc` = prerelease), so a focused
// comparator is enough — we don't need ranges, build metadata, or coercion.

interface Parsed {
  core: [number, number, number]
  /** Prerelease identifiers (`rc`, `4` → ['rc', 4]); empty ⇒ a stable release. */
  pre: (string | number)[]
}

// `1.2.3`, `1.2.3-rc.4`, optional leading `v`. Returns null for anything unexpected
// (a placeholder like '—', a dev tag, garbage) so callers can bail without nagging.
function parse(v: string | null | undefined): Parsed | null {
  if (!v) return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre }
}

// Standard semver precedence. Returns >0 if a>b, <0 if a<b, 0 if equal.
function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    const x = a.core[i] ?? 0
    const y = b.core[i] ?? 0
    if (x !== y) return x - y
  }
  // A version with a prerelease has LOWER precedence than one without (1.0.0 > 1.0.0-rc).
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const n = Math.min(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    // Numeric identifiers always rank lower than alphanumeric ones.
    if (xNum && !yNum) return -1
    if (!xNum && yNum) return 1
    if (xNum && yNum) return (x as number) - (y as number)
    return (x as string) < (y as string) ? -1 : 1
  }
  return a.pre.length - b.pre.length
}

/**
 * Whether `latest` is a strictly newer daemon release than `current` — the gate for
 * the console's "update available" badge. Conservative: any unparseable/missing input
 * (placeholder, dev build, npm not yet resolved) returns false so we never nag on
 * versions we can't reason about.
 */
export function isUpgradeAvailable(current: string | null | undefined, latest: string | null | undefined): boolean {
  const c = parse(current)
  const l = parse(latest)
  if (!c || !l) return false
  return compare(l, c) > 0
}
