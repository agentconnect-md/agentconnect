import type { ChatActions } from '@agentconnect.md/protocol'
import { useTranslations } from 'next-intl'
import { FieldSelect } from '@/components/console/FieldSelect'

const LEVELS: readonly ChatActions[] = ['talk', 'approve', 'settings']

/** What people can do in chat: each level includes the one before it (product-conventions.md). */
export function ChatActionsField({
  value,
  onChange,
  className
}: {
  value: ChatActions
  onChange: (value: ChatActions) => void
  className?: string
}) {
  const t = useTranslations('Common.chatActions')
  return (
    <div className={className ? `fld min-w-0 ${className}` : 'fld min-w-0'}>
      <span className="fldlbl" title={t('title')}>
        {t('label')}
      </span>
      <FieldSelect
        ariaLabel={t('label')}
        value={value}
        options={LEVELS.map((level) => ({
          value: level,
          label: t(`option.${level}`),
          title: t(`optionTitle.${level}`)
        }))}
        onChange={onChange}
      />
    </div>
  )
}
