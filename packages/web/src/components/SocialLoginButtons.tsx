'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import LarkFeishuSwitcher, { type LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'
import { SocialLoginMark } from '@/components/marks'
import type { SocialLoginProvider, SocialLoginTarget } from '@/lib/social-login-providers'

const isLarkOrFeishu = (
  provider: SocialLoginProvider
): provider is Extract<SocialLoginProvider, { target: LarkFeishuTarget }> =>
  provider.target === 'lark' || provider.target === 'feishu'

// Full-width buttons shown up front; the rest sit in a compact row below.
const VISIBLE_BUTTONS = 4

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
  const [showRegional, setShowRegional] = useState(false)
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

  // One button per provider, except that Lark and Feishu share one up front.
  const buttons = providers.filter((provider) => !isLarkOrFeishu(provider) || provider === firstRegionalProvider)
  const primary = buttons.slice(0, VISIBLE_BUTTONS)
  const regionalUpFront = firstRegionalProvider !== undefined && primary.includes(firstRegionalProvider)
  const more = providers.filter(
    (provider) => !primary.includes(provider) && !(regionalUpFront && isLarkOrFeishu(provider))
  )

  return (
    <>
      {primary.map(renderProvider)}
      {more.length > 0 && (
        <>
          <div className="flex items-center gap-3 font-sans text-[12px] font-medium leading-normal text-(--text-tertiary) before:h-px before:flex-1 before:bg-(--border-default) after:h-px after:flex-1 after:bg-(--border-default)">
            {t('or')}
          </div>
          <div className="relative flex gap-2.5">
            {more.map((provider) => {
              // Lark and Feishu share one mark, so the row shows it once and asks which cloud on click.
              if (isLarkOrFeishu(provider) && provider !== firstRegionalProvider) return null
              const pair = isLarkOrFeishu(provider) && regionalProviders.length > 1
              const label = pair ? regionalProviders.map((p) => p.name).join(' / ') : provider.name
              return (
                <button
                  key={provider.target}
                  type="button"
                  aria-label={t('continueWith', { provider: label })}
                  aria-expanded={pair ? showRegional : undefined}
                  title={t('continueWith', { provider: label })}
                  className="sso min-w-0 flex-1"
                  onClick={() => (pair ? setShowRegional((open) => !open) : onContinue(provider.target))}
                >
                  <SocialLoginMark target={provider.target} size={20} />
                </button>
              )
            })}
            {showRegional && (
              <div className="absolute top-full z-10 mt-2 flex gap-1 rounded-lg border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-md)">
                {regionalProviders.map((provider) => (
                  <button
                    key={provider.target}
                    type="button"
                    aria-label={t('continueWith', { provider: provider.name })}
                    className="cursor-pointer rounded-md border-0 bg-transparent px-3 py-1.5 font-sans text-[13px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
                    onClick={() => onContinue(provider.target)}
                  >
                    {provider.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
