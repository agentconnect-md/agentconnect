// No 'use client' here: rendered only inside the console views, a client tree.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { FieldSelect } from '@/components/console/FieldSelect'
import { memberDisplayName, type EmailSettingsDto, type EmailSettingsInput } from '@/lib/api'
import { MOCK_MODE, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { emailApi } from './api'

type WhoMayWrite = EmailSettingsDto['whoMayWrite']

/** The organization, or a member's id, as the outside-sessions select names them. */
const ORG = 'org'
const NOBODY = ''

/** What the settings name, as the select shows it; a pick that is gone shows as nobody. */
function outsideValue(settings: EmailSettingsDto): string {
  const outside = settings.outsideSessions
  if (outside.kind === 'org') return ORG
  return outside.userId && outside.active ? outside.userId : NOBODY
}

/** Who may write to the address and, under Anyone, who sees an outside sender's session (email-integration.md §4.1). */
export function EmailAddressSettings({ integration, padX }: { integration: IntegrationRow; padX: number }) {
  const t = useTranslations('Platforms.email.settings')
  const orgId = useOrgs().activeOrg?.id ?? ''
  const { getAgent, members } = useConsoleData()
  const agent = integration.agentId ? getAgent(integration.agentId) : undefined
  const canEdit = agent?.canEdit === true
  // A demo row has no id, and design mode no Control Plane: neither reads anything.
  const integrationId = integration.id ?? ''
  const key = !MOCK_MODE && orgId && integrationId ? consoleKeys.emailSettings(orgId, integrationId) : null
  const { data, mutate } = useSWR<EmailSettingsDto>(key, () => emailApi.settings(orgId, integrationId), {
    revalidateOnFocus: false
  })
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!data) return null

  const save = async (next: EmailSettingsInput) => {
    setSaving(true)
    setFailed(false)
    try {
      await mutate(await emailApi.saveSettings(orgId, integrationId, next), { revalidate: false })
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const current = outsideValue(data)
  // A choice of who may write keeps the outside pick, or makes the editor the pick when none stands.
  const outsideInput = (value: string): EmailSettingsInput['outsideSessions'] | undefined =>
    value === ORG ? { kind: 'org' } : value ? { kind: 'member', userId: value } : undefined
  const editor = members.find((member) => member.isCurrentUser) ?? members[0]
  const fallback = outsideInput(current) ?? (editor ? outsideInput(editor.userId) : undefined)

  const disabled = !canEdit || saving
  return (
    <div className="flex flex-col gap-3 desktop:flex-row desktop:items-start" style={{ padding: `12px ${padX}px` }}>
      <div className="fld min-w-0 desktop:w-[220px]">
        <span className="fldlbl">{t('whoMayWrite')}</span>
        <FieldSelect<WhoMayWrite>
          ariaLabel={t('whoMayWrite')}
          value={data.whoMayWrite}
          disabled={disabled || !fallback}
          options={[
            { value: 'members', label: t('members') },
            { value: 'anyone', label: t('anyone') }
          ]}
          onChange={(whoMayWrite) => {
            if (whoMayWrite !== data.whoMayWrite && fallback) void save({ whoMayWrite, outsideSessions: fallback })
          }}
        />
      </div>
      {data.whoMayWrite === 'anyone' && (
        <div className="fld min-w-0 desktop:w-[260px]">
          <span className="fldlbl">{t('outsideSessions')}</span>
          <FieldSelect<string>
            ariaLabel={t('outsideSessions')}
            value={current}
            disabled={disabled}
            options={[
              ...(current === NOBODY ? [{ value: NOBODY, label: t('nobody') }] : []),
              { value: ORG, label: t('organization') },
              ...members.map((member) => ({ value: member.userId, label: memberDisplayName(member) }))
            ]}
            onChange={(value) => {
              const outsideSessions = outsideInput(value)
              if (value !== current && outsideSessions) void save({ whoMayWrite: 'anyone', outsideSessions })
            }}
          />
        </div>
      )}
      {failed && (
        <p role="alert" className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {t('failed')}
        </p>
      )}
    </div>
  )
}
