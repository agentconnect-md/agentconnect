// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import type { DaemonRow } from '@/lib/data'
import { Button, Icon } from '@/components/ui'

// Type-to-confirm delete of an OFFLINE daemon. Removing it from the control plane
// drops its keys + unplaces its agents; the daemon binary keeps running on the host
// until stopped there. The CP refuses (409) if the daemon raced back online.
export default function DeleteDaemonModal({ daemon, onClose }: { daemon: DaemonRow; onClose: () => void }) {
  const { deleteDaemon, agents } = useConsoleData()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const matches = confirm.trim() === daemon.name
  // Heads-up: deleting the daemon unplaces the agents hosted on it. Count agents
  // assigned to this daemon (matches the detail view's "Agents hosted") — not
  // daemon.agents, which is the active-session count.
  const hostedCount = agents.filter((a) => a.daemon === daemon.daemonId).length

  const onDelete = async () => {
    if (!matches || busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteDaemon(daemon.daemonId)
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
          <Icon name="trash-2" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Delete daemon</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{daemon.name}</span>&#32;will be removed from the control plane.
          Its daemon process keeps running until you stop it, but it can no longer host agents or hold connections. This
          can&apos;t be undone.
        </p>
        {hostedCount > 0 && (
          <div className="mt-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
            <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
            <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              {hostedCount} {hostedCount === 1 ? 'agent' : 'agents'} hosted here will be unplaced until reassigned to
              another daemon.
            </span>
          </div>
        )}
        <div className="fld mt-4">
          <span className="fldlbl">
            Type <span className="mono text-(--text-primary)">{daemon.name}</span> to confirm
          </span>
          <input
            autoFocus
            value={confirm}
            disabled={busy}
            spellCheck={false}
            placeholder={daemon.name}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onDelete()
            }}
            className="dsinput-field mono h-[42px]"
          />
        </div>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={onDelete}
          className={matches && !busy ? undefined : 'pointer-events-none opacity-50'}
        >
          <Icon name="trash-2" size={15} />
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
