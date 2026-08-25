// ⚠️ NO RELATIVE IMPORTS — a bundler compiles this from source; web's protocol-imports.leaf.test.ts enforces it.
/**
 * `decimal-amount.ts` — the exact money type of the usage report contract.
 *
 * A cost is metered by one party, accumulated by another, and eventually billed:
 * binary floating point is wrong for every step of that, so an amount travels as a
 * fixed-point DECIMAL STRING and is stored as `NUMERIC(38,18)`. The canonical form is
 * non-negative, never exponential, unsigned, with no redundant leading or trailing
 * zeros — `"0"`, `"0.00000125"`, `"12.75"`.
 *
 * A report may still arrive as a JSON number (that is what every daemon sends today),
 * so `ReportedCostAmount` accepts both and the CP's ingress adapters normalize to the
 * canonical string BEFORE anything accumulates. The number branch is a compatibility
 * shape, not a second money type: nothing downstream of an adapter sees it.
 */
import { z } from 'zod'

/** `NUMERIC(38,18)` — the column both usage tables use. */
export const MAX_AMOUNT_PRECISION = 38
export const MAX_AMOUNT_SCALE = 18
/** 20 — what precision leaves for the integer part. */
export const MAX_AMOUNT_INTEGER_DIGITS = MAX_AMOUNT_PRECISION - MAX_AMOUNT_SCALE

