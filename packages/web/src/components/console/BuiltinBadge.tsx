import { useTranslations } from 'next-intl'

// Built-in preset agents carry this identity badge and cannot be deleted.
export function BuiltinBadge({ show }: { show: boolean }) {
  const t = useTranslations('Common.builtinBadge')
  if (!show) return null
  return (
    <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)" title={t('title')}>
      {t('label')}
    </span>
  )
}
