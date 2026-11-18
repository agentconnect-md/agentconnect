'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { completeLogin, currentSubject, getUser, isAuthConfigured, redirectExpiredSession } from '@/lib/auth'
import { takeFlowState } from '@/lib/flow-state'
import { promoteActivationProof } from '@/lib/activation-handshake'
import { ApiError, joinOrganizationsBySso, refreshMySocialIdentities, reportOrgSsoTest } from '@/lib/api'
import { commitPendingSignIn, organizationSsoEnabled, takeSsoTest } from '@/lib/organization-sso'
import { Spinner, Wordmark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type Landing =
  | { kind: 'go'; to: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string | null }
  | {
      kind: 'test'
      passed: boolean
      connectionName: string
      email: string | null
      error: string | null
      /** The Control Plane refused the account that landed: the provider gave it no address in the organization's domains. */
      refused: boolean
      returnTo: string
    }

// One landing per page load: the authorization code and a test nonce are each presented once, whatever re-runs the effect.
let landing: Promise<Landing> | undefined

async function land(): Promise<Landing> {
  const params = new URLSearchParams(window.location.search)
  const providerError = params.get('error')

  // A test sign-in started from Settings lands here like any other; the stash tells them apart.
  const test = takeSsoTest()
  if (test) {
    const outcome = {
      kind: 'test' as const,
      connectionName: test.connectionName,
      returnTo: test.returnTo,
      refused: false
    }
    if (providerError) {
      const error = [providerError, params.get('error_description')].filter(Boolean).join(': ')
      return { ...outcome, passed: false, email: null, error }
    }
    try {
      await completeLogin()
      const passed = await reportOrgSsoTest(test.nonce, AbortSignal.timeout(10_000))
      return { ...outcome, passed, email: (await getUser())?.email ?? null, error: null }
    } catch (e) {
      const refused = e instanceof ApiError && e.code === 'SIGN_IN_IDENTITY_REQUIRED'
      return { ...outcome, passed: false, email: null, error: e instanceof Error ? e.message : null, refused }
    }
  }

  // Logto returns a cancelled or failed direct sign-in here as `access_denied`.
  if (providerError === 'access_denied') return { kind: 'cancelled' }
  try {
    await completeLogin()
    commitPendingSignIn()
    // Social sign-in can link an identity without passing through the Control Plane.
    await refreshMySocialIdentities(AbortSignal.timeout(5_000)).catch(() => undefined)
    // A first sign-in through an organization's connection earns its membership before the console loads the list.
    if (organizationSsoEnabled()) await joinOrganizationsBySso(AbortSignal.timeout(5_000)).catch(() => undefined)
    // Only a completed sign-in grants pending activation proof, bound to the signed-in subject.
    promoteActivationProof(await currentSubject())
    // Read the same-origin return destination, including the cookie fallback for blocked sessionStorage.
    const stashed = takeFlowState('returnTo')
    return { kind: 'go', to: stashed && stashed.startsWith('/') && !stashed.startsWith('//') ? stashed : '/' }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : null }
  }
}

function SsoTestResult({ result }: { result: Extract<Landing, { kind: 'test' }> }) {
  const router = useRouter()
  const t = useTranslations('Auth.ssoTest')
  return (
    <div className="m-auto flex w-full max-w-[420px] flex-col items-center px-4 text-center font-sans">
      <Wordmark height={24} />
      <div className="mt-[26px] flex w-full flex-col items-center rounded-[14px] border border-(--border-default) bg-(--surface-card) px-[30px] py-[34px] shadow-(--shadow-xs)">
        {result.passed ? (
          <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-(--status-online-soft)">
            <Icon name="check" size={22} color="var(--status-online)" />
          </span>
        ) : (
          <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-(--status-error-soft)">
            <Icon name="x" size={22} color="var(--status-error)" />
          </span>
        )}
        <h1 className="mt-4 text-[20px] font-semibold leading-[1.2] tracking-[-.02em] text-(--text-primary)">
          {result.passed ? t('passed') : t('failed')}
        </h1>
        {result.passed ? (
          <div className="mono mt-2 break-all text-[12.5px] text-(--text-secondary)">
            {[result.connectionName, result.email].filter(Boolean).join(' · ')}
          </div>
        ) : (
          <div
            className="mono mt-[10px] rounded-sm bg-(--status-error-soft) px-[10px] py-2 text-[12px] break-words text-(--status-error)"
            role="alert"
          >
            {result.refused
              ? t('noAddress', { name: result.connectionName })
              : (result.error ?? t('unconfirmed', { name: result.connectionName }))}
          </div>
        )}
        <Button className="mt-[22px] h-10 px-[18px]" onClick={() => router.replace(result.returnTo)}>
          {t('backToSettings')}
        </Button>
      </div>
    </div>
  )
}

// Complete the Logto sign-in before returning to the console or the stashed destination.
export default function AuthCallback() {
  const router = useRouter()
  const t = useTranslations('Auth.callback')
  const [result, setResult] = useState<Exclude<Landing, { kind: 'go' }> | null>(null)

  useEffect(() => {
    if (!isAuthConfigured()) {
      router.replace('/')
      return
    }
    let cancelled = false
    void (landing ??= land()).then((outcome) => {
      if (cancelled) return
      if (outcome.kind === 'go') router.replace(outcome.to)
      else setResult(outcome)
    })
    return () => {
      cancelled = true
    }
  }, [router])

  if (result?.kind === 'test') {
    return (
      <div className="authpage">
        <SsoTestResult result={result} />
      </div>
    )
  }

  const error =
    result?.kind === 'cancelled'
      ? t('cancelled')
      : result?.kind === 'failed'
        ? t('failed', { error: result.error ?? t('genericError') })
        : null

  return (
    <div className="authpage">
      <div className="m-auto flex max-w-[640px] flex-col items-center gap-[18px] px-6 text-center font-sans text-[14px] font-normal leading-normal text-(--text-secondary)">
        {!error && <Spinner size={48} />}
        {error ?? t('signingIn')}
        {error && <Button onClick={() => void redirectExpiredSession()}>{t('backToLogin')}</Button>}
      </div>
    </div>
  )
}
