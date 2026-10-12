'use client'

import { Button } from '@/components/ui'

/** An inline confirm strip, one responsive row: it wraps under the row's text on a phone. */
export function ConfirmStrip({
  prompt,
  confirm,
  keep,
  busy,
  onConfirm,
  onKeep,
  tone = 'danger'
}: {
  prompt: string
  confirm: string
  keep: string
  busy: boolean
  onConfirm: () => void
  onKeep: () => void
  tone?: 'danger' | 'primary'
}) {
  return (
    <div
      role="group"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)"
    >
      <span className="min-w-0 flex-1">{prompt}</span>
      <Button variant={tone} size="xs" disabled={busy} onClick={onConfirm}>
        {confirm}
      </Button>
      <Button variant="secondary" size="xs" disabled={busy} onClick={onKeep}>
        {keep}
      </Button>
    </div>
  )
}
