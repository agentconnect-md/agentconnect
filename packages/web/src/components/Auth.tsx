'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { LogoMark, Wordmark } from '@/components/marks'
import SocialLoginButtons, { LastUsedTag } from '@/components/SocialLoginButtons'
import { Icon } from '@/components/ui'
import { isAuthConfigured, login, loginWithSso } from '@/lib/auth'
import { clearSsoTest, notePendingSignIn, readLastSignIn, type LastSignIn } from '@/lib/organization-sso'
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

/** The two-panel frame the sign-in pages share. */
export function AuthFrame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="authpage">
      <div className="authwin">
        <BrandPanel />
        <div className="form">
          <div className="form-inner">
            <h1 className="atitle">{title}</h1>
            <p className="asub">{subtitle}</p>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The method this browser signed in with last; read after hydration, since the server cannot know it. */
export function useLastSignIn(enabled: boolean): LastSignIn | null {
  const [last, setLast] = useState<LastSignIn | null>(null)
  useEffect(() => {
    if (enabled) setLast(readLastSignIn())
  }, [enabled])
  return last
}

function KeyContent({ label }: { label: string }) {
  return (
    <span className="grid w-[220px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 text-left">
      <span className="flex h-[18px] w-[18px] items-center justify-center">
        <Icon name="key-round" size={18} />
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </span>
  )
}

export default function Auth({
  providers,
  sso,
  organizationSso = false
}: {
  providers: readonly SocialLoginProvider[]
  /** The deployment's SSO connector, offered ahead of the social buttons. */
  sso?: { connectorId: string; name: string }
  /** Organizations own their SSO connections: a "Continue with SSO" bar leads to the SSO page. */
  organizationSso?: boolean
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
  const signInWithSso = (connectorId: string) => {
    if (!authOn) return router.push('/')
    notePendingSignIn({ method: 'sso', connectorId })
    clearSsoTest()
    void loginWithSso(connectorId)
  }
  const withSsoPage = organizationSso && authOn
  const last = useLastSignIn(authOn)

  return (
    <AuthFrame title={t('title')} subtitle={t('subtitle')}>
      {withSsoPage ? (
        <div className="mt-[26px] flex flex-col gap-[10px]">
          <SocialLoginButtons
            providers={providers}
            onContinue={social}
            bars={3}
            variant="labeled"
            {...(last?.method === 'social' ? { lastUsed: last.target } : {})}
            trailing={
              <Link href="/login/sso" className="sso relative no-underline">
                {last?.method === 'email' && <LastUsedTag />}
                <KeyContent label={t('continueWithSso')} />
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-[26px] flex flex-col gap-[10px]">
          {sso && (
            <button type="button" className="sso relative" onClick={() => signInWithSso(sso.connectorId)}>
              {last?.method === 'sso' && last.connectorId === sso.connectorId && <LastUsedTag />}
              <KeyContent label={t('continueWith', { provider: sso.name })} />
            </button>
          )}
          <SocialLoginButtons
            providers={providers}
            onContinue={social}
            {...(last?.method === 'social' ? { lastUsed: last.target } : {})}
          />
        </div>
      )}
      <p className="mt-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
        {t('firstTime')}
      </p>
    </AuthFrame>
  )
}
