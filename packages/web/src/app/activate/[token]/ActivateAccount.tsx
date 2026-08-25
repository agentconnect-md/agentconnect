'use client'

// The waitlist activation (join-link redemption) page (waitlist-and-login.md §6).
// Unlike join/[token], activation NEVER reuses whatever session the browser is
// already holding: it signs that session out and only redeems once the OIDC
// callback has proved a sign-in happened for THIS link (lib/activation-handshake).
// On success the user is a formal user — enter the console, which sends them on to
// org onboarding when they belong to none yet. Lives OUTSIDE the (app) route group
// so it never triggers the console's admission redirect before it can redeem.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { redeemWaitlistLink, ApiError } from '@/lib/api'
import { currentSubject, isAuthConfigured, resetSession } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'
import { abandonActivation, beginActivation, claimActivationProof } from '@/lib/activation-handshake'

const STORAGE_BLOCKED =
  'This browser is blocking the temporary storage this activation link needs, so it cannot ' +
  'verify who is signing in. Allow site data for this site (or use a regular, non-private ' +
  'window), then open the link again.'

export default function ActivateAccount({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  // Shown when the flow was refused before redeeming — the user can clear the
  // session by hand and re-open the link, which is the manual form of the reset
  // this page normally does for them.
  const [offerSignOut, setOfferSignOut] = useState(false)
  // The flow below is single-shot: it consumes the activation proof and can start a
  // sign-out. A second effect pass (React StrictMode remount) would restart the
  // handshake mid-sign-out and race the first.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false
    void (async () => {
      try {
        if (isAuthConfigured()) {
          // A residual console session belongs to whoever signed in last — possibly
          // a different account, or one an admin has since deleted. Redeeming under
          // it activates the wrong user, so redemption requires PROOF that this
          // browser signed in for this link, AS the identity signed in right now
          // (minted by the OIDC callback, never here). Without it: sign the old
          // session out and go get that proof.
          const subject = await currentSubject()
          if (!claimActivationProof(token, subject)) {
            // Both writes must stick or the round trip cannot be resumed, and
            // resuming is what keeps the redemption off the old session. Logto keeps
            // a completed session in localStorage while this state needs
            // sessionStorage/cookies, so "no scratch storage" and "already signed
            // in" can coexist — fail CLOSED rather than redeem as that user.
            if (!writeFlowState('returnTo', window.location.pathname) || !beginActivation(token)) {
              abandonActivation()
              if (!cancelled) {
                setError(STORAGE_BLOCKED)
                setOfferSignOut(true)
              }
              return
            }
            try {
              // 'redirecting' ⇒ the browser is leaving for Logto's end-session
              // endpoint and lands on /login; nothing left to do here.
              if ((await resetSession()) === 'redirecting') return
            } catch (e) {
              // The sign-out never happened (e.g. OIDC discovery unreachable). Drop
              // the intent so no later sign-in can be promoted into proof for this
              // link, and let a reload start the whole handshake over.
              abandonActivation()
              throw e
            }
            if (!cancelled) router.replace('/login')
            return
          }

          // Proof matched the identity signed in HERE, so `subject` is defined —
          // claimActivationProof rejects an undefined one. Assert it to the CP too:
          // a tab switching accounts between this check and the request would
          // otherwise redeem as that account (409 IDENTITY_CHANGED instead).
          await redeemWaitlistLink(token, subject)
          if (!cancelled) router.replace('/')
          return
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
            {offerSignOut ? (
              <Button variant="secondary" onClick={() => void resetSession()}>
                Sign out
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => router.replace('/waitlist')}>
                Back to waitlist
              </Button>
            )}
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
