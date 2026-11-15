'use client'

// The org's saved card: the Payment method card, the shared Add card dialog, and the banner that
// reports a return from the hosted card page. Nothing here names an amount — whether free credit
// is on offer is the service's `cardPromoAvailable`, and what it added shows on the balance.

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { removeBillingCard, type BillingAccount, type BillingCard } from '@/lib/billing-api'
import { cardBrandName, cardExpiry, cardSavedKind, type CardSetupReturn } from '@/lib/card-setup'
import { openCardSetup } from '@/lib/use-card-setup-return'
import { Button, Icon } from '@/components/ui'

function Fact({ icon, brand, title, body }: { icon: string; brand?: boolean; title: string; body: string }) {
  return (
    <div className="flex gap-3 border-b border-(--border-subtle) px-4 py-3.5 last:border-b-0">
      <span
        className={
          brand
            ? 'flex h-[30px] w-[30px] flex-none items-center justify-center rounded-md bg-(--brand-soft) text-(--brand)'
            : 'flex h-[30px] w-[30px] flex-none items-center justify-center rounded-md bg-(--surface-sunken) text-(--text-secondary)'
        }
      >
        <Icon name={icon} size={16} />
      </span>
      <div className="min-w-0">
        <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">{title}</div>
        <div className="mt-0.5 font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">{body}</div>
      </div>
    </div>
  )
}

/** What saving a card means, shared by the dialog and the onboarding step. The free-credit row shows only while the org can still get it. */
export function CardFacts({ orgName, promoAvailable }: { orgName: string; promoAvailable: boolean }) {
  const t = useTranslations('Billing.card.facts')
  return (
    <div className="rounded-[10px] border border-(--border-subtle) bg-(--surface-card)">
      {promoAvailable && <Fact icon="gift" brand title={t('creditTitle')} body={t('creditBody', { org: orgName })} />}
      <Fact icon="receipt" title={t('noChargeTitle')} body={t('noChargeBody')} />
      <Fact icon="lock" title={t('securedTitle')} body={t('securedBody')} />
    </div>
  )
}

/** One saved card as a row: a neutral card glyph, the network's name and last four. */
export function CardLine({ card, sub, children }: { card: BillingCard; sub?: ReactNode; children?: ReactNode }) {
  const t = useTranslations('Billing.card')
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex h-[30px] w-[42px] flex-none items-center justify-center rounded-sm border border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)">
        <Icon name="credit-card" size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13.5px] font-semibold leading-normal">
          {t('ending', { brand: cardBrandName(card.brand), last4: card.last4 })}
        </div>
        <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {sub ?? <span className="mono">{t('expires', { date: cardExpiry(card) })}</span>}
        </div>
      </div>
      {children}
    </div>
  )
}

