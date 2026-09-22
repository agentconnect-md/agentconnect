import { CompactToggleField } from '@/components/console/CompactToggleField'
import { useTranslations } from 'next-intl'

export function RuntimeChatField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const t = useTranslations('Common.runtimeChat')
  return (
    <CompactToggleField
      label={t('label')}
      checked={checked}
      onChange={onChange}
      detail={checked ? t('enabled') : t('disabled')}
    />
  )
}
