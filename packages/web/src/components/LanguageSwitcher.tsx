'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { setLocale } from '@/i18n/actions'
import { isLocale, LOCALES, localeList } from '@/i18n/config'

function localeLabel(meta: { label: string; status: 'source' | 'reviewed' | 'draft' }, beta: string) {
  return meta.label + (meta.status === 'draft' ? ' (' + beta + ')' : '')
}

export default function LanguageSwitcher({
  className = '',
  showLabel = true
}: {
  className?: string
  showLabel?: boolean
}) {
  const locale = useLocale()
  const t = useTranslations('Common.language')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (localeList.length < 2) return null

  return (
    <label className={['inline-flex items-center gap-2', className].filter(Boolean).join(' ')}>
      {showLabel && (
        <span className="font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">{t('label')}</span>
      )}
      <select
        aria-label={t('label')}
        className="h-8 rounded-sm border border-(--border-default) bg-(--surface-card) px-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)"
        value={locale}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value
          if (!isLocale(next)) return
          startTransition(async () => {
            await setLocale(next)
            router.refresh()
          })
        }}
      >
        {localeList.map((tag) => {
          const meta = LOCALES[tag]
          return (
            <option key={tag} value={tag}>
              {localeLabel(meta, t('beta'))}
            </option>
          )
        })}
      </select>
    </label>
  )
}
