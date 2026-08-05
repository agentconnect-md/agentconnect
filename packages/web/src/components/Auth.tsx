'use client'

import { useRouter } from 'next/navigation'
import { LogoMark, Wordmark } from '@/components/marks'
import SocialLoginButtons from '@/components/SocialLoginButtons'
import { Icon } from '@/components/ui'
import { isAuthConfigured, login, passwordLoginEnabled } from '@/lib/auth'
import { selectEnabledProviders, socialLoginProviders, type SocialLoginTarget } from '@/lib/social-login-providers'

function BrandPanel() {
  return (
    <aside className="brand">
      <div className="brand-mark self-start">
        <Wordmark height={36} inverse />
      </div>
      <div className="brand-lead relative z-1 mt-auto">
        <div className="max-w-[300px] font-sans text-[27px] font-semibold leading-[1.25] tracking-[-.02em]">
          Run your agents from the tools your team already lives in.
        </div>
        <div className="brand-desc mt-[14px] max-w-[300px] font-sans text-[14px] font-normal leading-[1.6] text-(--text-inverse-dim)">
          Slack, Telegram and Discord — driven by Claude and Codex, running on your own machines over ACP.
        </div>
      </div>
      <div className="brand-foot mt-[30px]">
        <span className="dot h-2 w-2 rounded-full bg-(--status-online) shadow-[0_0_0_3px_rgba(21,166,97,.25)]" />
        <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-inverse-dim)">
          Daemon-centric — your keys never leave your machines.
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
  // With an OIDC issuer configured, the SSO buttons start a real redirect; with
  // auth disabled (the OSS default) they just enter the app.
  const authOn = isAuthConfigured()
  const passwordOn = passwordLoginEnabled()
  // `SOCIAL_PROVIDERS=none` is only valid alongside the password entry — with
  // PASSWORD_LOGIN unset it would render a sign-in page with no way in at all,
  // so that misconfiguration falls back to the default social set (same
  // never-dead-end stance as the typo fallback in selectEnabledProviders).
  const configured = socialLoginProviders()
  const providers = configured.length === 0 && !passwordOn ? selectEnabledProviders(undefined) : configured
  const sso = (provider: SocialLoginTarget) => (authOn ? void login(provider) : router.push('/'))
  // Plain hosted-experience sign-in — Logto shows its local account form there.
  const passwordSignIn = () => (authOn ? void login() : router.push('/'))

  return (
    <div className="authpage">
      <div className="authwin">
        <BrandPanel />
        <div className="form">
          <div className="form-inner">
            <h1 className="atitle">Sign in</h1>
            <p className="asub">Welcome back. Continue to your workspace.</p>
            <div className="mt-[26px] flex flex-col gap-[10px]">
              <SocialLoginButtons providers={providers} onContinue={sso} />
              {passwordOn && (
                <button type="button" className="sso" onClick={passwordSignIn}>
                  <span className="grid w-[220px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 text-left">
                    <span className="flex h-[18px] w-[18px] items-center justify-center">
                      <Icon name="lock" size={18} />
                    </span>
                    <span className="whitespace-nowrap">Continue with password</span>
                  </span>
                </button>
              )}
            </div>
            <p className="mt-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
              {passwordOn
                ? 'Accounts live in your identity provider — AgentConnect never sees your password.'
                : 'Single sign-on only. AgentConnect never stores a password.'}
              <br />
              First time here? Signing in creates your account.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
