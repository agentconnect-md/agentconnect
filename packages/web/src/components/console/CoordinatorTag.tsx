'use client'

import { useTranslations } from 'next-intl'

// An Auto conversation's coordinator session (auto-session-mode.md §11), marked beside its title wherever it is listed.
export function CoordinatorTag({ show }: { show?: boolean }) {
  const t = useTranslations('Sessions.coordinator')
  if (!show) return null
  return (
    <span
      data-coordinator-tag=""
      title={t('hint')}
      className="badge flex-none bg-(--surface-active) text-(--text-tertiary)"
    >
      {t('label')}
    </span>
  )
}
