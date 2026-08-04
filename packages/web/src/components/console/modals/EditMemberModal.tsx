// No 'use client' here: rendered only inside SettingsView (a client component).

// Edit-member dialog (design: `isEditModal`). Owners can re-role/remove any
// member; every member can open their own row and leave. The CP refuses to
// demote/remove the LAST owner (409), and the dialog pre-disables those paths.

import { useEffect, useState } from 'react'
import { Avatar, Button, Icon } from '@/components/ui'
import {
  updateMemberRole,
  removeMember,
  fetchMemberRemovalPreview,
  ApiError,
  type MemberRole,
  type MemberRemovalPreviewDto,
  type VisibilityResourceKind
} from '@/lib/api'

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
  isCurrentUser: boolean
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

const KIND_LABEL: Record<VisibilityResourceKind, [one: string, many: string]> = {
  agent: ['agent', 'agents'],
  daemon: ['daemon', 'daemons'],
  cron: ['schedule', 'schedules'],
  mcpProvider: ['MCP provider', 'MCP providers'],
  skillSource: ['skill source', 'skill sources']
}

/** `2 agents, 1 daemon and 3 schedules` — omitting unaffected kinds. */
function countPhrase(resources: MemberRemovalPreviewDto['resources']): string {
  const parts = resources.map((r) => `${r.selected} ${KIND_LABEL[r.kind][r.selected === 1 ? 0 : 1]}`)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The danger card's subtitle: exactly how Selected audiences change. */
function audienceSentence(preview: MemberRemovalPreviewDto, leaving: boolean): string {
  const replacement = preview.replacement
  if (!replacement) return 'An organization needs at least one owner — promote another member first.'
  if (preview.resources.length === 0) {
    return leaving
      ? 'You are not included in any Selected audiences.'
      : 'They are not included in any Selected audiences.'
  }

  const removed = `${leaving ? 'Your' : 'Their'} access will be removed from ${countPhrase(preview.resources)}.`
  const reassigned = preview.resources.reduce((count, resource) => count + resource.reassigned, 0)
  if (reassigned === 0) return `${removed} Every affected resource still has another selected member.`

  const recipient = replacement.isCurrentUser
    ? 'you'
    : (replacement.name ?? replacement.email ?? 'the longest-standing owner')
  const repair =
    reassigned === 1
      ? `One would otherwise have no selected members, so ${recipient} will be added.`
      : `${reassigned} would otherwise have no selected members, so ${recipient} will be added.`
  return `${removed} ${repair}`
}

const dotOn = 'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-4 border-(--brand) bg-(--surface-card)'
const dotOff =
  'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-[1.5px] border-(--border-strong) bg-(--surface-card)'

export default function EditMemberModal({
  member,
  canEditRole,
  onLeave,
  onClose,
  onChanged
}: {
  member: MemberTarget
  canEditRole: boolean
  onLeave?: () => Promise<void>
  onClose: () => void
  onChanged: () => void
}) {
  const [role, setRole] = useState<MemberRole>(member.role)
  const [busy, setBusy] = useState(false)
  const [removeArmed, setRemoveArmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemberRemovalPreviewDto | null>(null)

  // Advisory read — a failure just leaves the generic copy in place rather than
  // blocking the dialog (the removal itself re-derives all of this server-side).
  useEffect(() => {
    let live = true
    void fetchMemberRemovalPreview(member.userId)
      .then((p) => live && setPreview(p))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [member.userId])

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setErr('An organization needs at least one owner.')
    else setErr(e instanceof Error ? e.message : String(e))
    setBusy(false)
  }

  const save = async () => {
    if (busy) return
    if (!canEditRole) return onClose()
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
      if (onLeave) await onLeave()
      else {
        await removeMember(member.userId)
        onChanged()
      }
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
            const locked = !canEditRole || (member.lastOwner && t.role !== 'owner')
            return (
              <div
                key={t.role}
                className={`${on ? 'ptile on' : 'ptile'} items-start ${
                  locked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
                }`}
                title={
                  !canEditRole
                    ? 'Only organization owners can change roles'
                    : locked
                      ? 'An organization needs at least one owner'
                      : undefined
                }
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
              {onLeave ? 'Leave organization' : 'Remove from organization'}
            </div>
            <div className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              {preview
                ? audienceSentence(preview, Boolean(onLeave))
                : onLeave
                  ? 'Your Selected access will be removed. An empty audience will receive an organization owner.'
                  : 'Removes their membership and Selected access. Their sessions stay in history.'}
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
            {removeArmed ? (onLeave ? 'Confirm leave' : 'Confirm remove') : onLeave ? 'Leave' : 'Remove'}
          </button>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
            Could not complete this change — {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {canEditRole && <Button onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</Button>}
      </div>
    </>
  )
}
