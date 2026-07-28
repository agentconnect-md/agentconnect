'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { completeLogin, isAuthConfigured } from '@/lib/auth'
import { takeFlowState } from '@/lib/flow-state'
import { promoteActivationProof } from '@/lib/activation-handshake'
import { Spinner } from '@/components/marks'

// Logto redirect landing page. Exchanges the authorization code (PKCE) for tokens
// via @logto/browser, then enters the console. Only reached when Logto is enabled;
// with auth disabled it just bounces home.
export default function AuthCallback() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAuthConfigured()) {
      router.replace('/')
      return
    }
    completeLogin()
      .then(() => {
        // A sign-in has now actually completed, which is the ONLY thing that turns a
        // pending activation into proof that this browser re-authenticated for that
        // link (see lib/activation-handshake). No pending activation ⇒ no-op.
        promoteActivationProof()
        // Return to a stashed same-origin destination (e.g. the OAuth consent page
        // that bounced the user through login), else the console home.
        let dest = '/'
        // takeFlowState also reads the cookie fallback, so a flow that had to resume
        // without sessionStorage (activation links) still lands where it started.
        const stashed = takeFlowState('returnTo')
        if (stashed && stashed.startsWith('/') && !stashed.startsWith('//')) dest = stashed
        router.replace(dest)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'sign-in failed'))
  }, [router])

  return (
    <div className="authpage">
      <div className="m-auto flex flex-col items-center gap-[18px] text-center font-sans text-[14px] font-normal leading-normal text-(--text-secondary)">
        {!error && <Spinner size={48} />}
        {error ? `Sign-in failed: ${error}` : 'Signing you in…'}
      </div>
    </div>
  )
}
