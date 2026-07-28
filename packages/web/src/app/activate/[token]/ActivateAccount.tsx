'use client'

// The waitlist activation (join-link redemption) page (waitlist-and-login.md §6).
// Unlike join/[token], activation NEVER reuses whatever session the browser is
// already holding: it signs that session out first, then redeems under a freshly
// established identity (see FRESH_KEY below). On success the user is a formal user
// with a personal org — enter the console. Lives OUTSIDE the (app) route group so it
// never triggers the console's admission redirect before it can redeem.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { redeemWaitlistLink, ApiError } from '@/lib/api'
import { getUser, isAuthConfigured, resetSession } from '@/lib/auth'

// Per-tab marker: "the session in this tab was established for THIS activation
// token". Set before signing the old session out, so the post-sign-in return trip
// redeems instead of logging out again (an unmarked visit always logs out first).
const FRESH_KEY = 'ac.activate.fresh'

/** Stash the marker, confirming it stuck — sessionStorage can be unavailable
 *  (private modes, blocked storage), and an unreadable marker would loop. */
function markFresh(token: string): boolean {
  try {
    sessionStorage.setItem(FRESH_KEY, token)
    return sessionStorage.getItem(FRESH_KEY) === token
  } catch {
    return false
  }
}

function takeFresh(): string | null {
  try {
    const v = sessionStorage.getItem(FRESH_KEY)
    sessionStorage.removeItem(FRESH_KEY)
    return v
  } catch {
    return null
  }
}

function stashReturnTo(): void {
  try {
    sessionStorage.setItem('ac.returnTo', window.location.pathname)
  } catch {
    /* sessionStorage unavailable — sign-in will fall back to the console home */
  }
}

export default function ActivateAccount({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  // The flow below is single-shot: it consumes the freshness marker and can start a
  // sign-out. A second effect pass (React StrictMode remount) would see its own
  // marker and redeem under the very session we are trying to discard.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false
    void (async () => {
      try {
        if (isAuthConfigured()) {
          // A residual console session belongs to whoever signed in last — possibly
          // a different account, or one an admin has since deleted (whose stale
          // identity the CP still resolves). Redeeming under it activates the wrong
          // user or fails outright, so always start from a clean slate: sign out,
          // then come back through a real sign-in for this link.
          if (takeFresh() !== token) {
            stashReturnTo()
            if (markFresh(token)) {
              // 'redirecting' ⇒ the browser is leaving for Logto's end-session
              // endpoint and lands on /login; nothing left to do here.
              if ((await resetSession()) === 'redirecting') return
              if (!cancelled) router.replace('/login')
              return
            }
            // No usable sessionStorage ⇒ a forced sign-out could not be resumed
            // reliably. Fall through and use whatever session exists rather than
            // strand the link in a sign-out loop.
          }

          if (!(await getUser())) {
            stashReturnTo()
            if (!cancelled) router.replace('/login')
            return
          }
        }

        await redeemWaitlistLink(token)
        if (!cancelled) router.replace('/')
      } catch (e) {
        if (cancelled) return
        // 403 = the link was issued for a different email (the CP message names it);
        // 410 = expired / revoked / already redeemed by someone else.
        setError(
          e instanceof ApiError && (e.status === 403 || e.status === 410)
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Could not activate your account.'
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router, token])

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[430px] flex-col items-center gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 text-center font-sans shadow-(--shadow-lg)">
        <Wordmark height={30} />
        {error ? (
          <>
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-error-soft)">
              <Icon name="link-2-off" size={22} color="var(--status-error)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">Activation unavailable</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{error}</p>
            </div>
            <Button variant="secondary" onClick={() => router.replace('/waitlist')}>
              Back to waitlist
            </Button>
          </>
        ) : (
          <>
            <Spinner size={42} />
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">
                Activating your account…
              </h1>
              <p className="mt-2 text-[13px] leading-normal text-(--text-secondary)">This only takes a moment.</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
