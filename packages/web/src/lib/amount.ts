/**
 * `amount.ts` — the console's view of the decimal-string amounts the CP returns.
 *
 * Exact addition comes from the protocol package, so the console and the control plane
 * add money the same way: scaled integers, never a float and never a decimal library
 * whose arithmetic rounds to a significant-digit precision.
 */
import { scaleAmount, sumAmounts } from '@agentconnect.md/protocol/decimal-amount'

export { scaleAmount, sumAmounts }

// Descending exact order for two decimal-string amounts; a float cannot tell NUMERIC(38,18) neighbours apart.
export function byAmountDesc(a: string, b: string): number {
  const scaled = scaleAmount(a)
  const other = scaleAmount(b)
  return scaled === other ? 0 : scaled > other ? -1 : 1
}

/** An amount as a number, for pixel geometry and `Intl` formatting only — never to
 *  add two amounts together. */
export function amountToNumber(amount: string): number {
  const value = Number(amount)
  return Number.isFinite(value) ? value : 0
}
