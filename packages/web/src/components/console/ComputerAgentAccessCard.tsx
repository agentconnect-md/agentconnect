'use client'

// Which agents may use a Computer (computer-use.md §4.1): No agents, Selected agents or All agents, the one relation both pages edit.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ComputerAgentAccess } from '@agentconnect.md/protocol/computer'
import { setComputerAgentAccess, type ComputerDto } from '@/lib/api'
import { agentAccessOf } from '@/lib/computers'
import { agentLabel, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { AttachedEmpty, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { ChoicePills, ChoiceTiles, type ChoiceOption } from '@/components/console/VisibilityField'
import { AgentIconView } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type Mode = ComputerAgentAccess['mode']

const sameAccess = (a: ComputerAgentAccess, b: ComputerAgentAccess) =>
  a.mode === b.mode && a.agents.length === b.agents.length && a.agents.every((id, i) => b.agents[i] === id)

export function ComputerAgentAccessCard({
  computer,
  onSaved
}: {
  computer: ComputerDto
  onSaved: (next: ComputerDto) => void
}) {
  const t = useTranslations('Computers.agentAccess')
  const isMobile = useIsMobile()
  const { agents, refresh } = useConsoleData()
  const saved = useMemo(() => agentAccessOf(computer), [computer])
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A save elsewhere, such as from an agent's page, or the periodic re-read, replaces an untouched form.
  const [base, setBase] = useState(saved)
  useEffect(() => {
    if (sameAccess(saved, base)) return
    setBase(saved)
    setDraft((current) => (sameAccess(current, base) ? saved : current))
  }, [saved, base])
  const editable = computer.canEditAgentAccess === true
  const dirty = !sameAccess(draft, saved)
  const emptySelection = draft.mode === 'selected' && draft.agents.length === 0

  const save = async () => {
    if (saving || emptySelection) return
    setSaving(true)
    setError(null)
    try {
      onSaved(await setComputerAgentAccess(computer.id, draft))
      // The agents' own Computers lists derive from this, so re-read them too.
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const options: ChoiceOption<Mode>[] = [
    { value: 'none', icon: 'ban', title: t('none'), description: t('noneDescription') },
    { value: 'selected', icon: 'bot', title: t('selected'), description: t('selectedDescription') },
    { value: 'all', icon: 'globe', title: t('all'), description: t('allDescription') }
  ]
  const pick = (mode: Mode) => setDraft((d) => ({ mode, agents: mode === 'selected' ? d.agents : [] }))
  const byId = new Map(agents.map((a) => [a.id, a]))
  const available = agents.filter((a) => !draft.agents.includes(a.id))
  const menu =
    editable && draft.mode === 'selected' ? (
      <AttachMenu
        ariaLabel={t('addAgent')}
        disabled={saving}
        actions={[]}
        groups={[
          {
            heading: t('agents'),
            icon: 'bot',
            emptyLabel: t('noMoreAgents'),
            options: available.map((a) => ({
              key: a.id,
              name: agentLabel(a),
              onPick: () => setDraft((d) => ({ mode: 'selected', agents: [...d.agents, a.id] }))
            }))
          }
        ]}
      />
    ) : undefined

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {!editable && (
          <span className="ml-auto font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {computer.allocation === 'per-agent' || computer.allocation === 'ephemeral'
              ? t('ownAgentOnly')
              : t('readOnly')}
          </span>
        )}
      </div>
      <div className="px-4 py-4">
        {isMobile ? (
          <ChoicePills value={draft.mode} onPick={pick} options={options} disabled={!editable || saving} />
        ) : (
          <ChoiceTiles value={draft.mode} onPick={pick} options={options} disabled={!editable || saving} />
        )}
        {draft.mode === 'all' && computer.kind === 'self-hosted' && (
          <p className="m-0 mt-3 flex items-start gap-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
            <span>{t('allNoIsolation')}</span>
          </p>
        )}
        {draft.mode === 'selected' && (
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-3">
              <span className="min-w-0 flex-1 font-sans text-[13px] font-semibold leading-normal">
                {t('selectedTitle')}
              </span>
              {menu}
            </div>
            {draft.agents.length === 0 ? (
              <AttachedEmpty title={t('pickAgent')} hint={t('pickAgentHint')} />
            ) : (
              <div className="overflow-hidden rounded-md border border-(--border-subtle)">
                {draft.agents.map((id) => (
                  <SelectedAgent
                    key={id}
                    agent={byId.get(id)}
                    id={id}
                    computer={computer}
                    onRemove={
                      editable && !saving
                        ? () => setDraft((d) => ({ mode: 'selected', agents: d.agents.filter((v) => v !== id) }))
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) px-4 py-3">
          {error && (
            <span role="alert" className="min-w-0 flex-1 font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
              {error}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
              {t('reset')}
            </Button>
            <Button size="sm" disabled={!dirty || saving || emptySelection} onClick={() => void save()}>
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SelectedAgent({
  agent,
  id,
  computer,
  onRemove
}: {
  agent: Agent | undefined
  id: string
  computer: ComputerDto
  onRemove?: () => void
}) {
  const t = useTranslations('Computers.agentAccess')
  // A self-hosted desktop has no isolation from the agents of another member (§4.1).
  const shared =
    computer.kind === 'self-hosted' &&
    agent !== undefined &&
    agent.createdBy !== '' &&
    agent.createdBy !== computer.ownerUserId
  return (
    <AttachedRow
      mark={
        <span className="flex h-7 w-7 flex-none overflow-hidden rounded-md">
          {agent ? (
            <AgentIconView icon={agent.icon} runtime={agent.runtime} size={28} />
          ) : (
            <Icon name="bot" size={18} />
          )}
        </span>
      }
      name={agent ? agentLabel(agent) : t('unknownAgent')}
      meta={agent ? agent.name : id}
      dimmed={!agent}
      badge={
        shared ? (
          <span
            className="inline-flex flex-none items-center gap-1 rounded-full bg-(--status-paused-soft) px-2 py-[1px] font-sans text-[11px] font-semibold leading-normal text-[#9a6500]"
            title={t('noIsolationHint')}
          >
            <Icon name="triangle-alert" size={12} />
            {t('noIsolation')}
          </span>
        ) : undefined
      }
      onRemove={onRemove}
      removeTitle={t('removeAgent')}
    />
  )
}
