// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import type { MemberSetRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'

/**
 * Create or rename a daemon group (docs/designs/daemon-groups.md §2).
 *
 * A group has exactly one editable property — its name. Membership is not here: enrolling a daemon
 * moves runtime authority and is refused while agents are still pinned to it, so it belongs on the
 * daemon whose authority is moving, next to the state that decides whether it is allowed.
 */
export default function GroupModal({ group, onClose }: { group?: MemberSetRow; onClose: () => void }) {
  const { createGroup, renameGroup } = useConsoleData()
  const [name, setName] = useState(group?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = name.trim()

  const save = async () => {
    if (saving || !trimmed) return
    setSaving(true)
    setErr(null)
    try {
      if (group) await renameGroup(group.setId, trimmed)
      else await createGroup(trimmed)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="boxes" size={15} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {group ? 'Rename group' : 'New group'}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fld">
          <span className="fldlbl">Name</span>
          <input
            className="inp focus:border-(--brand) focus:outline-none"
            placeholder="lab"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            autoFocus
          />
        </div>
        {!group && (
          <p className="mt-[14px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
            A group is a set of your daemons an agent can be placed on instead of one machine. Whichever member is
            serving runs the agent, so losing any one of them moves its work to another. Add daemons from their own
            pages once the group exists.
          </p>
        )}
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
        <Button onClick={() => void save()} className={!saving && trimmed ? undefined : 'cursor-default opacity-50'}>
          {saving ? 'Saving…' : group ? 'Save' : 'Create group'}
        </Button>
      </div>
    </>
  )
}
