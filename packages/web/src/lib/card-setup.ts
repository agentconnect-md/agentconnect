// The return from the hosted card page, as pure decisions — kept out of the hook and the views
// so the suite can pin them without rendering a 'use client' tree.
//
// `?cardSetup=success&setup=<id>` only means the browser came back: the card counts once the
// billing service reports the setup `completed`. A declined card never returns here (the hosted
// page keeps the user to retry), so the only "not saved" answers are a cancel and an expiry.
import { BillingError, BillingShapeError, type BillingCard, type BillingCardSetup } from '@/lib/billing-api'

export type CardSetupReturn =
  | { phase: 'checking'; setupId: string; attempt: number }
  | { phase: 'saved'; setup: BillingCardSetup }
  | { phase: 'not-saved' }
  | { phase: 'still-checking'; setupId: string }
  | { phase: 'error'; setupId: string; message: string }

/** 2.5s cadence, about a minute: a saved card confirms in seconds, and the page it lands on reads the account anyway. */
export const CARD_POLL_INTERVAL_MS = 2_500
export const CARD_POLL_MAX_ATTEMPTS = 24

/** What the return URL claims, or null when it carries no card return at all. */
export function claimCardSetupReturn(params: { get(name: string): string | null }): CardSetupReturn | null {
  const result = params.get('cardSetup')
  if (!result) return null
  const setupId = params.get('setup')
  if (result === 'success' && setupId) return { phase: 'checking', setupId, attempt: 1 }
  // A cancel, or a success with no id to check: neither can be confirmed, and nothing was charged either way.
  return { phase: 'not-saved' }
}

/** One poll's answer folded into the next state. */
export function afterCardSetupPoll(setupId: string, attempt: number, setup: BillingCardSetup): CardSetupReturn {
  if (setup.status === 'completed') return { phase: 'saved', setup }
  if (setup.status === 'expired') return { phase: 'not-saved' }
  if (attempt >= CARD_POLL_MAX_ATTEMPTS) return { phase: 'still-checking', setupId }
  return { phase: 'checking', setupId, attempt: attempt + 1 }
}

/** A failed poll: transient failures retry inside the budget, a refusal or an exhausted budget keeps the id for a manual retry. */
export function afterCardSetupPollError(setupId: string, attempt: number, error: unknown): CardSetupReturn {
  const permanent =
    error instanceof BillingShapeError || (error instanceof BillingError && error.status >= 400 && error.status < 500)
  if (!permanent && attempt < CARD_POLL_MAX_ATTEMPTS) return { phase: 'checking', setupId, attempt: attempt + 1 }
  return { phase: 'error', setupId, message: error instanceof Error ? error.message : String(error) }
}

/** How a saved card reads. `plain` covers every outcome with nothing to explain: the org already had its credit, the offer is off, or an outcome this build has not heard of. */
export type CardSavedKind = 'granted' | 'card_used' | 'plain'

export function cardSavedKind(promoOutcome: string | null): CardSavedKind {
  if (promoOutcome === 'granted' || promoOutcome === 'card_used') return promoOutcome
  return 'plain'
}

const BRAND_NAMES: Record<string, string> = {
  amex: 'American Express',
  cartes_bancaires: 'Cartes Bancaires',
  diners: 'Diners Club',
  discover: 'Discover',
  eftpos_au: 'eftpos',
  jcb: 'JCB',
  mastercard: 'Mastercard',
  unionpay: 'UnionPay',
  visa: 'Visa'
}

/** A network's display name; an unfamiliar slug renders as sent rather than as a guess. */
export function cardBrandName(brand: string): string {
  return BRAND_NAMES[brand] ?? brand
}

/** `MM/YY`, the way the card itself prints it. */
export function cardExpiry(card: Pick<BillingCard, 'expMonth' | 'expYear'>): string {
  return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear % 100).padStart(2, '0')}`
}
