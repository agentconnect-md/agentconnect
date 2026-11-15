// The card return's decisions, pinned: what the URL may claim, when polling stops, and how each
// promo outcome reads. The views only render what these return.
import { describe, expect, it } from 'vitest'
import { BillingError, BillingShapeError, type BillingAccount, type BillingCardSetup } from './billing-api'
import { cloudCreditGate } from './billing-banner'
import {
  CARD_POLL_MAX_ATTEMPTS,
  afterCardSetupPoll,
  afterCardSetupPollError,
  cardBrandName,
  cardExpiry,
  cardSavedKind,
  claimCardSetupReturn
} from './card-setup'

const CARD = { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 }
const setup = (over: Partial<BillingCardSetup>): BillingCardSetup => ({
  id: 'cs_1',
  status: 'pending',
  promoOutcome: null,
  card: null,
  ...over
})

describe('claimCardSetupReturn', () => {
  it('claims nothing from a URL with no card return', () => {
    expect(claimCardSetupReturn(new URLSearchParams('checkout=success&purchase=p1'))).toBeNull()
  })

  it('treats success as something to CHECK, never as a saved card', () => {
    expect(claimCardSetupReturn(new URLSearchParams('cardSetup=success&setup=cs_1'))).toEqual({
      phase: 'checking',
      setupId: 'cs_1',
      attempt: 1
    })
  })

  it('reads a cancel, and a success with no id to check, as not saved', () => {
    expect(claimCardSetupReturn(new URLSearchParams('cardSetup=cancel&setup=cs_1'))).toEqual({ phase: 'not-saved' })
    expect(claimCardSetupReturn(new URLSearchParams('cardSetup=success'))).toEqual({ phase: 'not-saved' })
  })
})

describe('afterCardSetupPoll', () => {
  it('ends on a completed setup and carries its outcome', () => {
    const done = setup({ status: 'completed', promoOutcome: 'granted', card: CARD })
    expect(afterCardSetupPoll('cs_1', 1, done)).toEqual({ phase: 'saved', setup: done })
  })

  it('ends on an expired setup as not saved', () => {
    expect(afterCardSetupPoll('cs_1', 3, setup({ status: 'expired' }))).toEqual({ phase: 'not-saved' })
  })

  it('keeps polling a pending setup, then stops with the id kept', () => {
    expect(afterCardSetupPoll('cs_1', 1, setup({}))).toEqual({ phase: 'checking', setupId: 'cs_1', attempt: 2 })
    expect(afterCardSetupPoll('cs_1', CARD_POLL_MAX_ATTEMPTS, setup({}))).toEqual({
      phase: 'still-checking',
      setupId: 'cs_1'
    })
  })
})

describe('afterCardSetupPollError', () => {
  it('retries a transient failure inside the budget', () => {
    expect(afterCardSetupPollError('cs_1', 1, new BillingError('bad gateway', 502))).toEqual({
      phase: 'checking',
      setupId: 'cs_1',
      attempt: 2
    })
  })

  it('stops on a refusal, a shape mismatch, or an exhausted budget — keeping the id for a manual retry', () => {
    expect(afterCardSetupPollError('cs_1', 1, new BillingError('no such card setup', 404)).phase).toBe('error')
    expect(afterCardSetupPollError('cs_1', 1, new BillingShapeError('card setup')).phase).toBe('error')
    expect(afterCardSetupPollError('cs_1', CARD_POLL_MAX_ATTEMPTS, new BillingError('bad gateway', 502))).toEqual({
      phase: 'error',
      setupId: 'cs_1',
      message: 'bad gateway'
    })
  })
})

describe('cardSavedKind', () => {
  it('explains only the outcomes that have something to explain', () => {
    expect(cardSavedKind('granted')).toBe('granted')
    expect(cardSavedKind('card_used')).toBe('card_used')
  })

  it('reads an org that already had its credit, a switched-off offer, and an unknown outcome as a plain save', () => {
    expect(cardSavedKind('account_granted')).toBe('plain')
    expect(cardSavedKind('disabled')).toBe('plain')
    expect(cardSavedKind('something_new')).toBe('plain')
    expect(cardSavedKind(null)).toBe('plain')
  })
})

describe('card display', () => {
  it('names a known network and passes an unfamiliar one through as sent', () => {
    expect(cardBrandName('amex')).toBe('American Express')
    expect(cardBrandName('newnet')).toBe('newnet')
  })

  it('prints the expiry the way the card does', () => {
    expect(cardExpiry(CARD)).toBe('08/28')
  })
})

describe('cloudCreditGate', () => {
  const acct = (over: Partial<BillingAccount>): BillingAccount => ({
    orgId: 'org1',
    balanceMicro: 0,
    state: 'suspended',
    card: null,
    cardPromoAvailable: false,
    ...over
  })

  it('shows nothing while the gateway is serving, whatever the balance says', () => {
    expect(cloudCreditGate(acct({ state: 'active' }), true)).toBeNull()
    expect(cloudCreditGate(acct({ state: 'unknown' }), true)).toBeNull()
  })

  it('falls back to the balance only for a service too old to report a state', () => {
    expect(cloudCreditGate(acct({ state: undefined }), true)).toBe('add-credits')
    expect(cloudCreditGate(acct({ state: undefined, balanceMicro: 1 }), true)).toBeNull()
  })

  it('offers the card only while it can still earn credit and none is on file', () => {
    expect(cloudCreditGate(acct({ cardPromoAvailable: true }), true)).toBe('add-card')
    expect(cloudCreditGate(acct({ cardPromoAvailable: true, card: CARD }), true)).toBe('add-credits')
    // A service that predates cards sends neither field: nothing is promised.
    expect(cloudCreditGate({ orgId: 'org1', balanceMicro: 0, state: 'suspended' }, true)).toBe('add-credits')
  })

  it('sends a member to an owner, never to a form the service would refuse', () => {
    expect(cloudCreditGate(acct({ cardPromoAvailable: true }), false)).toBe('ask-owner')
  })
})
