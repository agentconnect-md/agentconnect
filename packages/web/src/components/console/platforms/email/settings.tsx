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
      : data.outsideSessions.kind === 'editors'
        ? t('anyoneEditors')
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

/** A radio row: the dot, its label, and an optional quiet note after it. */
function Radio({ on, label, note, onPick }: { on: boolean; label: string; note?: string; onPick: () => void }) {
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
      {note && <span className="text-(--text-tertiary)">{note}</span>}
    </button>
  )
}

/** The two choices as a form holds them: who may write, and who sees outside mail with its picked member. */
export interface EmailSettingsDraft {
  whoMayWrite: WhoMayWrite
  outsideKind: OutsideKind
  memberId: string
}

/** The draft's outside-sessions choice as the Control Plane takes it; undefined while a member is still to be picked. */
export function emailOutsideSessionsInput(
  draft: EmailSettingsDraft,
  fallbackMember = ''
): EmailSettingsInput['outsideSessions'] | undefined {
  if (draft.outsideKind === 'editors') return { kind: 'editors' }
  if (draft.outsideKind === 'org') return { kind: 'org' }
  // Members-only still stores an outside pick, so a missing member falls back to the given one.
  const member = draft.memberId || (draft.whoMayWrite === 'members' ? fallbackMember : '')
  return member ? { kind: 'member', userId: member } : undefined
}

/** Who may write, and under Anyone who sees outside mail: the radios the create pane and the settings dialog share. */
export function EmailSettingsChoices({
  draft,
  onChange,
  members,
  memberGone = false
}: {
  draft: EmailSettingsDraft
  onChange: (next: EmailSettingsDraft) => void
  members: readonly MemberDto[]
  memberGone?: boolean
}) {
  const t = useTranslations('Platforms.email.settings')
  const acceptId = useId()
  const outsideId = useId()
  const set = (patch: Partial<EmailSettingsDraft>) => onChange({ ...draft, ...patch })
  const memberPicker = (
    <div className="min-w-40 flex-1 desktop:max-w-[240px]">
      <FieldSelect<string>
        ariaLabel={t('member')}
        value={draft.memberId}
        options={[
          ...(draft.memberId === NOBODY
            ? [{ value: NOBODY, label: memberGone ? t('nobody') : t('chooseMember') }]
            : []),
          ...members.map((candidate) => ({ value: candidate.userId, label: memberDisplayName(candidate) }))
        ]}
        onChange={(value) => set(value ? { memberId: value, outsideKind: 'member' } : { memberId: value })}
      />
    </div>
  )
  // One row per choice of who sees outside mail; a choice may carry a control beside its radio.
  const outsideChoices: readonly { kind: OutsideKind; label: string; note?: string; control?: ReactNode }[] = [
    { kind: 'editors', label: t('editors'), note: t('default') },
    { kind: 'org', label: t('organization') },
    { kind: 'member', label: t('specificMember'), control: memberPicker }
  ]
  return (
    <>
      <div>
        <div id={acceptId} className="fldlbl mb-1">
          {t('acceptFrom')}
        </div>
        <div role="radiogroup" aria-labelledby={acceptId} className="flex flex-col">
          <Radio
            on={draft.whoMayWrite === 'members'}
            label={t('members')}
            onPick={() => set({ whoMayWrite: 'members' })}
          />
          <Radio
            on={draft.whoMayWrite === 'anyone'}
            label={t('anyone')}
            onPick={() => set({ whoMayWrite: 'anyone' })}
          />
        </div>
      </div>
      {draft.whoMayWrite === 'anyone' && (
        <div>
          <div id={outsideId} className="fldlbl mb-1">
            {t('outsideViewers')}
          </div>
          <div role="radiogroup" aria-labelledby={outsideId} className="flex flex-col">
            {outsideChoices.map((choice) => (
              <div key={choice.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Radio
                  on={draft.outsideKind === choice.kind}
                  label={choice.label}
                  {...(choice.note ? { note: choice.note } : {})}
                  onPick={() => set({ outsideKind: choice.kind })}
                />
                {choice.control}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
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
  const editor = members.find((member) => member.isCurrentUser) ?? members[0]
  // The picker shows a member only when one is the saved choice.
  const initialMember = pickedMember(settings)
  const memberGone = settings.outsideSessions.kind === 'member' && initialMember === NOBODY
  const [draft, setDraft] = useState<EmailSettingsDraft>({
    whoMayWrite: settings.whoMayWrite,
    outsideKind: settings.outsideSessions.kind,
    memberId: initialMember
  })
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const outsideSessions = emailOutsideSessionsInput(draft, editor?.userId ?? '')
  const unchanged =
    draft.whoMayWrite === settings.whoMayWrite &&
    draft.outsideKind === settings.outsideSessions.kind &&
    draft.memberId === initialMember

  const submit = async () => {
    if (saving) return
    if (unchanged) return onClose()
    if (!outsideSessions) return
    setSaving(true)
    setFailed(false)
    try {
      await onSave({ whoMayWrite: draft.whoMayWrite, outsideSessions })
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
          <EmailSettingsChoices draft={draft} onChange={setDraft} members={members} memberGone={memberGone} />
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