/** The one dialog every Add card and Replace opens: it explains, then hands off to the hosted page. */
export function AddCardDialog({
  orgId,
  orgName,
  returnPath,
  promoAvailable,
  replacing,
  onClose
}: {
  orgId: string
  orgName: string
  returnPath: string
  promoAvailable: boolean
  /** A card is already on file: the new one takes over once it is confirmed. */
  replacing: boolean
  onClose: () => void
}) {
  const t = useTranslations('Billing.card.dialog')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      await openCardSetup(orgId, returnPath)
      // `opening` stays true — the page is navigating away.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setOpening(false)
    }
  }

  const title = replacing ? t('replaceTitle') : t('title')
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal max-w-[500px]" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{title}</span>
          <button className="iconbtn" onClick={onClose} aria-label={t('cancel')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="m-0 mb-3.5 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {replacing ? t('replaceBody') : t('body')}
          </p>
          <CardFacts orgName={orgName} promoAvailable={promoAvailable} />
          {error && (
            <div className="mt-2.5 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{error}</div>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={opening} onClick={() => void submit()}>
            {opening ? t('opening') : replacing ? t('replaceTitle') : t('addCard')}
            <Icon name="arrow-up-right" size={15} />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Payment method, beside the balance. Owners manage the card; members see what is on file and nothing to press. */
export function PaymentMethodCard({
  orgId,
  acct,
  canManage,
  onAddCard,
  onRemoved
}: {
  orgId: string
  acct: BillingAccount
  canManage: boolean
  onAddCard: () => void
  onRemoved: () => void
}) {
  const t = useTranslations('Billing.card')
  const [removing, setRemoving] = useState(false)
  const [removeFailed, setRemoveFailed] = useState(false)
  // Absent ⇒ a service that predates cards: there is nothing true to say about one.
  if (acct.card === undefined) return null
  const card = acct.card
  const offer = acct.cardPromoAvailable === true

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    setRemoveFailed(false)
    try {
      await removeBillingCard(orgId)
      onRemoved()
    } catch {
      // The service detaches first and changes nothing on failure, so the card is still on file.
      setRemoveFailed(true)
    }
    setRemoving(false)
  }

  return (
    <div className="card mb-[18px]">
      <div className="cardhead">
        <span className="cardtitle">{t('title')}</span>
      </div>
      <div className="px-[18px] py-4">
        {card ? (
          <>
            <CardLine card={card} sub={canManage ? undefined : t('ownersOnly')}>
              {canManage && (
                <>
                  <Button size="sm" variant="secondary" onClick={onAddCard}>
                    {t('replace')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={removing} onClick={() => void remove()}>
                    {removing ? t('removing') : t('remove')}
                  </Button>
                </>
              )}
            </CardLine>
            {removeFailed && (
              <div
                role="alert"
                className="mt-3 flex items-center gap-2 rounded-md bg-(--status-error-soft) px-2.5 py-2 font-sans text-[12.5px] font-normal leading-normal"
              >
                <Icon name="triangle-exclamation-point" size={14} color="var(--status-error)" />
                {t('removeError')}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={
                offer && canManage
                  ? 'flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-(--brand-soft) text-(--brand)'
                  : 'flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-(--surface-sunken) text-(--text-secondary)'
              }
            >
              <Icon name={offer && canManage ? 'gift' : 'credit-card'} size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-sans text-[13.5px] font-semibold leading-normal">
                {offer && canManage ? t('offerTitle') : t('emptyTitle')}
              </div>
              {canManage && (
                <div className="mt-[3px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
                  {offer ? t('offerBody') : t('emptyBody')}
                </div>
              )}
            </div>
            {canManage && (
              <Button size="sm" variant={offer ? 'primary' : 'secondary'} onClick={onAddCard}>
                <Icon name="plus" size={14} />
                {t('addCard')}
              </Button>
            )}
          </div>
        )}
      </div>
      {canManage && (
        <div className="flex gap-2 border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="lock" size={13} />
          {card ? t('prefillNote') : t('hostedNote')}
        </div>
      )}
    </div>
  )
}

// Complete literal class strings per tone — Tailwind's scanner only sees whole literals.
const RETURN_TONE = {
  info: { card: 'border-(--status-info) bg-(--status-info-soft)', glyph: 'text-(--status-info)' },
  ok: { card: 'border-(--status-online) bg-(--status-online-soft)', glyph: 'text-(--status-online)' },
  neutral: { card: 'border-(--border-strong) bg-(--surface-sunken)', glyph: 'text-(--text-secondary)' },
  error: { card: 'border-(--status-error) bg-(--status-error-soft)', glyph: 'text-(--status-error)' }
} as const

/** What a return from the hosted card page says, and the one next step each answer has. */
export function cardReturnCopy(
  state: CardSetupReturn,
  t: (key: string, values?: Record<string, string>) => string,
  orgName: string
): { tone: keyof typeof RETURN_TONE; icon: string; title: string; body: string } {
  switch (state.phase) {
    case 'checking':
      return { tone: 'info', icon: 'loader-circle', title: t('checkingTitle'), body: t('checkingBody') }
    case 'still-checking':
      return { tone: 'info', icon: 'clock', title: t('stillCheckingTitle'), body: t('stillCheckingBody') }
    case 'not-saved':
      return { tone: 'neutral', icon: 'undo-2', title: t('notSavedTitle'), body: t('notSavedBody') }
    case 'error':
      return {
        tone: 'error',
        icon: 'triangle-exclamation-point',
        title: t('errorTitle'),
        body: t('errorBody', { message: state.message })
      }
    case 'saved':
      switch (cardSavedKind(state.setup.promoOutcome)) {
        case 'granted':
          return { tone: 'ok', icon: 'check', title: t('savedTitle'), body: t('grantedBody', { org: orgName }) }
        case 'card_used':
          return { tone: 'neutral', icon: 'info', title: t('savedTitle'), body: t('cardUsedBody') }
        case 'wallet':
          return { tone: 'neutral', icon: 'info', title: t('savedTitle'), body: t('walletBody') }
        case 'plain':
          return { tone: 'ok', icon: 'check', title: t('savedTitle'), body: t('plainBody') }
      }
  }
}

export function CardReturnBanner({
  state,
  orgName,
  canManage,
  outOfCredit,
  onEnterCardNumber,
  onAddCredits,
  onRetry,
  onDismiss
}: {
  state: CardSetupReturn
  orgName: string
  canManage: boolean
  /** No credit after a card that earned none: the next step is paying for some. */
  outOfCredit: boolean
  onEnterCardNumber: () => void
  onAddCredits: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const rawT = useTranslations('Billing.card.result')
  const t = rawT as unknown as (key: string, values?: Record<string, string>) => string
  const copy = cardReturnCopy(state, t, orgName)
  const tone = RETURN_TONE[copy.tone]
  const kind = state.phase === 'saved' ? cardSavedKind(state.setup.promoOutcome) : null
  const busy = state.phase === 'checking'
  return (
    <div role="status" className={`mb-4 flex items-start gap-3 rounded-[10px] border px-4 py-3.5 ${tone.card}`}>
      <span className={`mt-[1px] flex-none ${tone.glyph}`}>
        <Icon name={copy.icon} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13.5px] font-semibold leading-normal">{copy.title}</div>
        <div className="mt-[3px] max-w-[720px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {copy.body}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
          {kind === 'wallet' && canManage && (
            <Button size="xs" onClick={onEnterCardNumber}>
              {t('enterCardNumber')}
            </Button>
          )}
          {(kind === 'wallet' || kind === 'card_used') && outOfCredit && canManage && (
            <Button size="xs" variant="secondary" onClick={onAddCredits}>
              {t('addCredits')}
            </Button>
          )}
          {(state.phase === 'error' || state.phase === 'still-checking') && (
            <Button size="xs" variant="secondary" onClick={onRetry}>
              {t('checkAgain')}
            </Button>
          )}
        </div>
      </div>
      {!busy && (
        <Button size="xs" variant="ghost" onClick={onDismiss} ariaLabel={t('dismiss')}>
          <Icon name="x" size={14} />
        </Button>
      )}
    </div>
  )
}
