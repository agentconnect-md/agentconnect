// No 'use client' here: rendered only by AddComputerModal (inside ModalProvider, the client boundary).

// A `manual` computer from the deployment's pool (computer-use.md §10, §15.1): a name and who sees it; agents get it on their Tools tab.
import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createPoolComputer } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { VisibilityField, type SharingValue } from '@/components/console/VisibilityField'
import { Button, Icon } from '@/components/ui'

export default function AddPoolComputer({
  onClose,
  available,
  sourcePicker
}: {
  onClose: () => void
  available: boolean
  sourcePicker: ReactNode
}) {
  const t = useTranslations('Computers.add')
  const router = useRouter()
  const { orgPath } = useOrgs()
  const [name, setName] = useState('')
  // A managed computer is seen by everyone unless its creator narrows it.
  const [sharing, setSharing] = useState<SharingValue>({ visibility: 'org', sharedWith: [] })
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = name.trim()
  const ready = available && trimmed.length > 0

  const create = async () => {
    if (creating || !ready) return
    setCreating(true)
    setErr(null)
    try {
      const created = await createPoolComputer({ name: trimmed, ...sharing })
      onClose()
      router.push(orgPath(`/computers/${created.id}`))
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="monitor" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
      </div>
      <div className="modalbody">
        {sourcePicker}
        <p className="mb-[14px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          {t('poolDescription')}
        </p>
        <div className="fld">
          <span className="fldlbl">{t('poolName')}</span>
          <input
            className="inp"
            value={name}
            maxLength={120}
            spellCheck={false}
            placeholder={t('poolNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <VisibilityField value={sharing} onChange={setSharing} disabled={creating} />
        <span className="mt-[6px] block font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('poolAccessHint')}
        </span>
        {!available && (
          <div
            role="status"
            className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-[#9a6500]"
          >
            <Icon name="triangle-alert" size={15} className="mt-[1px] flex-none" />
            {t('poolUnavailable')}
          </div>
        )}
        {err && (
          <div
            role="alert"
            className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
          >
            <Icon name="triangle-alert" size={15} />
            {t('poolError', { message: err })}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button variant="primary" disabled={!ready || creating} onClick={() => void create()}>
          {creating ? t('poolCreating') : t('poolCreate')}
        </Button>
      </div>
    </>
  )
}
