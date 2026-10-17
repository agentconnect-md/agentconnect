'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import LarkFeishuSwitcher, { type LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'
import { SocialLoginMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import type { SocialLoginProvider, SocialLoginTarget } from '@/lib/social-login-providers'

const isLarkOrFeishu = (
  provider: SocialLoginProvider
): provider is Extract<SocialLoginProvider, { target: LarkFeishuTarget }> =>
  provider.target === 'lark' || provider.target === 'feishu'

// Shown up front; every other enabled provider waits behind "More sign-in options".
const PRIMARY_TARGETS = new Set<SocialLoginTarget>(['github', 'google', 'slack', 'lark', 'feishu'])

function ProviderContent({ provider }: { provider: SocialLoginProvider }) {
  const t = useTranslations('Auth.login')

  return (
    <span className="grid w-[220px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 text-left">
      <span className="flex h-[18px] w-[18px] items-center justify-center">
        <SocialLoginMark target={provider.target} size={18} />
      </span>
      <span className="whitespace-nowrap">{t('continueWith', { provider: provider.name })}</span>
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
  const t = useTranslations('Auth.login')
  const regionalProviders = providers.filter(isLarkOrFeishu)
  const firstRegionalProvider = regionalProviders[0]
  const [selectedRegionalTarget, setSelectedRegionalTarget] = useState<LarkFeishuTarget>(
    firstRegionalProvider?.target ?? 'lark'
  )
  const [showMore, setShowMore] = useState(false)
  const selectedRegionalProvider =
    regionalProviders.find((provider) => provider.target === selectedRegionalTarget) ?? firstRegionalProvider

  const renderProvider = (provider: SocialLoginProvider) => {
    if (isLarkOrFeishu(provider) && provider !== firstRegionalProvider) return null

    if (provider === firstRegionalProvider && selectedRegionalProvider && regionalProviders.length > 1) {
      return (
        <div key="lark-feishu" className="sso relative">
          <button
            type="button"
            aria-label={t('continueWith', { provider: selectedRegionalProvider.name })}
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
                prefix={t('continueWithPrefix')}
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
  }

  const primary = providers.filter((provider) => PRIMARY_TARGETS.has(provider.target))
  const more = providers.filter((provider) => !PRIMARY_TARGETS.has(provider.target))
  // Nothing to collapse behind when a deployment offers no primary provider at all.
  if (primary.length === 0) return more.map(renderProvider)

  return (
    <>
      {primary.map(renderProvider)}
      {more.length > 0 && (
        <>
          <div className="flex items-center gap-3 before:h-px before:flex-1 before:bg-(--border-default) after:h-px after:flex-1 after:bg-(--border-default)">
            <button
              type="button"
              aria-expanded={showMore}
              className="flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 font-sans text-[13px] font-medium leading-normal text-(--text-tertiary) hover:text-(--text-primary)"
              onClick={() => setShowMore((open) => !open)}
            >
              {t(showMore ? 'fewerOptions' : 'moreOptions')}
              <Icon name={showMore ? 'chevron-up' : 'chevron-down'} size={14} />
            </button>
          </div>
          {showMore && (
            <div className="grid grid-cols-2 gap-2">
              {more.map((provider) => (
                <button
                  key={provider.target}
                  type="button"
                  aria-label={t('continueWith', { provider: provider.name })}
                  className="sso h-[38px]"
                  onClick={() => onContinue(provider.target)}
                >
                  <SocialLoginMark target={provider.target} size={18} />
                  {provider.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
