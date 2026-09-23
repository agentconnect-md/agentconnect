'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { fetchAgentDto, fetchAgentDecisions } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { AttachedEmpty, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { Icon } from '@/components/ui'

export function AgentDecisionsCard({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const t = useTranslations('Agents.detail.decisions')
  const { api, orgId, decisions, loading, reload, error: libraryError } = useDecisionsPrototype()
  const { updateAgent } = useConsoleData()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const { data, error, mutate } = useSWR(
    orgId && api.mode === 'live' ? ['agent-decisions', orgId, agentId] : null,
    async ([, scopedOrg, id]) => {
      const [agent, attached] = await Promise.all([fetchAgentDto(id, scopedOrg), fetchAgentDecisions(id, scopedOrg)])
      return { ids: agent.decisionIds ?? [], attached }
    },
    { keepPreviousData: false }
  )
  const ids = data?.ids ?? []
  const busy = saving || loading || (api.mode === 'live' && !data)
  const save = async (next: string[]) => {
    if (busy || !canEdit) return
    setSaving(true)
    setSaveError(null)
    try {
      await updateAgent(agentId, { decisionIds: next })
      await Promise.all([mutate(), reload()])
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  const menu = canEdit ? (
    <AttachMenu
      ariaLabel={t('add')}
      disabled={busy || !!libraryError || !!error}
      actions={[]}
      groups={[
        {
          heading: t('available'),
          icon: 'git-branch',
          emptyLabel: t('noMore'),
          options: decisions
            .filter((decision) => !ids.includes(decision.id))
            .map((decision) => ({
              key: decision.id,
              name: decision.name,
              meta: decision.model,
              onPick: () => void save([...ids, decision.id])
            }))
        }
      ]}
    />
  ) : undefined
  const failure = saveError ?? (error instanceof Error ? error.message : error ? String(error) : null) ?? libraryError
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {menu && <div className="ml-auto">{menu}</div>}
      </div>
      {failure && (
        <div role="alert" className="px-4 py-3 text-[13px] text-(--status-error)">
          {failure}
        </div>
      )}
      {ids.length === 0 ? (
        <AttachedEmpty title={busy ? t('loading') : t('empty')} hint={t('hint')} />
      ) : (
        ids.map((id) => {
          const decision = data?.attached.find((item) => item.id === id)
          return (
            <AttachedRow
              key={id}
              mark={<Icon name="git-branch" size={18} />}
              name={decision?.name ?? t('unavailable')}
              meta={decision ? `${t(decision.questionType)} · ${decision.model}` : id}
              dimmed={!decision}
              onRemove={canEdit && !saving ? () => void save(ids.filter((value) => value !== id)) : undefined}
              removeTitle={t('remove')}
            />
          )
        })
      )}
    </div>
  )
}
