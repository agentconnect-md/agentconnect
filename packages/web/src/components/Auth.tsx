'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { LogoMark, Wordmark } from '@/components/marks'
import SocialLoginButtons from '@/components/SocialLoginButtons'
import { Icon } from '@/components/ui'
import { isAuthConfigured, login, loginWithSso } from '@/lib/auth'
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

export default function Auth({
  providers,
  sso
}: {
  providers: readonly SocialLoginProvider[]
  /** The deployment's SSO connector, offered ahead of the social buttons. */
  sso?: { connectorId: string; name: string }
}) {
  const router = useRouter()
  const t = useTranslations('Auth.login')
  // Configured sign-in starts at Logto; no-auth deployments enter the app directly.
  const authOn = isAuthConfigured()
  const social = (provider: SocialLoginTarget) => (authOn ? void login(provider) : router.push('/'))
  const signInWithSso = (connectorId: string) => (authOn ? void loginWithSso(connectorId) : router.push('/'))

  return (
    <div className="authpage">
      <div className="authwin">
        <BrandPanel />
        <div className="form">
          <div className="form-inner">
            <h1 className="atitle">{t('title')}</h1>
            <p className="asub">{t('subtitle')}</p>
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
            <p className="mt-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
              {t('firstTime')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
