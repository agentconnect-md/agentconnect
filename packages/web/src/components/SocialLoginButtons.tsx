'use client'

import { useState } from 'react'
import LarkFeishuSwitcher, { type LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'
import { SocialLoginMark } from '@/components/marks'
import type { SocialLoginProvider, SocialLoginTarget } from '@/lib/social-login-providers'

const isLarkOrFeishu = (
  provider: SocialLoginProvider
): provider is Extract<SocialLoginProvider, { target: LarkFeishuTarget }> =>
  provider.target === 'lark' || provider.target === 'feishu'

function ProviderContent({ provider }: { provider: SocialLoginProvider }) {
  return (
    <span className="grid w-[220px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 text-left">
      <span className="flex h-[18px] w-[18px] items-center justify-center">
        <SocialLoginMark target={provider.target} size={18} />
      </span>
      <span className="whitespace-nowrap">Continue with {provider.name}</span>
    </span>
  )
}

export default function SocialLoginButtons({
  providers,
  onContinue,
  darkTarget
}: {
  providers: readonly SocialLoginProvider[]
  onContinue: (target: SocialLoginTarget) => void
  darkTarget?: SocialLoginTarget
}) {
  const regionalProviders = providers.filter(isLarkOrFeishu)
  const firstRegionalProvider = regionalProviders[0]
  const [selectedRegionalTarget, setSelectedRegionalTarget] = useState<LarkFeishuTarget>('feishu')
  const selectedRegionalProvider =
    regionalProviders.find((provider) => provider.target === selectedRegionalTarget) ??
    regionalProviders.find((provider) => provider.target === 'feishu') ??
    firstRegionalProvider

  return providers.map((provider) => {
    if (isLarkOrFeishu(provider) && provider !== firstRegionalProvider) return null

    if (provider === firstRegionalProvider && selectedRegionalProvider && regionalProviders.length > 1) {
      return (
        <div key="lark-feishu" className="sso relative">
          <button
            type="button"
            aria-label={`Continue with ${selectedRegionalProvider.name}`}
            className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-inherit [font:inherit] focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-(--brand)"
            onClick={() => onContinue(selectedRegionalProvider.target)}
          />
          <span className="pointer-events-none relative z-[1] flex w-[220px] items-center text-left">
            <span className="flex h-[18px] w-[18px] flex-none items-center justify-center">
              <SocialLoginMark target={selectedRegionalProvider.target} size={18} />
            </span>
            <span className="ml-2.5">
              <LarkFeishuSwitcher
                value={selectedRegionalProvider.target}
                prefix="Continue with "
                variant="login"
                onSwitch={setSelectedRegionalTarget}
              />
            </span>
          </span>
        </div>
      )
    }

    return (
      <button
        key={provider.target}
        type="button"
        className={provider.target === darkTarget ? 'sso dark' : 'sso'}
        onClick={() => onContinue(provider.target)}
      >
        <ProviderContent provider={provider} />
      </button>
    )
  })
}
