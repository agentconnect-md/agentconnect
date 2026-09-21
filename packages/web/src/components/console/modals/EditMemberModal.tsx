// No 'use client' here: rendered only inside SettingsView (a client component).

// Edit-member dialog (design: `isEditModal`). Owners can re-role/remove any
// member; every member can open their own row and leave. The CP refuses to
// demote/remove the LAST owner (409), and the dialog pre-disables those paths.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('Settings.members.editDialog')
  const [role, setRole] = useState<MemberRole>(member.role)
  const [busy, setBusy] = useState(false)
  const [removeArmed, setRemoveArmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemberRemovalPreviewDto | null>(null)
  const roleTiles = [
    { role: 'owner' as const, icon: 'shield', title: t('roles.owner.title'), desc: t('roles.owner.description') },
    {
      role: 'collaborator' as const,
      icon: 'users',
      title: t('roles.collaborator.title'),
      desc: t('roles.collaborator.description')
    },
    { role: 'viewer' as const, icon: 'eye', title: t('roles.viewer.title'), desc: t('roles.viewer.description') }
  ]
  const countPhrase = (resources: MemberRemovalPreviewDto['resources']) => {
    const labels: Record<VisibilityResourceKind, string> = {
      agent: t('resources.agent', { count: 2 }),
      daemon: t('resources.daemon', { count: 2 }),
      cron: t('resources.cron', { count: 2 }),
      mcpProvider: t('resources.mcpProvider', { count: 2 }),
      skillSource: t('resources.skillSource', { count: 2 })
    }
    return resources
      .map((resource) => t('resourceCount', { count: resource.selected, kind: labels[resource.kind] }))
      .join(', ')
  }
  const audienceSentence = (nextPreview: MemberRemovalPreviewDto, leaving: boolean) => {
    const replacement = nextPreview.replacement
    if (!replacement) return t('ownerRequired')
    if (nextPreview.resources.length === 0) return leaving ? t('noSelectedSelf') : t('noSelectedMember')
    const removed = t('accessRemoved', {
      subject: leaving ? t('your') : t('their'),
      resources: countPhrase(nextPreview.resources)
    })
    const reassigned = nextPreview.resources.reduce((count, resource) => count + resource.reassigned, 0)
    if (reassigned === 0) return `${removed} ${t('anotherSelected')}`
    const recipient = replacement.isCurrentUser
      ? t('you')
      : (replacement.name ?? replacement.email ?? t('longestOwner'))
    return `${removed} ${t('reassigned', { count: reassigned, recipient })}`
  }

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
    if (e instanceof ApiError && e.status === 409) setErr(t('ownerRequired'))
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
        <div className="fldlbl mb-2">{t('role')}</div>
        <div className="flex flex-col gap-[10px]">
          {roleTiles.map((tile) => {
            const on = role === tile.role
            // The last owner can't leave the owner role — the org would orphan.
            const locked = !canEditRole || (member.lastOwner && tile.role !== 'owner')
            return (
              <div
                key={tile.role}
                className={`${on ? 'ptile on' : 'ptile'} items-start ${
                  locked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
                }`}
                title={!canEditRole ? t('ownerOnly') : locked ? t('ownerRequired') : undefined}
                onClick={() => !locked && setRole(tile.role)}
              >
                <span
                  className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border bg-(--surface-card) ${
                    on ? 'border-(--brand)' : 'border-(--border-default)'
                  }`}
                >
                  <Icon name={tile.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                </span>
                <div className="flex-1">
                  <div className="font-sans text-[13px] font-semibold leading-normal">{tile.title}</div>
                  <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                    {tile.desc}
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
              {onLeave ? t('leaveOrganization') : t('removeOrganization')}
            </div>
            <div className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              {preview
                ? audienceSentence(preview, Boolean(onLeave))
                : onLeave
                  ? t('leaveFallback')
                  : t('removeFallback')}
            </div>
          </div>
          <button
            disabled={member.lastOwner}
            title={member.lastOwner ? t('ownerRequired') : undefined}
            onClick={() => void remove()}
            className={`flex-none rounded-[7px] border border-[rgba(220,75,75,.4)] px-[11px] py-[6px] font-sans text-[12px] font-semibold leading-normal ${
              removeArmed ? 'bg-(--status-error) text-white' : 'bg-(--surface-card) text-(--status-error)'
            } ${member.lastOwner ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'}`}
          >
            {removeArmed ? (onLeave ? t('confirmLeave') : t('confirmRemove')) : onLeave ? t('leave') : t('remove')}
          </button>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
            {t('changeFailed', { error: err })}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        {canEditRole && <Button onClick={() => void save()}>{busy ? t('saving') : t('saveChanges')}</Button>}
      </div>
    </>
  )
}
