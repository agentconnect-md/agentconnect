'use client'

// The waitlist activation (join-link redemption) page (waitlist-and-login.md §6).
// Mirrors join/[token]: ensure the user is signed in (Logto first if not), then
// POST /waitlist/redeem with the token. On success the user is a formal user with a
// personal org — enter the console. Lives OUTSIDE the (app) route group so it never
// triggers the console's admission redirect before it can redeem.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { redeemWaitlistLink, ApiError } from '@/lib/api'
import { getUser, isAuthConfigured } from '@/lib/auth'

export default function ActivateAccount({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (isAuthConfigured() && !(await getUser())) {
          try {
            sessionStorage.setItem('ac.returnTo', window.location.pathname)
          } catch {
            /* sessionStorage unavailable — sign-in will fall back to the console home */
          }
          router.replace('/login')
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
