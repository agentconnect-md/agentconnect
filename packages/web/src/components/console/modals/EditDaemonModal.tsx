// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useRef, useState } from 'react'
import type { DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'
import { VisibilityField, sameSharing, type SharingValue } from '@/components/console/VisibilityField'

// The daemon's rename + sharing editor (replaces the old inline rename + the
// standalone sharing dialog). Name goes through renameDaemon; visibility rides the
// separate /sharing endpoint (canManageSharing gate), only written when it changed.
export default function EditDaemonModal({ daemon, onClose }: { daemon: DaemonRow; onClose: () => void }) {
  const { renameDaemon, saveSharing } = useConsoleData()
  const [name, setName] = useState(daemon.name)
  const [sharing, setSharing] = useState<SharingValue>({ visibility: daemon.visibility, sharedWith: daemon.sharedWith })
  const initialSharing = useRef<SharingValue>({ visibility: daemon.visibility, sharedWith: daemon.sharedWith })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (saving) return
    setSaving(true)
    setErr(null)
    try {
      const next = name.trim()
      if (next && next !== daemon.name) await renameDaemon(daemon.daemonId, next)
      if (daemon.canManageSharing && !sameSharing(sharing, initialSharing.current))
        await saveSharing('daemons', daemon.daemonId, sharing)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="server" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit daemon</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fld">
          <span className="fldlbl">Name</span>
          <input
            className="inp"
            value={name}
            maxLength={64}
            spellCheck={false}
            autoFocus
            placeholder="edge-1"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
        </div>
        <VisibilityField
          value={sharing}
          onChange={setSharing}
          creatorUserId={daemon.createdBy || null}
          disabled={!daemon.canManageSharing}
        />
        {err && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} />
            {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void save()} className={!saving ? undefined : 'cursor-default opacity-50'}>
          <Icon name="check" size={15} />
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  )
}
