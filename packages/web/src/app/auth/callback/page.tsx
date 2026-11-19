'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  completeLogin,
  currentSubject,
  forgetRememberedOrganization,
  getUser,
  isAuthConfigured,
  redirectExpiredSession
} from '@/lib/auth'
import { takeFlowState } from '@/lib/flow-state'
import { promoteActivationProof } from '@/lib/activation-handshake'
import { ApiError, fetchOrgs, joinOrganizationsBySso, refreshMySocialIdentities, reportOrgSsoTest } from '@/lib/api'
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
      email: string | null
      error: string | null
      /** The Control Plane refused the account that landed: the provider gave it no address in the organization's domains. */
      refused: boolean
      /** Names of the attributes the provider sent with the refused account, to pick the address attribute from. */
      attributes: string[]
      /** Of those, the ones whose value is an address in the organization's verified domains. */
      addressAttributes: string[]
      returnTo: string
      /** False when the account that landed is not a member of the organization `returnTo` names. */
      canReturn: boolean
    }

// One landing per page load: the authorization code and a test nonce are each presented once, whatever re-runs the effect.
let landing: Promise<Landing> | undefined

// Every completed sign-in forgets the browser's remembered organization; the CP restores the account's own preference.
async function completeLoginForgettingOrganization(): Promise<void> {
  await completeLogin()
  forgetRememberedOrganization()
}

// Unknown when the list cannot be read: the console's own fallback still handles a non-member.
async function isMemberOf(returnTo: string): Promise<boolean> {
  const slug = decodeURIComponent(returnTo.split(/[/?#]/)[1] ?? '')
  const orgs = await fetchOrgs().catch(() => null)
  return orgs ? orgs.some((o) => o.slug === slug) : true
}

async function land(): Promise<Landing> {
  const params = new URLSearchParams(window.location.search)
  const providerError = params.get('error')

  // A test sign-in started from Settings lands here like any other; the stash tells them apart.
  const test = takeSsoTest()
  if (test) {
    const outcome = {
      kind: 'test' as const,
      returnTo: test.returnTo,
      refused: false,
      attributes: [] as string[],
      addressAttributes: [] as string[],
      canReturn: true
    }
    if (providerError) {
      const error = [providerError, params.get('error_description')].filter(Boolean).join(': ')
      return { ...outcome, passed: false, email: null, error }
    }
    try {
      await completeLoginForgettingOrganization()
    } catch (e) {
      return { ...outcome, passed: false, email: null, error: e instanceof Error ? e.message : null }
    }
    const canReturn = await isMemberOf(test.returnTo)
    try {
      const passed = await reportOrgSsoTest(test.nonce, AbortSignal.timeout(10_000))
      return { ...outcome, canReturn, passed, email: (await getUser())?.email ?? null, error: null }
    } catch (e) {
      const refused = e instanceof ApiError && e.code === 'SSO_ADDRESS_REQUIRED'
      const details = refused ? (e.details?.details as Record<string, unknown> | undefined) : undefined
      const names = (value: unknown) =>
        Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
      const attributes = names(details?.attributes)
      const addressAttributes = names(details?.addressAttributes).filter((name) => attributes.includes(name))
      return {
        ...outcome,
        canReturn,
        passed: false,
        email: null,
        error: e instanceof Error ? e.message : null,
        refused,
        attributes,
        addressAttributes
      }
    }
  }

  // Logto returns a cancelled or failed direct sign-in here as `access_denied`.
  if (providerError === 'access_denied') return { kind: 'cancelled' }
  try {
    await completeLoginForgettingOrganization()
    commitPendingSignIn()
    // Social sign-in can link an identity without passing through the Control Plane.
    await refreshMySocialIdentities(AbortSignal.timeout(5_000)).catch(() => undefined)
    // An address on a domain whose organization takes members by domain earns its membership before the console loads the list.
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
          result.email && (
            <div className="mono mt-2 break-all text-[12.5px] text-(--text-secondary)">{result.email}</div>
          )
        ) : (
          <div
            className="mono mt-[10px] rounded-sm bg-(--status-error-soft) px-[10px] py-2 text-[12px] break-words text-(--status-error)"
            role="alert"
          >
            {result.refused ? t('noAddress') : (result.error ?? t('unconfirmed'))}
          </div>
        )}
        {result.refused && result.attributes.length > 0 && (
          <div className="mt-[14px] w-full text-left">
            <div className="text-[12px] font-medium text-(--text-secondary)">{t('attributesSent')}</div>
            <ul className="mono mt-[6px] max-h-[180px] overflow-y-auto rounded-sm border border-(--border-default) px-[10px] py-2 text-[12px] break-all text-(--text-primary) select-text">
              {result.addressAttributes.map((name, i) => (
                <li key={`address-${i}-${name}`} className="flex items-start justify-between gap-2">
                  <span className="min-w-0">{name}</span>
                  <span className="badge shrink-0 bg-(--status-online-soft) font-sans text-(--status-online)">
                    {t('inDomainAddress')}
                  </span>
                </li>
              ))}
              {result.attributes
                .filter((name) => !result.addressAttributes.includes(name))
                .map((name, i) => (
                  <li key={`${i}-${name}`}>{name}</li>
                ))}
            </ul>
          </div>
        )}
        <Button
          className="mt-[22px] h-10 px-[18px]"
          onClick={() => router.replace(result.canReturn ? result.returnTo : '/')}
        >
          {t(result.canReturn ? 'backToSettings' : 'openConsole')}
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
