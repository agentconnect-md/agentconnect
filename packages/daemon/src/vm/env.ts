/** Env parsers that refuse a value rather than silently falling back: a mistyped ceiling that
 *  reads as "use the default" is how a host ends up oversubscribed with nothing in the log. */
export function positiveIntFromEnv(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return value
}

const UNITS: Array<[string, number]> = [
  ['gib', 1024 ** 3],
  ['mib', 1024 ** 2],
  ['kib', 1024],
  ['gb', 1000 ** 3],
  ['mb', 1000 ** 2],
  ['kb', 1000],
  ['g', 1024 ** 3],
  ['m', 1024 ** 2],
  ['k', 1024],
  ['b', 1]
]

/** Accepts what the helper's own `--memory` accepts, so one size is written the same way twice. */
export function ByteCountFromEnv(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const text = raw.trim().toLowerCase()
  const unit = UNITS.find(([suffix]) => text.endsWith(suffix))
  const digits = unit ? text.slice(0, -unit[0].length) : text
  const value = Number(digits)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive size, got "${raw}"`)
  return Math.floor(value * (unit ? unit[1] : 1))
}
