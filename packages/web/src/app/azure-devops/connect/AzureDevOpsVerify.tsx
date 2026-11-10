'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { finishAzureDevOpsUserIdentity } from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'

const redemptions = new Map<string, Promise<void>>()

export default function AzureDevOpsVerify() {
  const t = useTranslations('Auth.azureDevOpsVerify')
  const [status, setStatus] = useState<'loading' | 'done' | 'failed'>('loading')
  const [error, setError] = useState('')
  const search = useRef<string | null>(null)
  useEffect(() => {
    search.current ??= window.location.search
    const query = new URLSearchParams(search.current)
    const state = query.get('state') ?? ''
    const code = query.get('code')
    const orgId = state.split('.')[1]
    let cancelled = false
    void (async () => {
      if (isAuthConfigured() && !(await getUser())) {
        writeFlowState('returnTo', window.location.pathname + window.location.search)
        await login()
        return
      }
      window.history.replaceState(null, '', window.location.pathname)
      if (!code || !orgId || query.has('error')) throw new Error(t('cancelled'))
      let pending = redemptions.get(state)
      if (!pending) {
        pending = finishAzureDevOpsUserIdentity(orgId, state, code)
        redemptions.set(state, pending)
        void pending.finally(() => redemptions.delete(state)).catch(() => undefined)
      }
      await pending
      if (cancelled) return
      setStatus('done')
      window.opener?.postMessage({ type: 'azure-devops-identity-verified' }, window.location.origin)
    })().catch((e: unknown) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('failed')
      }
    })
    return () => {
      cancelled = true
    }
  }, [t])
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-(--surface-app) p-6">
      <Wordmark />
      <h1 className="font-sans text-[20px] font-semibold leading-normal text-(--text-primary)">{t('title')}</h1>
      {status === 'loading' ? (
        <Spinner size={24} />
      ) : (
        <>
          <p className="font-sans text-[14px] font-normal leading-[1.5] text-(--text-secondary)">
            {status === 'done' ? t('done') : error}
          </p>
          <Button onClick={() => window.close()}>{t('close')}</Button>
        </>
      )}
    </main>
  )
}
