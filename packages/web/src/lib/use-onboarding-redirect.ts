'use client'

// Fresh-workspace redirect to the full-screen /onboarding route, shared by every
// console landing surface (Home is the default landing, Agents keeps it for deep
// links). A fresh org = no placed agent AND no serving daemon of its OWN (pool Pods
// are install-wide, not this org's machine) AND no daemon in ANY of the caller's orgs
// (needsOnboarding); the per-tab "Explore the console first"
// skip flag suppresses the bounce-back.
//
// Returns true while the caller should hold a spinner instead of rendering: either
// the redirect is in flight, or the sessionStorage skip flag hasn't been read yet
// (it's read in an effect — SSR can't touch sessionStorage).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { agentIsPlaced, localDaemons } from '@/lib/data'
import { daemonCompletesOnboarding, isOnboardingSkipped, needsOnboarding } from '@/lib/onboarding'

export function useOnboardingRedirect(): boolean {
  const router = useRouter()
  const params = useParams()
  const orgKey = typeof params.slug === 'string' ? params.slug : '-'
  const { agents, daemons, agentsLoading, daemonsLoading, error } = useConsoleData()
  const { orgs, activeOrg, loading: orgsLoading, error: orgsError } = useOrgs()
  const [skipState, setSkipState] = useState<{ orgKey: string; skipped: boolean } | null>(null)
  const skipped = skipState?.orgKey === orgKey ? skipState.skipped : null
  useEffect(() => {
    setSkipState({ orgKey, skipped: isOnboardingSkipped(orgKey) })
  }, [orgKey])
  // Every request must have settled SUCCESSFULLY before judging the org fresh:
  // a failed or never-issued fetch (org list down, CP error, unresolved slug)
  // leaves empty rows with the loading flags false — that must not read as
  // "no agents, no daemons" and bounce the user into the wizard.
  const settled = !orgsLoading && orgsError == null && activeOrg != null && error == null
  const notInitialized =
    settled &&
    needsOnboarding(
      agentsLoading,
      daemonsLoading,
      agents.some(agentIsPlaced),
      // Pool Pods are not a machine this org connected, and on the pool the wizard is where
      // the built-in agent is configured — a hidden Pod must not mark the org initialized.
      localDaemons(daemons).some(daemonCompletesOnboarding),
      orgs.some((org) => (org.daemonCount ?? 0) > 0)
    )
  const redirect = notInitialized && skipped === false
  useEffect(() => {
    if (redirect) router.replace(`/${orgKey}/onboarding`)
  }, [redirect, router, orgKey])
  return notInitialized && skipped !== true
}
