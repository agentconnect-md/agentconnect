'use client'

// The Computers an agent may use (computer-use.md §4.1), derived from each Computer's agent access and edited here from the agent's side.
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { addComputerAgent, removeComputerAgent, type ComputerDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { agentAccessOf, computerGrantsAgent, computerStatusTone, useComputers } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { AttachedEmpty, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { Icon } from '@/components/ui'

export function AgentComputersCard({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const t = useTranslations('Agents.detail.computers')
  const tc = useTranslations('Computers')
  const { getAgent, refresh } = useConsoleData()
  const { orgPath } = useOrgs()
  const { data: computers, error: listError, mutate } = useComputers()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const live = (computers ?? []).filter((c) => c.status !== 'revoked')
  const visible = new Set((computers ?? []).map((c) => c.id))
  // A Computer the caller can see answers for itself; the agent's derived list adds the ones they cannot.
  const granting = live.filter((c) => computerGrantsAgent(c, agentId))
  const hidden = (getAgent(agentId)?.computerUse?.computers ?? []).filter((id) => !visible.has(id))
  const addable = live.filter(
    (c) => c.canEditAgentAccess === true && agentAccessOf(c).mode !== 'all' && !computerGrantsAgent(c, agentId)
  )

  const change = async (run: () => Promise<ComputerDto>) => {
    if (saving || !canEdit) return
    setSaving(true)
    setError(null)
    try {
      await run()
      await mutate()
      // The agent's own derived list follows the Computer's access.
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const menu = canEdit ? (
    <AttachMenu
      ariaLabel={t('add')}
      disabled={saving || !computers}
      actions={[]}
      groups={[
        {
          heading: t('available'),
          icon: 'monitor',
          emptyLabel: t('noMore'),
          options: addable.map((c) => ({
            key: c.id,
            name: c.name,
            meta: c.os,
            onPick: () => void change(() => addComputerAgent(c.id, agentId))
          }))
        }
      ]}
    />
  ) : undefined
  const failure = error ?? (listError instanceof Error ? listError.message : listError ? String(listError) : null)

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        <div className="ml-auto flex items-center gap-2">{menu}</div>
      </div>
      {failure && (
        <div role="alert" className="px-4 py-3 text-[13px] text-(--status-error)">
          {failure}
        </div>
      )}
      {granting.length === 0 && hidden.length === 0 ? (
        <AttachedEmpty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <>
          {granting.map((computer) => {
            const tone = computerStatusTone(computer.status)
            const all = agentAccessOf(computer).mode === 'all'
            // Only a Selected list the caller may edit is changed from here; All agents is changed on the Computer.
            const removable = canEdit && !saving && !all && computer.canEditAgentAccess === true
            return (
              <AttachedRow
                key={computer.id}
                mark={<Icon name="monitor" size={18} />}
                name={computer.name}
                meta={
                  <>
                    <span style={{ color: tone.text }}>{tc(`status.${computer.status}`)}</span>
                    {' · '}
                    {all ? t('viaAll') : t('viaSelected')}
                  </>
                }
                actions={
                  <Link
                    className="iconbtn flex-none"
                    href={orgPath(`/computers/${computer.id}`)}
                    title={t('open')}
                    aria-label={t('open')}
                  >
                    <Icon name="arrow-up-right" size={15} />
                  </Link>
                }
                onRemove={removable ? () => void change(() => removeComputerAgent(computer.id, agentId)) : undefined}
                removeTitle={t('remove')}
              />
            )
          })}
          {hidden.map((id) => (
            <AttachedRow key={id} mark={<Icon name="monitor" size={18} />} name={t('unavailable')} meta={id} dimmed />
          ))}
        </>
      )}
    </div>
  )
}
