'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { LogoMark, Wordmark } from '@/components/marks'
import SocialLoginButtons from '@/components/SocialLoginButtons'
import { isAuthConfigured, login } from '@/lib/auth'
import { socialLoginProviders, type SocialLoginTarget } from '@/lib/social-login-providers'

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
        <div className="max-w-[300px] font-sans text-[27px] font-semibold leading-[1.25] tracking-[-.02em]">
          {t('brandLead')}
        </div>
        <div className="brand-desc mt-[14px] max-w-[300px] font-sans text-[14px] font-normal leading-[1.6] text-(--text-inverse-dim)">
          {t('brandDescription')}
        </div>
      </div>
      <div className="brand-foot mt-[30px]">
        <span className="dot h-2 w-2 rounded-full bg-(--status-online) shadow-[0_0_0_3px_rgba(21,166,97,.25)]" />
        <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-inverse-dim)">
          {t('brandFootnote')}
        </span>
      </div>
      <span className="facet">
        <LogoMark size={440} />
      </span>
    </aside>
  )
}

export default function Auth() {
  const router = useRouter()
  const t = useTranslations('Auth.login')
  // With an OIDC issuer configured, the SSO buttons start a real redirect; with
  // auth disabled (the OSS default) they just enter the app.
  const authOn = isAuthConfigured()
  const sso = (provider: SocialLoginTarget) => (authOn ? void login(provider) : router.push('/'))

  return (
    <div className="authpage">
      <div className="authwin">
        <BrandPanel />
        <div className="form">
          <div className="form-inner">
            <h1 className="atitle">{t('title')}</h1>
            <p className="asub">{t('subtitle')}</p>
            <div className="mt-[26px] flex flex-col gap-[10px]">
              <SocialLoginButtons providers={socialLoginProviders()} onContinue={sso} />
            </div>
            <p className="mt-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
              {t('ssoOnly')}
              <br />
              {t('firstTime')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
