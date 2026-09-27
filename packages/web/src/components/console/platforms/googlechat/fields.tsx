// No 'use client' here: rendered only inside ModalProvider's tree and the Settings view, both client trees.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'

/** A value to copy into Google Cloud Console, with its copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations('Platforms.googlechat')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — the value is visible to select manually */
    }
  }
  return (
    <div className="fld">
      <span className="fldlbl">{label}</span>
      <div className="flex items-center gap-2 rounded-[9px] border border-(--border-default) bg-(--surface-card) py-[5px] pr-[5px] pl-3">
        <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{value}</span>
        <button
          type="button"
          className="iconbtn flex-none"
          title={copied ? t('configure.copied') : t('configure.copy')}
          aria-label={`${t('configure.copy')} ${label}`}
          onClick={() => void copy()}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
    </div>
  )
}
