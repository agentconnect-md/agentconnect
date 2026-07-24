/**
 * Minimal `engines.node` range check (cli-daemon-split.md §5.1 step 3) — enough
 * for the simple ranges npm packages actually use (`>=24`, `>=24.0.0`, `24 || 25`)
 * without pulling in a full semver dependency. Comparators within a group are
 * ANDed; `||` separates OR groups. Pre-release tags on the Node version are
 * ignored. An unparseable range returns `true` (accept) rather than blocking on
 * an exotic spec the caller never emits.
 */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

function satisfiesComparator(comparator: string, version: [number, number, number]): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator.trim())
  if (!m) return true
  const op = m[1] ?? '='
  const target = parseVersion(m[2]!)
  if (!target) return true
  const c = cmp(version, target)
  switch (op) {
    case '>=':
      return c >= 0
    case '>':
      return c > 0
    case '<=':
      return c <= 0
    case '<':
      return c < 0
    case '^': // caret: same major, >= target
      return version[0] === target[0] && c >= 0
    case '~': // tilde: same major.minor, >= target
      return version[0] === target[0] && version[1] === target[1] && c >= 0
    default:
      return c === 0
  }
}

/** Whether `nodeVersion` satisfies the `engines.node` `range`. */
export function nodeSatisfies(range: string | undefined, nodeVersion: string): boolean {
  if (!range || range.trim() === '' || range.trim() === '*') return true
  const version = parseVersion(nodeVersion)
  if (!version) return true
  return range.split('||').some((group) => {
    const comparators = group.trim().split(/\s+/).filter(Boolean)
    if (comparators.length === 0) return true
    return comparators.every((c) => satisfiesComparator(c, version))
  })
}
