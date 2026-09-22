'use client'

// A deep link to a Decisions route on a console that never turned the surface on: the
// prototype reads a mock service, so there is no organization resource to show yet.

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'

export function DecisionsNotOffered() {
  const t = useTranslations('Decisions.notOffered')
  return (
    <div className="wrap max-desktop:p-4">
      <div className="card flex flex-col items-center gap-2 px-6 py-[44px] text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-[10px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="split" size={20} color="var(--text-tertiary)" />
        </span>
        <div className="font-sans text-[15px] font-semibold leading-normal">{t('title')}</div>
        <div className="max-w-[440px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
          {t('body')}
        </div>
      </div>
    </div>
  )
}
