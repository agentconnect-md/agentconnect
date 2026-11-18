'use client'

import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { LogoMark, Wordmark } from '@/components/marks'
import SocialLoginButtons from '@/components/SocialLoginButtons'
import { Button, Icon } from '@/components/ui'
import { ApiError, lookupSignIn } from '@/lib/api'
import { isAuthConfigured, login, loginWithSso } from '@/lib/auth'
import { EMAIL_RE, notePendingSignIn, readLastSignIn, type LastSignIn } from '@/lib/organization-sso'
import type { SocialLoginProvider, SocialLoginTarget } from '@/lib/social-login-providers'

function BrandPanel() {
  const t = useTranslations('Auth.login')

  return (
    <aside className="brand">
      <div className="brand-mark relative z-1 flex w-full items-center justify-between gap-4 self-start">
        <Wordmark height={36} inverse />
        <LanguageSwitcher
          className="[&_select]:border-0 [&_select]:bg-transparent [&_select]:text-white"
          showLabel={false}
        />
      </div>
      <div className="brand-lead relative z-1 mt-auto">
        <div className="font-sans text-[24px] font-semibold leading-[1.25] tracking-[-.02em]">{t('brandLead')}</div>
        <div className="brand-desc mt-[14px] max-w-[300px] font-sans text-[14px] font-normal leading-[1.6] text-(--text-inverse-dim)">
          {t('brandDescription')}
        </div>
      </div>
      <span className="facet">
        <LogoMark size={440} />
      </span>
    </aside>
  )
}

type LookupNotice = 'notFound' | 'tooMany' | 'failed'

/** The address field of a deployment whose organizations own their SSO connections: it routes by the address's domain. */
function EmailSignIn({ initialEmail }: { initialEmail: string }) {
  const t = useTranslations('Auth.login')
  const inputId = useId()
  const messageId = useId()
  const [email, setEmail] = useState(initialEmail)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<LookupNotice | null>(null)

  // The remembered address arrives after hydration; it never replaces one being typed.
  useEffect(() => {
    if (initialEmail) setEmail((current) => current || initialEmail)
  }, [initialEmail])

  const submit = async () => {
    const address = email.trim()
    if (busy || !EMAIL_RE.test(address)) return
    setBusy(true)
    setNotice(null)
    try {
      const connector = await lookupSignIn(address, AbortSignal.timeout(10_000))
      if (!connector) {
        setNotice('notFound')
        setBusy(false)
        return
      }
      notePendingSignIn({ method: 'email', email: address })
      // The page leaves for the identity provider; the button keeps its busy state until it does.
      await loginWithSso(connector.connectorId, address)
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 429 ? 'tooMany' : 'failed')
      setBusy(false)
    }
  }

  const failed = notice === 'tooMany' || notice === 'failed'

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label
        htmlFor={inputId}
        className="mb-[6px] block font-sans text-[13px] font-medium leading-normal text-(--text-primary)"
      >
        {t('email')}
      </label>
      <input
        id={inputId}
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        // Read-only, not disabled, while the lookup runs: a disabled field would drop the focus a retry needs.
        readOnly={busy}
        placeholder={t('emailPlaceholder')}
        aria-invalid={failed || undefined}
        aria-describedby={notice ? messageId : undefined}
        onChange={(event) => {
          setEmail(event.target.value)
          setNotice(null)
        }}
        className={`h-11 w-full rounded-md border bg-(--surface-card) px-3 font-sans text-[14px] font-normal leading-normal text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus:shadow-(--focus-shadow) read-only:bg-(--surface-sunken) read-only:text-(--text-tertiary) ${
          failed ? 'border-(--status-error)' : 'border-(--border-strong)'
        }`}
      />
      {notice && (
        <div
          id={messageId}
          role={failed ? 'alert' : 'status'}
          className={
            failed
              ? 'mt-[7px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)'
              : 'mt-[7px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)'
          }
        >
          {notice === 'notFound' ? t('notFound') : notice === 'tooMany' ? t('tooMany') : t('lookupFailed')}
        </div>
      )}
      <Button type="submit" disabled={busy} className="mt-3 h-11 w-full rounded-md text-[14px]">
        {busy && (
          <span
            aria-hidden="true"
            className="h-[14px] w-[14px] flex-none animate-spin rounded-full border-2 border-white/45 border-t-white"
          />
        )}
        {t('continue')}
      </Button>
    </form>
  )
}

export default function Auth({
  providers,
  sso,
  emailFirst = false
}: {
  providers: readonly SocialLoginProvider[]
  /** The deployment's SSO connector, offered ahead of the social buttons. */
  sso?: { connectorId: string; name: string }
  /** Organizations own their SSO connections: ask for an address first and route by its domain. */
  emailFirst?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('Auth.login')
  // Configured sign-in starts at Logto; no-auth deployments enter the app directly.
  const authOn = isAuthConfigured()
  const social = (provider: SocialLoginTarget) => {
    if (!authOn) return router.push('/')
    notePendingSignIn({ method: 'social', target: provider })
    void login(provider)
  }
  const signInWithSso = (connectorId: string) => (authOn ? void loginWithSso(connectorId) : router.push('/'))

  // Read after hydration: the server cannot know what this browser used last.
  const [last, setLast] = useState<LastSignIn | null>(null)
  useEffect(() => {
    if (emailFirst) setLast(readLastSignIn())
  }, [emailFirst])

  // The method used last goes first: an address is prefilled, a social button moves above the field.
  const lead = last?.method === 'social' ? providers.filter((provider) => provider.target === last.target) : []
  const rest = providers.filter((provider) => !lead.includes(provider))

  return (
    <div className="authpage">
      <div className="authwin">
        <BrandPanel />
        <div className="form">
          <div className="form-inner">
            <h1 className="atitle">{t('title')}</h1>
            <p className="asub">{t('subtitle')}</p>
            {emailFirst && authOn ? (
              <div className="mt-[26px]">
                {lead.length > 0 && (
                  <div className="mb-5 flex flex-col gap-[10px]">
                    <SocialLoginButtons providers={lead} onContinue={social} />
                  </div>
                )}
                <EmailSignIn initialEmail={last?.method === 'email' ? last.email : ''} />
                {rest.length > 0 && (
                  <>
                    <div className="my-5 h-px bg-(--border-subtle)" />
                    <div className="flex flex-col gap-[10px]">
                      <SocialLoginButtons providers={rest} onContinue={social} />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-[26px] flex flex-col gap-[10px]">
                {sso && (
                  <button type="button" className="sso" onClick={() => signInWithSso(sso.connectorId)}>
                    <span className="grid w-[220px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 text-left">
                      <span className="flex h-[18px] w-[18px] items-center justify-center">
                        <Icon name="key-round" size={18} />
                      </span>
                      <span className="whitespace-nowrap">{t('continueWith', { provider: sso.name })}</span>
                    </span>
                  </button>
                )}
                <SocialLoginButtons providers={providers} onContinue={social} />
              </div>
            )}
            <p className="mt-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
              {t('firstTime')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
