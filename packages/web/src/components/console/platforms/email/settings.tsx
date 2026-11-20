// No 'use client' here: rendered only inside the console views, a client tree.

import { useId, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { FieldSelect } from '@/components/console/FieldSelect'
import { Scrim } from '@/components/console/Scrim'
import { Button, Icon } from '@/components/ui'
import { memberDisplayName, type EmailSettingsDto, type EmailSettingsInput, type MemberDto } from '@/lib/api'
import { MOCK_MODE, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { emailApi } from './api'

type WhoMayWrite = EmailSettingsDto['whoMayWrite']
type OutsideKind = EmailSettingsDto['outsideSessions']['kind']

/** The member picker's value while the picked member is gone. */
const NOBODY = ''

/** The picked member, or nobody when the pick is gone. */
function pickedMember(settings: EmailSettingsDto): string {
  const outside = settings.outsideSessions
  return outside.kind === 'member' && outside.userId && outside.active ? outside.userId : NOBODY
}

/** One address's settings, read once per card and shared by its status line and its dialog (email-integration.md §4.1). */
function useEmailSettings(integration: IntegrationRow) {
  const orgId = useOrgs().activeOrg?.id ?? ''
  const { getAgent } = useConsoleData()
  const agent = integration.agentId ? getAgent(integration.agentId) : undefined
  // A demo row has no id, and design mode no Control Plane: neither reads anything.
  const integrationId = integration.id ?? ''
  const key = !MOCK_MODE && orgId && integrationId ? consoleKeys.emailSettings(orgId, integrationId) : null
  const { data, mutate } = useSWR<EmailSettingsDto>(key, () => emailApi.settings(orgId, integrationId), {
    revalidateOnFocus: false
  })
  const save = async (next: EmailSettingsInput) => {
    await mutate(await emailApi.saveSettings(orgId, integrationId, next), { revalidate: false })
  }
  return { data, save, canEdit: agent?.canEdit === true }
}

/** The card's one line under the address: who may write, and under Anyone who sees mail from outside. */
export function EmailSettingsStatus({ integration, padX }: { integration: IntegrationRow; padX: number }) {
  const t = useTranslations('Platforms.email.settings.status')
  const { members } = useConsoleData()
  const { data } = useEmailSettings(integration)
  if (!data) return null
  const member = members.find((candidate) => candidate.userId === pickedMember(data))
  const line =
    data.whoMayWrite === 'members'
      ? t('members')
      : data.outsideSessions.kind === 'org'
        ? t('anyoneOrg')
        : pickedMember(data) === NOBODY
          ? t('anyoneNobody')
          : member
            ? t('anyoneMember', { name: memberDisplayName(member) })
            : t('anyoneSomeMember')
  return (
    <p
      className="m-0 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)"
      style={{ padding: `10px ${padX}px` }}
    >
      {line}
    </p>
  )
}

/** The header's gear, for an editor of the agent alone, and the dialog it opens. */
export function EmailSettingsButton({ integration }: { integration: IntegrationRow }) {
  const t = useTranslations('Platforms.email.settings')
  const { members } = useConsoleData()
  const { data, save, canEdit } = useEmailSettings(integration)
  const [open, setOpen] = useState(false)
  if (!canEdit || !data) return null
  return (
    <>
      <button
        type="button"
        className="iconbtn h-7 w-7 flex-none"
        title={t('title')}
        aria-label={t('title')}
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <Icon name="settings" size={14} />
      </button>
      {open && <EmailSettingsDialog settings={data} members={members} onSave={save} onClose={() => setOpen(false)} />}
    </>
  )
}

/** A radio row: the dot and its label. */
function Radio({ on, label, onPick }: { on: boolean; label: string; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className="flex min-h-11 flex-none items-center gap-[10px] rounded-md text-left font-sans text-[13.5px] font-normal leading-normal text-(--text-primary) focus-visible:shadow-(--focus-ring) focus-visible:outline-none desktop:min-h-8 desktop:text-[13px]"
    >
      <span
        className={
          on
            ? 'h-[14px] w-[14px] flex-none rounded-full border-4 border-(--brand) bg-(--surface-card)'
            : 'h-[14px] w-[14px] flex-none rounded-full border-[1.5px] border-(--border-strong) bg-(--surface-card)'
        }
      />
      {label}
    </button>
  )
}

/** The address's settings as a draft that one Save writes. */
function EmailSettingsDialog({
  settings,
  members,
  onSave,
  onClose
}: {
  settings: EmailSettingsDto
  members: readonly MemberDto[]
  onSave: (next: EmailSettingsInput) => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations('Platforms.email.settings')
  const actions = useTranslations('Common.actions')
  const titleId = useId()
  const acceptId = useId()
  const outsideId = useId()
  const editor = members.find((member) => member.isCurrentUser) ?? members[0]
  // The picker shows a member only when one is the saved choice.
  const initialMember = pickedMember(settings)
  const memberGone = settings.outsideSessions.kind === 'member' && initialMember === NOBODY
  const [whoMayWrite, setWhoMayWrite] = useState<WhoMayWrite>(settings.whoMayWrite)
  const [outsideKind, setOutsideKind] = useState<OutsideKind>(settings.outsideSessions.kind)
  const [memberId, setMemberId] = useState(initialMember)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  // Members-only still stores an outside pick, so a missing one falls back to the editor as before.
  const member = memberId || (whoMayWrite === 'members' ? (editor?.userId ?? '') : '')
  const outsideSessions: EmailSettingsInput['outsideSessions'] | undefined =
    outsideKind === 'org' ? { kind: 'org' } : member ? { kind: 'member', userId: member } : undefined
  const unchanged =
    whoMayWrite === settings.whoMayWrite && outsideKind === settings.outsideSessions.kind && memberId === initialMember

  const memberPicker = (
    <div className="min-w-40 flex-1 desktop:max-w-[240px]">
      <FieldSelect<string>
        ariaLabel={t('member')}
        value={memberId}
        options={[
          ...(memberId === NOBODY ? [{ value: NOBODY, label: memberGone ? t('nobody') : t('chooseMember') }] : []),
          ...members.map((candidate) => ({ value: candidate.userId, label: memberDisplayName(candidate) }))
        ]}
        onChange={(value) => {
          setMemberId(value)
          if (value) setOutsideKind('member')
        }}
      />
    </div>
  )
  // One row per choice of who sees outside mail; a choice may carry a control beside its radio.
  const outsideChoices: readonly { kind: OutsideKind; label: string; control?: ReactNode }[] = [
    { kind: 'org', label: t('organization') },
    { kind: 'member', label: t('specificMember'), control: memberPicker }
  ]

  const submit = async () => {
    if (saving) return
    if (unchanged) return onClose()
    if (!outsideSessions) return
    setSaving(true)
    setFailed(false)
    try {
      await onSave({ whoMayWrite, outsideSessions })
      onClose()
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }

  return (
    <Scrim onEscape={saving ? undefined : onClose}>
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="mail" size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {t('title')}
          </span>
          <button type="button" className="iconbtn" aria-label={actions('close')} disabled={saving} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-[18px]">
          <div>
            <div id={acceptId} className="fldlbl mb-1">
              {t('acceptFrom')}
            </div>
            <div role="radiogroup" aria-labelledby={acceptId} className="flex flex-col">
              <Radio on={whoMayWrite === 'members'} label={t('members')} onPick={() => setWhoMayWrite('members')} />
              <Radio on={whoMayWrite === 'anyone'} label={t('anyone')} onPick={() => setWhoMayWrite('anyone')} />
            </div>
          </div>
          {whoMayWrite === 'anyone' && (
            <div>
              <div id={outsideId} className="fldlbl mb-1">
                {t('outsideViewers')}
              </div>
              <div role="radiogroup" aria-labelledby={outsideId} className="flex flex-col">
                {outsideChoices.map((choice) => (
                  <div key={choice.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Radio
                      on={outsideKind === choice.kind}
                      label={choice.label}
                      onPick={() => setOutsideKind(choice.kind)}
                    />
                    {choice.control}
                  </div>
                ))}
              </div>
            </div>
          )}
          {failed && (
            <p role="alert" className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
              {t('failed')}
            </p>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {actions('cancel')}
          </Button>
          <Button disabled={saving || (!unchanged && !outsideSessions)} onClick={() => void submit()}>
            {saving ? t('saving') : actions('save')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
