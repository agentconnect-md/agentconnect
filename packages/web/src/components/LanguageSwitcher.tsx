'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { Icon } from '@/components/ui'
import { setLocale } from '@/i18n/actions'
import { isLocale, LOCALES, localeList } from '@/i18n/config'

function localeLabel(meta: { label: string; status: 'source' | 'reviewed' | 'draft' }, beta: string) {
  return meta.label + (meta.status === 'draft' ? ' (' + beta + ')' : '')
}

function useLocaleSwitch() {
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const switchTo = (next: string) => {
    if (!isLocale(next) || next === locale) return
    startTransition(async () => {
      await setLocale(next)
      router.refresh()
    })
  }
  return { locale, pending, switchTo }
}

export default function LanguageSwitcher({
  className = '',
  showLabel = true
}: {
  className?: string
  showLabel?: boolean
}) {
  const t = useTranslations('Common.language')
  const { locale, pending, switchTo } = useLocaleSwitch()

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
        onChange={(event) => switchTo(event.target.value)}
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

/** A `.dmi` row that opens the locale list as a flyout beside its dropdown menu. */
export function LanguageSubmenu({ onPicked }: { onPicked?: () => void }) {
  const t = useTranslations('Common.language')
  const { locale, pending, switchTo } = useLocaleSwitch()
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const menuId = useId()

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  if (localeList.length < 2) return null

  const show = () => {
    window.clearTimeout(closeTimer.current)
    setOpen(true)
  }
  // A short grace period lets the pointer cut diagonally across a neighbouring row to reach the flyout.
  const hide = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 150)
  }

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="dmi"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={show}
      >
        <Icon name="languages" size={15} color="var(--text-tertiary)" />
        <span className="flex-1">{t('label')}</span>
        <Icon name="chevron-right" size={15} color="var(--text-tertiary)" />
      </button>
      {open && (
        <div className="absolute -top-[5px] left-full z-50 pl-[9px]">
          <div
            id={menuId}
            role="menu"
            aria-label={t('label')}
            className="w-[200px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg)"
          >
            {localeList.map((tag) => (
              <button
                key={tag}
                type="button"
                role="menuitemradio"
                aria-checked={tag === locale}
                disabled={pending}
                className="dmi justify-between"
                onClick={() => {
                  switchTo(tag)
                  setOpen(false)
                  onPicked?.()
                }}
              >
                {localeLabel(LOCALES[tag], t('beta'))}
                {tag === locale && <Icon name="check" size={15} color="var(--brand)" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
