'use client'

// Fresh-workspace redirect to the full-screen /onboarding route, shared by every
// console landing surface (Home is the default landing, Agents keeps it for deep
// links). A fresh org = no placed agent AND no serving daemon (needsOnboarding);
// the per-tab "Explore the console first" skip flag suppresses the bounce-back.
//
// Returns true while the caller should hold a spinner instead of rendering: either
// the redirect is in flight, or the sessionStorage skip flag hasn't been read yet
// (it's read in an effect — SSR can't touch sessionStorage).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useConsoleData } from '@/lib/data-context'
import { agentIsPlaced } from '@/lib/data'
import { daemonCompletesOnboarding, isOnboardingSkipped, needsOnboarding } from '@/lib/onboarding'

export function useOnboardingRedirect(): boolean {
  const router = useRouter()
  const params = useParams()
  const orgKey = typeof params.slug === 'string' ? params.slug : '-'
  const { agents, daemons, agentsLoading, daemonsLoading } = useConsoleData()
  const [skipState, setSkipState] = useState<{ orgKey: string; skipped: boolean } | null>(null)
  const skipped = skipState?.orgKey === orgKey ? skipState.skipped : null
  useEffect(() => {
    setSkipState({ orgKey, skipped: isOnboardingSkipped(orgKey) })
  }, [orgKey])
  const notInitialized = needsOnboarding(
    agentsLoading,
    daemonsLoading,
    agents.some(agentIsPlaced),
    daemons.some(daemonCompletesOnboarding)
  )
  const redirect = notInitialized && skipped === false
  useEffect(() => {
    if (redirect) router.replace(`/${orgKey}/onboarding`)
  }, [redirect, router, orgKey])
  return notInitialized && skipped !== true
}
