import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FieldSelect } from '@/components/console/FieldSelect'
import type { NewConversationMode } from '@/lib/api'

/** The Integrations card's footer line: what the agent's new rooms and group DMs start at, unset reading as Auto. */
export function NewChannelsDefault({
  value,
  disabled,
  onChange,
  className = ''
}: {
  value: NewConversationMode | null | undefined
  disabled: boolean
  onChange: (mode: NewConversationMode) => Promise<void>
  className?: string
}) {
  const t = useTranslations('Agents.detail.integrations')
  // The pick shows at once and falls back to the stored mode if the save fails.
  const [picked, setPicked] = useState<NewConversationMode | null>(null)
  useEffect(() => setPicked(null), [value])
  return (
    <div
      className={`flex flex-wrap items-center gap-x-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) ${className}`}
    >
      <span>{t('newChannels')}</span>
      <FieldSelect
        inline
        value={picked ?? value ?? 'auto'}
        options={[
          { value: 'auto', label: t('newChannelsAuto') },
          { value: 'mention', label: t('newChannelsMention') },
          { value: 'off', label: t('newChannelsOff') }
        ]}
        ariaLabel={t('newChannels')}
        disabled={disabled}
        onChange={(mode) => {
          setPicked(mode)
          onChange(mode).catch(() => setPicked(null))
        }}
      />
    </div>
  )
}
