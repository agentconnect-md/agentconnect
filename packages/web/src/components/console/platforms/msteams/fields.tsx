// No 'use client' here: rendered only inside ModalProvider's tree and the Settings view, both client trees.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'

/** Copies a link for someone else to open: a person who may not open the Teams admin center sends it to an administrator. */
export function CopyLinkButton({
  url,
  label,
  copiedLabel,
  className
}: {
  url: string
  label: string
  copiedLabel: string
  className: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — the link beside it still opens */
    }
  }
  return (
    <button type="button" className={className} onClick={() => void copy()}>
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      {copied ? copiedLabel : label}
    </button>
  )
}

/** A value to paste into the bot registration, with its copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations('Platforms.msteams')
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
          title={copied ? t('copied') : t('copy')}
          aria-label={`${t('copy')} ${label}`}
          onClick={() => void copy()}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
    </div>
  )
}