/** Canonical: unsigned, non-exponential, no redundant leading zero. */
const CANONICAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/
/** Same, but leading zeros allowed — what an expansion or a rounding carry produces. */
const FIXED_POINT = /^([0-9]+)(?:\.([0-9]+))?$/
const EXPONENTIAL = /^([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$/

function stripTrailingZeros(frac: string): string {
  let end = frac.length
  while (end > 0 && frac[end - 1] === '0') end -= 1
  return frac.slice(0, end)
}

function stripLeadingZeros(int: string): string {
  let start = 0
  while (start < int.length - 1 && int[start] === '0') start += 1
  return int.slice(start)
}

function join(int: string, frac: string): string {
  return frac.length > 0 ? `${int}.${frac}` : int
}

/** `1.25e-8` → `"0.0000000125"`. Exponential notation is never canonical, but
 *  `String(1.25e-8)` produces it, so the number branch has to expand it first. */
function fromExponential(text: string): string | null {
  const m = EXPONENTIAL.exec(text)
  if (!m) return null
  const digits = m[1]! + (m[2] ?? '')
  // Where the point lands inside `digits` once the exponent is applied.
  const point = m[1]!.length + Number(m[3]!)
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

/** ROUND_HALF_UP to `scale` places, applied at most once — at the ingress adapter. */
function roundHalfUp(int: string, frac: string, scale: number): { int: string; frac: string } {
  if (frac.length <= scale) return { int, frac }
  const kept = frac.slice(0, scale)
  if (frac.charCodeAt(scale) < 0x35) return { int, frac: kept } // '5'
  const digits = [...int, ...kept]
  let i = digits.length - 1
  while (i >= 0 && digits[i] === '9') {
    digits[i] = '0'
    i -= 1
  }
  if (i < 0) digits.unshift('1')
  else digits[i] = String(Number(digits[i]) + 1)
  // A carry past the leading digit lengthens the integer part by one.
  const intLen = int.length + (digits.length - int.length - kept.length)
  return { int: digits.slice(0, intLen).join(''), frac: digits.slice(intLen).join('') }
}

/**
 * A decimal string in canonical form, or `null` when it is not a usable amount.
 *
 * Redundant TRAILING zeros are canonicalized rather than refused — `"12.50"` is a
 * money-shaped value a metering source will send, and rejecting a whole batch over a
 * cosmetic zero would drop real spend. Everything that changes the value (a sign, an
 * exponent, a leading zero, more than 18 fractional or 20 integer digits) is refused.
 */
export function canonicalizeDecimalAmount(text: string): DecimalAmount | null {
  const m = CANONICAL.exec(text)
  if (!m) return null
  const int = m[1]!
  const frac = m[2] ?? ''
  if (int.length > MAX_AMOUNT_INTEGER_DIGITS || frac.length > MAX_AMOUNT_SCALE) return null
  return join(int, stripTrailingZeros(frac))
}

/**
 * A JSON number's own decimal value in canonical form, or `null` when unusable.
 *
 * `String(value)` on purpose, not `toFixed`: it yields the shortest round-tripping
 * decimal, which is the number as it was written on the wire (`0.1` → `"0.1"`), where
 * `toFixed(18)` would expand the binary approximation (`"0.100000000000000006"`).
 */
export function decimalAmountFromNumber(value: number): DecimalAmount | null {
  if (!Number.isFinite(value) || value < 0) return null
  const text = String(value)
  const fixed = text.includes('e') || text.includes('E') ? fromExponential(text) : text
  const m = fixed === null ? null : FIXED_POINT.exec(fixed)
  if (!m) return null
  const rounded = roundHalfUp(m[1]!, m[2] ?? '', MAX_AMOUNT_SCALE)
  const int = stripLeadingZeros(rounded.int)
  if (int.length > MAX_AMOUNT_INTEGER_DIGITS) return null
  return join(int, stripTrailingZeros(rounded.frac))
}

/** Normalize either reported shape to the canonical string, or `null` if unusable. */
export function normalizeReportedCostAmount(value: number | string): DecimalAmount | null {
  return typeof value === 'number' ? decimalAmountFromNumber(value) : canonicalizeDecimalAmount(value)
}

// ── exact arithmetic ────────────────────────────────────────────────────────
// Amounts are added and subtracted as integers scaled by `MAX_AMOUNT_SCALE`, which
// is exact for every value the column can hold. A decimal LIBRARY is deliberately
// not used here: decimal.js (what Prisma's `Decimal` is) rounds arithmetic to 20
// SIGNIFICANT digits by default, so subtracting zero from an exact
// `123.123456789012345678` already returns `123.12345678901234568`. Scaled `bigint`
// has no precision setting to get wrong.

/** `"12.5"` → `12500000000000000000n`. Unusable input scales to `0n`. */
export function scaleAmount(text: string): bigint {
  const negative = text.startsWith('-')
  const [int = '', frac = ''] = (negative ? text.slice(1) : text).split('.')
  if (int.length === 0 || !/^[0-9]*$/.test(int) || !/^[0-9]*$/.test(frac)) return 0n
  const scaled = BigInt(`${int}${frac.slice(0, MAX_AMOUNT_SCALE).padEnd(MAX_AMOUNT_SCALE, '0')}`)
  return negative ? -scaled : scaled
}

/** `12500000000000000000n` → `"12.5"`, canonical. Keeps a sign: a window delta is a
 *  subtraction, so it can be negative even though no reported amount ever is. */
export function unscaleAmount(scaled: bigint): DecimalAmount {
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(MAX_AMOUNT_SCALE + 1, '0')
  const int = digits.slice(0, digits.length - MAX_AMOUNT_SCALE)
  const frac = stripTrailingZeros(digits.slice(digits.length - MAX_AMOUNT_SCALE))
  return `${negative ? '-' : ''}${join(stripLeadingZeros(int), frac)}`
}

/** Add decimal amounts exactly. */
export function sumAmounts(amounts: Iterable<string>): DecimalAmount {
  let total = 0n
  for (const amount of amounts) total += scaleAmount(amount)
  return unscaleAmount(total)
}

/** A fixed-point decimal amount. The only money shape anything downstream of an
 *  ingress adapter handles — storage, aggregation, and every API response. */
export const DecimalAmount = z.string().refine((text) => canonicalizeDecimalAmount(text) !== null, {
  message: `expected an unsigned fixed-point decimal with at most ${MAX_AMOUNT_INTEGER_DIGITS} integer and ${MAX_AMOUNT_SCALE} fractional digits`
})
export type DecimalAmount = string

/** What a usage REPORT may carry: the canonical string, or a JSON number from a
 *  daemon that predates it. Adapters normalize; nothing else accepts the union. */
export const ReportedCostAmount = z.union([z.number(), DecimalAmount])
export type ReportedCostAmount = z.infer<typeof ReportedCostAmount>
