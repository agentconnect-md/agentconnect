/**
 * `amount.ts` — exact arithmetic on the decimal-string amounts the CP returns.
 *
 * Usage costs arrive as fixed-point decimal strings (the CP stores them as
 * `NUMERIC(38,18)` and never rounds), so the console must not re-add them as floats:
 * a runtime rollup of three agents' spend should equal the workspace total exactly,
 * not miss it by 1e-16 and render a different figure in two cards.
 *
 * Scaled `bigint` rather than a decimal library: one dependency-free primitive that
 * covers what the console actually does — add, then hand the result to a formatter.
 */

/** Fractional digits the CP's amount column carries. */
const SCALE = 18

/** `"12.5"` → `12500000000000000000n`. Unparseable input contributes nothing. */
function toScaled(text: string): bigint {
  const negative = text.startsWith('-')
  const [int = '', frac = ''] = (negative ? text.slice(1) : text).split('.')
  if (!/^[0-9]*$/.test(int) || !/^[0-9]*$/.test(frac)) return 0n
  const digits = `${int || '0'}${frac.slice(0, SCALE).padEnd(SCALE, '0')}`
  const scaled = BigInt(digits)
  return negative ? -scaled : scaled
}

/** `12500000000000000000n` → `"12.5"` (canonical: no trailing zeros). */
function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(SCALE + 1, '0')
  const int = digits.slice(0, digits.length - SCALE)
  const frac = digits.slice(digits.length - SCALE).replace(/0+$/, '')
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`
}

/** Add decimal-string amounts exactly. */
export function sumAmounts(amounts: Iterable<string>): string {
  let total = 0n
  for (const amount of amounts) total += toScaled(amount)
  return fromScaled(total)
}

/** An amount as a number, for pixel geometry and `Intl` formatting only — never to
 *  add two amounts together. */
export function amountToNumber(amount: string): number {
  const value = Number(amount)
  return Number.isFinite(value) ? value : 0
}
