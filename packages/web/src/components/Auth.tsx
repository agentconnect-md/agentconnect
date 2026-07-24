'use client'

import { useRouter } from 'next/navigation'
import { FcGoogle } from 'react-icons/fc'
import { SiGithub } from 'react-icons/si'
import { LogoMark, Wordmark } from '@/components/marks'
import { isAuthConfigured, login } from '@/lib/auth'

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
  const sso = (provider: 'github' | 'google') => (authOn ? void login(provider) : router.push('/'))

  return (
    <div className="authpage">
      <div className="authwin">
        <BrandPanel />
        <div className="form">
          <div className="form-inner">
            <h1 className="atitle">Sign in</h1>
            <p className="asub">Welcome back. Continue to your workspace.</p>
            <div className="mt-[26px] flex flex-col gap-[10px]">
              <button className="sso" onClick={() => sso('github')}>
                <SiGithub aria-hidden />
                Continue with GitHub
              </button>
              <button className="sso" onClick={() => sso('google')}>
                <FcGoogle aria-hidden />
                Continue with Google
              </button>
            </div>
            <p className="mt-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
              Single sign-on only. AgentConnect never stores a password.
              <br />
              First time here? Signing in creates your account.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
