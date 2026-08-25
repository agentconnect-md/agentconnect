/**
 * `amount.ts` — the console's view of the decimal-string amounts the CP returns.
 *
 * Exact addition comes from the protocol package, so the console and the control plane
 * add money the same way: scaled integers, never a float and never a decimal library
 * whose arithmetic rounds to a significant-digit precision.
 */
export { sumAmounts } from '@agentconnect.md/protocol/decimal-amount'

/** An amount as a number, for pixel geometry and `Intl` formatting only — never to
 *  add two amounts together. */
export function amountToNumber(amount: string): number {
  const value = Number(amount)
  return Number.isFinite(value) ? value : 0
}
