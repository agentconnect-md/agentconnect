// No 'use client' here: rendered only inside SettingsView (a client component).

// Edit-member dialog (design: `isEditModal`). REAL: Save PATCHes the role
// (owner grantable — an org can have several owners) and Remove DELETEs the
// membership; both owner-only server-side (the Settings page only offers the
// pencil to owners). The CP refuses to demote/remove the LAST owner (409) —
// the dialog pre-disables those paths via `member.lastOwner`.

import { useState } from 'react'
import { Avatar, Button, Icon } from '@/components/ui'
import { updateMemberRole, removeMember, ApiError, type MemberRole } from '@/lib/api'

/** What the member list row hands the dialog (display fields precomputed). */
export interface MemberTarget {
  userId: string
  name: string
  email: string | null
  picture: string | null
  initials: string
  avBg: string
  avText: string
  role: MemberRole
  /** True when this member is the org's only owner (demote/remove disabled). */
  lastOwner: boolean
}

const ROLE_TILES: { role: MemberRole; icon: string; title: string; desc: string }[] = [
  {
    role: 'owner',
    icon: 'shield',
    title: 'Owner',
    desc: 'Edit everything, plus add/remove members and change organization info.'
  },
  {
    role: 'collaborator',
    icon: 'users',
    title: 'Collaborator',
    desc: 'Create, edit & run agents, manage sessions. No member or organization changes.'
  },
  { role: 'viewer', icon: 'eye', title: 'Viewer', desc: 'Read-only — view agents, sessions and usage.' }
]

const dotOn = 'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-4 border-(--brand) bg-(--surface-card)'
const dotOff =
  'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-[1.5px] border-(--border-strong) bg-(--surface-card)'

export default function EditMemberModal({
  member,
  onClose,
  onChanged
}: {
  member: MemberTarget
  onClose: () => void
  onChanged: () => void
}) {
  const [role, setRole] = useState<MemberRole>(member.role)
  const [busy, setBusy] = useState(false)
  const [removeArmed, setRemoveArmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setErr('An organization needs at least one owner.')
    else setErr(e instanceof Error ? e.message : String(e))
    setBusy(false)
  }

  const save = async () => {
    if (busy) return
    if (role === member.role) return onClose()
    setBusy(true)
    setErr(null)
    try {
      await updateMemberRole(member.userId, role)
      onChanged()
      onClose()
    } catch (e) {
      fail(e)
    }
  }

  const remove = async () => {
    if (busy) return
    if (!removeArmed) return setRemoveArmed(true) // first click arms
    setBusy(true)
    setErr(null)
    try {
      await removeMember(member.userId)
      onChanged()
      onClose()
    } catch (e) {
      fail(e)
    }
  }

  return (
    <>
      <div className="modalhead">
        <Avatar
          src={member.picture}
          initials={member.initials}
          size={32}
          fontSize={12}
          bg={member.avBg}
          fg={member.avText}
        />
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[15px] font-semibold leading-normal">{member.name}</div>
          <div className="mono text-[11px] text-(--text-tertiary)">{member.email ?? '—'}</div>
        </div>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fldlbl mb-2">Role</div>
        <div className="flex flex-col gap-[10px]">
          {ROLE_TILES.map((t) => {
            const on = role === t.role
            // The last owner can't leave the owner role — the org would orphan.
            const locked = member.lastOwner && t.role !== 'owner'
            return (
              <div
                key={t.role}
                className={`${on ? 'ptile on' : 'ptile'} items-start ${
                  locked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
                }`}
                title={locked ? 'An organization needs at least one owner' : undefined}
                onClick={() => !locked && setRole(t.role)}
              >
                <span
                  className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border bg-(--surface-card) ${
                    on ? 'border-(--brand)' : 'border-(--border-default)'
                  }`}
                >
                  <Icon name={t.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                </span>
                <div className="flex-1">
                  <div className="font-sans text-[13px] font-semibold leading-normal">{t.title}</div>
                  <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                    {t.desc}
                  </div>
                </div>
                <span className={on ? dotOn : dotOff} />
              </div>
            )
          })}
        </div>
        <div className="mt-[18px] flex items-center gap-[11px] rounded-[9px] border border-[rgba(220,75,75,.28)] bg-(--status-error-soft) px-[13px] py-3">
          <Icon name="user-minus" size={16} color="var(--status-error)" className="flex-none" />
          <div className="flex-1">
            <div className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
              Remove from organization
            </div>
            <div className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              Revokes access immediately. Their sessions stay in history.
            </div>
          </div>
          <button
            disabled={member.lastOwner}
            title={member.lastOwner ? 'An organization needs at least one owner' : undefined}
            onClick={() => void remove()}
            className={`flex-none rounded-[7px] border border-[rgba(220,75,75,.4)] px-[11px] py-[6px] font-sans text-[12px] font-semibold leading-normal ${
              removeArmed ? 'bg-(--status-error) text-white' : 'bg-(--surface-card) text-(--status-error)'
            } ${member.lastOwner ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'}`}
          >
            {removeArmed ? 'Confirm remove' : 'Remove'}
          </button>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
            Could not save — {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </>
  )
}
