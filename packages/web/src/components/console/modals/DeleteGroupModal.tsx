// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import type { MemberSetRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'

/**
 * Delete a daemon group. The CP refuses (409) while the group still has daemons or placed agents —
 * dropping it would silently unplace them — so the dialog says what has to go first rather than
 * offering a button that fails.
 */
export default function DeleteGroupModal({ group, onClose }: { group: MemberSetRow; onClose: () => void }) {
  const { deleteGroup } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const members = group.memberDaemonIds.length
  const blocked = members > 0 || group.agentCount > 0

  const remove = async () => {
    if (busy || blocked) return
    setBusy(true)
    setErr(null)
    try {
      await deleteGroup(group.setId)
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
          <Icon name="trash-2" size={15} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Delete group</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="font-sans text-[13px] font-normal leading-[1.6] text-(--text-secondary)">
          {blocked ? (
            <>
              <span className="mono text-(--text-primary)">{group.name}</span> still has{' '}
              {members > 0 && `${members} daemon${members === 1 ? '' : 's'}`}
              {members > 0 && group.agentCount > 0 && ' and '}
              {group.agentCount > 0 && `${group.agentCount} agent${group.agentCount === 1 ? '' : 's'}`} on it. Remove
              the daemons and move the agents somewhere else first — deleting it now would leave them with nowhere to
              run.
            </>
          ) : (
            <>
              Delete <span className="mono text-(--text-primary)">{group.name}</span>? It is empty, so nothing stops
              running. This cannot be undone.
            </>
          )}
        </p>
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
        <Button
          variant="danger"
          onClick={() => void remove()}
          className={!busy && !blocked ? undefined : 'cursor-default opacity-50'}
        >
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
