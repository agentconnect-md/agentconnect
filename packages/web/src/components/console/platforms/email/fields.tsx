// No 'use client' here: rendered only inside ModalProvider's tree and the console views, both client trees.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'

/** Copies `value`, and says so for a moment; an unavailable clipboard leaves the visible value to select. */
function useCopy(value: string): { copied: boolean; copy(): void } {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — the address is visible to select manually */
    }
  }
  return { copied, copy: () => void copy() }
}

/** The address as a field, with its copy button. */
export function AddressField({ address }: { address: string }) {
  const t = useTranslations('Platforms.email')
  const { copied, copy } = useCopy(address)
  return (
    <div className="fld">
      <span className="fldlbl">{t('address')}</span>
      <div className="flex items-center gap-2 rounded-[9px] border border-(--border-default) bg-(--surface-card) py-[5px] pr-[5px] pl-3">
        <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{address}</span>
        <button
          type="button"
          className="iconbtn flex-none"
          title={copied ? t('copied') : t('copy')}
          aria-label={t('copyAddress')}
          onClick={copy}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
    </div>
  )
}

/** The address's copy button alone, for a header that already shows the address. */
export function CopyAddressButton({ address }: { address: string }) {
  const t = useTranslations('Platforms.email')
  const { copied, copy } = useCopy(address)
  return (
    <button
      type="button"
      className="iconbtn h-7 w-7 flex-none"
      title={copied ? t('copied') : t('copyAddress')}
      aria-label={t('copyAddress')}
      onClick={(event) => {
        event.stopPropagation()
        copy()
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  )
}
