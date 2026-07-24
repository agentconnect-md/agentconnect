// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import type { IntegrationRow } from '@/lib/data'
import { Button, Icon } from '@/components/ui'

// Confirm-delete an integration. Drops the CP record and tells the owning daemon
// to close the connection; the bot identity (+ its tokens) survives, freed for
// reuse — delete it from Settings → Bots. The list re-pulls via the data context.
export default function DeleteIntegrationModal({
  integration,
  onClose
}: {
  integration: IntegrationRow
  onClose: () => void
}) {
  const { deleteIntegration } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onDelete = async () => {
    if (busy || !integration.id) return
    setBusy(true)
    setErr(null)
    try {
      await deleteIntegration(integration.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <Icon name="unplug" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Delete integration</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{integration.name}</span>&#32;will be removed and the owning
          daemon closes the connection. The bot identity stays, freed for reuse — you can delete it for good in Settings
          → Bots.
        </p>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onDelete} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name="unplug" size={15} />
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
