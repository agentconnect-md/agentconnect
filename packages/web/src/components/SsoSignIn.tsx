'use client'

import { useEffect, useId, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AuthFrame, useLastSignIn } from '@/components/Auth'
import { Button } from '@/components/ui'
import { ApiError, lookupSignIn } from '@/lib/api'
import { loginWithSso } from '@/lib/auth'
import { clearSsoTest, EMAIL_RE, notePendingSignIn } from '@/lib/organization-sso'

type LookupNotice = 'noConnection' | 'tooMany' | 'failed'

const NOTICE = { noConnection: 'noSsoForEmail', tooMany: 'tooMany', failed: 'lookupFailed' } as const

/** The SSO page: an address routes to the connector its domain's organization owns. */
export default function SsoSignIn() {
  const t = useTranslations('Auth.login')
  const inputId = useId()
  const messageId = useId()
  const last = useLastSignIn(true)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<LookupNotice | null>(null)

  // The remembered address arrives after hydration; it never replaces one being typed.
  useEffect(() => {
    if (last?.method === 'email') setEmail((current) => current || last.email)
  }, [last])

  const submit = async () => {
    const address = email.trim()
    if (busy || !EMAIL_RE.test(address)) return
    setBusy(true)
    setNotice(null)
    try {
      const connector = await lookupSignIn(address, AbortSignal.timeout(10_000))
      if (!connector) {
        setNotice('noConnection')
        setBusy(false)
        return
      }
      notePendingSignIn({ method: 'email', email: address })
      // The page leaves for the identity provider; the button keeps its busy state until it does.
      clearSsoTest()
      await loginWithSso(connector.connectorId, address)
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 429 ? 'tooMany' : 'failed')
      setBusy(false)
    }
  }

  const failed = notice === 'tooMany' || notice === 'failed'

  return (
    <AuthFrame title={t('ssoTitle')} subtitle={t('ssoSubtitle')}>
      <form
        noValidate
        className="mt-[26px]"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label
          htmlFor={inputId}
          className="mb-[6px] block font-sans text-[13px] font-medium leading-normal text-(--text-primary)"
        >
          {t('workEmail')}
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
            {t(NOTICE[notice])}
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
      <p className="mt-5 text-center">
        <Link
          href="/login"
          className="font-sans text-[12.5px] font-medium leading-[1.6] text-(--text-link) no-underline hover:underline"
        >
          {t('otherOptions')}
        </Link>
      </p>
    </AuthFrame>
  )
}
