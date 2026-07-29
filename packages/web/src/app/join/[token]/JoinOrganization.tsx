'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { acceptOrgInviteLink, ApiError } from '@/lib/api'
import { getUser, isAuthConfigured } from '@/lib/auth'

export default function JoinOrganization({ token }: { token: string }) {
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

        const result = await acceptOrgInviteLink(token)
        if (!cancelled) router.replace(`/${encodeURIComponent(result.org.slug)}/home`)
      } catch (e) {
        if (cancelled) return
        setError(
          e instanceof ApiError && e.status === 410
            ? 'This invite link is expired, revoked, or has already been used by this account.'
            : e instanceof Error
              ? e.message
              : 'Could not join the organization.'
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
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">Invite unavailable</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{error}</p>
            </div>
            <Button variant="secondary" onClick={() => router.replace('/')}>
              Go to AgentConnect
            </Button>
          </>
        ) : (
          <>
            <Spinner size={42} />
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">Joining organization…</h1>
              <p className="mt-2 text-[13px] leading-normal text-(--text-secondary)">
                You&apos;ll join as a Collaborator.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
