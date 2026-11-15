'use client'

// Claims the hosted card page's return from the URL once, cleans it so a refresh does not replay it, then polls until the service answers.
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createBillingCardSetup, fetchBillingCardSetup } from '@/lib/billing-api'
import {
  CARD_POLL_INTERVAL_MS,
  afterCardSetupPoll,
  afterCardSetupPollError,
  claimCardSetupReturn,
  type CardSetupReturn
} from '@/lib/card-setup'

export function useCardSetupReturn({
  orgId,
  enabled,
  onSaved
}: {
  orgId: string | null
  /** False where billing is not offered: the URL is left alone and nothing is polled. */
  enabled: boolean
  /** The card is confirmed — refresh whatever reads the account. */
  onSaved?: () => void
}): { state: CardSetupReturn | null; dismiss: () => void; retry: () => void } {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [state, setState] = useState<CardSetupReturn | null>(null)
  const claimed = useRef(false)
  // Read through a ref so a caller's inline callback does not restart the poll timer.
  const saved = useRef(onSaved)
  saved.current = onSaved

  useEffect(() => {
    if (claimed.current || !enabled) return
    const claim = claimCardSetupReturn(searchParams)
    if (!claim) return
    claimed.current = true
    setState(claim)
    // Only this return's own parameters go: the page it landed on may carry others.
    const rest = new URLSearchParams(searchParams)
    rest.delete('cardSetup')
    rest.delete('setup')
    router.replace(rest.size > 0 ? `${pathname}?${rest}` : pathname)
  }, [enabled, searchParams, router, pathname])

  useEffect(() => {
    if (!orgId || state?.phase !== 'checking') return
    const { setupId, attempt } = state
    let cancelled = false
    const timer = setTimeout(
      async () => {
        try {
          const setup = await fetchBillingCardSetup(orgId, setupId)
          if (cancelled) return
          const next = afterCardSetupPoll(setupId, attempt, setup)
          setState(next)
          if (next.phase === 'saved') saved.current?.()
        } catch (e) {
          if (!cancelled) setState(afterCardSetupPollError(setupId, attempt, e))
        }
      },
      attempt === 1 ? 0 : CARD_POLL_INTERVAL_MS
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [orgId, state])

  const dismiss = useCallback(() => setState(null), [])
  const retry = useCallback(
    () =>
      setState((s) =>
        s && (s.phase === 'error' || s.phase === 'still-checking')
          ? { phase: 'checking', setupId: s.setupId, attempt: 1 }
          : s
      ),
    []
  )
  return { state, dismiss, retry }
}

/** Open the hosted card page. Resolves only on failure — success navigates away. */
export async function openCardSetup(orgId: string, returnPath: string): Promise<void> {
  const { url } = await createBillingCardSetup(orgId, { idempotencyKey: crypto.randomUUID(), returnPath })
  window.location.assign(url)
}
