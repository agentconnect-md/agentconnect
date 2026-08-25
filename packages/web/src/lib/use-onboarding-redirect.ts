'use client'

// Fresh-workspace redirect to the full-screen /onboarding route, shared by every
// console landing surface (Home is the default landing, Agents keeps it for deep
// links). The org's persisted `onboardingCompleted` flag decides: an OWNER of an
// org that has not finished (or skipped) the wizard is sent there; collaborators
// and viewers never are. The per-tab skip latch suppresses the bounce-back while
// the PATCH that marks the org onboarded is still propagating.
//
// Returns true while the caller should hold a spinner instead of rendering: either
// the redirect is in flight, or the sessionStorage latch hasn't been read yet
// (it's read in an effect — SSR can't touch sessionStorage).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useOrgs } from '@/lib/org-context'
import { isOnboardingSkipped, needsOnboarding } from '@/lib/onboarding'

export function useOnboardingRedirect(): boolean {
  const router = useRouter()
  const params = useParams()
  const orgKey = typeof params.slug === 'string' ? params.slug : '-'
  const { activeOrg, loading: orgsLoading, error: orgsError } = useOrgs()
  const [skipState, setSkipState] = useState<{ orgKey: string; skipped: boolean } | null>(null)
  const skipped = skipState?.orgKey === orgKey ? skipState.skipped : null
  useEffect(() => {
    setSkipState({ orgKey, skipped: isOnboardingSkipped(orgKey) })
  }, [orgKey])
  // Judge only a SUCCESSFULLY resolved org: a failed or unresolved org list must
  // not read as "not onboarded" and bounce the user into the wizard.
  const settled = !orgsLoading && orgsError == null && activeOrg != null
  const notInitialized = settled && needsOnboarding(activeOrg)
  const redirect = notInitialized && skipped === false
  useEffect(() => {
    if (redirect) router.replace(`/${orgKey}/onboarding`)
  }, [redirect, router, orgKey])
  return notInitialized && skipped !== true
}
