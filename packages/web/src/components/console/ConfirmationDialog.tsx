'use client'

import { useEffect, useId, type ReactNode } from 'react'
import { Button, Icon } from '@/components/ui'

export function ConfirmationDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  busyLabel = 'Saving…',
  error,
  onConfirm,
  onClose
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  busy?: boolean
  busyLabel?: string
  error?: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  return (
    <div className="scrim">
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-paused-soft)">
            <Icon name="triangle-alert" size={16} color="var(--amber-500)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {title}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <div className="font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">{children}</div>
          {error ? (
            <div
              className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
