// No 'use client' here: rendered only inside SettingsView (a client component).

// Invite-members dialog (design: `isInviteModal`). REAL: each address is added
// directly via POST /members (owner-only server-side). No email is sent —
// an unknown address becomes an invited row that its owner claims the first
// time they sign in with SSO; an existing user gains access immediately.

import { useState } from 'react'
import { Button, Icon } from '@/components/ui'
import { addMember, ApiError, type MemberRole } from '@/lib/api'

const ROLE_TILES: { role: MemberRole; icon: string; title: string; desc: string; recommended?: boolean }[] = [
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
    desc: 'Create, edit & run agents, manage sessions. No member or organization changes.',
    recommended: true
  },
  { role: 'viewer', icon: 'eye', title: 'Viewer', desc: 'Read-only — view agents, sessions and usage.' }
]

const dotOn = 'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-4 border-(--brand) bg-(--surface-card)'
const dotOff =
  'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-[1.5px] border-(--border-strong) bg-(--surface-card)'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function InviteMembersModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [role, setRole] = useState<MemberRole>('collaborator')
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const emails = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  const valid = emails.length > 0 && emails.every((e) => EMAIL_RE.test(e))

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    const failures: string[] = []
    for (const email of emails) {
      try {
        await addMember(email, role)
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) failures.push(`${email} is already a member`)
        else failures.push(`${email}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    onAdded()
    if (failures.length) {
      setErr(failures.join('; '))
      setBusy(false)
    } else {
      onClose()
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="user-plus" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Invite members</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fld">
          <span className="fldlbl">Email addresses</span>
          <div className="inp">
            <input
              className="mono min-w-0 flex-1 border-0 bg-transparent font-[inherit] normal-nums text-[12.5px] outline-none"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="dev@acme.dev, ops@acme.dev"
            />
          </div>
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            Separate multiple addresses with commas. They join the organization.
          </span>
        </div>
        <div className="fldlbl mx-0 mt-[18px] mb-2">Role</div>
        <div className="flex flex-col gap-[10px]">
          {ROLE_TILES.map((t) => {
            const on = role === t.role
            return (
              <div
                key={t.role}
                className={on ? 'ptile on cursor-pointer items-start' : 'ptile cursor-pointer items-start'}
                onClick={() => setRole(t.role)}
              >
                <span
                  className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border bg-(--surface-card) ${
                    on ? 'border-(--brand)' : 'border-(--border-default)'
                  }`}
                >
                  <Icon name={t.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                </span>
                <div className="flex-1">
                  <div className="flex items-center gap-[7px]">
                    <span className="font-sans text-[13px] font-semibold leading-normal">{t.title}</span>
                    {t.recommended && (
                      <span className="badge bg-(--brand-soft) text-(--brand-soft-text)">recommended</span>
                    )}
                  </div>
                  <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                    {t.desc}
                  </div>
                </div>
                <span className={on ? dotOn : dotOff} />
              </div>
            )
          })}
        </div>
        <div className="mt-[14px] flex items-start gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="mail" size={14} className="mt-[1px] flex-none" />
          <span>
            No email is sent — members are added right away and get access the first time they sign in with this
            address.
          </span>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()}>
          <Icon name="user-plus" size={14} />
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </>
  )
}
