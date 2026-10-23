// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useTranslations } from 'next-intl'

/** The two editions' developer consoles: the mainland one in Chinese, the international one in English (dingtalk-integration.md §2.1). */
export const DINGTALK_CONSOLE_HOST = {
  mainland: 'open-dev.dingtalk.com',
  international: 'open-dev.dingtalk.io'
} as const
export type DingTalkEdition = keyof typeof DINGTALK_CONSOLE_HOST

/** The edition a bot was installed on; bots from before the edition switch are mainland. */
export function dingTalkEditionOf(bot: { platformConfig?: Record<string, string> | null }): DingTalkEdition {
  return bot.platformConfig?.edition === 'international' ? 'international' : 'mainland'
}

/** A new install starts on the edition that matches the console language. */
export function dingTalkInitialEdition(locale: string): DingTalkEdition {
  return locale === 'zh-CN' ? 'mainland' : 'international'
}

// The DingTalk tile's label: the brand on top, the edition switch below, which fits the tile where one line does not.
export function DingTalkEditionSwitcher({
  value,
  onSwitch,
  disabled
}: {
  value: string
  onSwitch(next: string): void
  disabled: boolean
}) {
  const t = useTranslations('Platforms.dingtalk')
  const edition: DingTalkEdition = value === 'international' ? 'international' : 'mainland'
  const other: DingTalkEdition = edition === 'mainland' ? 'international' : 'mainland'
  return (
    <span className="inline-flex flex-col items-center gap-[2px]">
      <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">{t('brand')}</span>
      <span className="inline-flex items-baseline whitespace-nowrap">
        <span className="font-sans text-[10px] font-semibold leading-normal text-(--brand)">
          {t(`editions.${edition}`)}
        </span>
        <span
          aria-hidden="true"
          className="mx-[2px] font-sans text-[10px] font-normal leading-normal text-(--text-tertiary)"
        >
          /
        </span>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('switchEdition', { edition: t(`editions.${other}`) })}
          className="cursor-pointer rounded-[2px] border-0 bg-transparent p-0 font-sans text-[10px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:cursor-not-allowed disabled:opacity-50"
          onClick={(event) => {
            event.stopPropagation()
            onSwitch(other)
          }}
        >
          {t(`editions.${other}`)}
        </button>
      </span>
    </span>
  )
}
