'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { completeLogin, currentSubject, isAuthConfigured, redirectExpiredSession } from '@/lib/auth'
import { takeFlowState } from '@/lib/flow-state'
import { promoteActivationProof } from '@/lib/activation-handshake'
import { Spinner } from '@/components/marks'
import { Button } from '@/components/ui'

// Complete the Logto sign-in before returning to the console or the stashed destination.
export default function AuthCallback() {
  const router = useRouter()
  const t = useTranslations('Auth.callback')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAuthConfigured()) {
      router.replace('/')
      return
    }
    completeLogin()
      .then(async () => {
        // Only a completed sign-in grants pending activation proof, bound to the signed-in subject.
        promoteActivationProof(await currentSubject())
        let dest = '/'
        // Read the same-origin return destination, including the cookie fallback for blocked sessionStorage.
        const stashed = takeFlowState('returnTo')
        if (stashed && stashed.startsWith('/') && !stashed.startsWith('//')) dest = stashed
        router.replace(dest)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('genericError')))
  }, [router, t])

  return (
    <div className="authpage">
      <div className="m-auto flex max-w-[640px] flex-col items-center gap-[18px] px-6 text-center font-sans text-[14px] font-normal leading-normal text-(--text-secondary)">
        {!error && <Spinner size={48} />}
        {error ? t('failed', { error }) : t('signingIn')}
        {error && <Button onClick={() => void redirectExpiredSession()}>{t('backToLogin')}</Button>}
      </div>
    </div>
  )
}
