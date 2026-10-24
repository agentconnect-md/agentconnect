'use client'

// The Computers an agent may use (computer-use.md §4.1), given and taken away only here, and its managed computer mode (§15.1).
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { addComputerAgent, removeComputerAgent, updateAgent, type ComputerDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import {
  agentAccessOf,
  agentOwnComputers,
  computerGrantsAgent,
  computerStatusTone,
  poolPhaseNote,
  useComputerPool,
  useComputers
} from '@/lib/computers'
import { useIsMobile } from '@/lib/use-is-mobile'
import { ChoicePills, ChoiceTiles, type ChoiceOption } from '@/components/console/VisibilityField'
import { useOrgs } from '@/lib/org-context'
import { AttachedEmpty, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { Icon } from '@/components/ui'

export function AgentComputersCard({
  agentId,
  canEdit,
  canEditAgent = false
}: {
  agentId: string
  canEdit: boolean
  /** The member may change the agent itself, which is where its managed mode lives. */
  canEditAgent?: boolean
}) {
  const t = useTranslations('Agents.detail.computers')
  const tc = useTranslations('Computers')
  const { getAgent, refresh } = useConsoleData()
  const { orgPath } = useOrgs()
  const { data: computers, error: listError, mutate } = useComputers()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const live = (computers ?? []).filter((c) => c.status !== 'revoked')
  const visible = new Set((computers ?? []).map((c) => c.id))
  // The agent's own managed computers show in the managed section, whatever its mode, not as granted ones.
  const own = new Set(agentOwnComputers(computers ?? [], agentId).map((c) => c.id))
  // A Computer the caller can see answers for itself; the agent's derived list adds the ones they cannot.
  const granting = live.filter((c) => computerGrantsAgent(c, agentId) && !own.has(c.id))
  const hidden = (getAgent(agentId)?.computerUse?.computers ?? []).filter((id) => !visible.has(id))
  const addable = live.filter((c) => c.canEditAgentAccess === true && !computerGrantsAgent(c, agentId))

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
      <ManagedComputer agentId={agentId} canEdit={canEditAgent} computers={computers ?? []} />
      {granting.length === 0 && hidden.length === 0 ? (
        <AttachedEmpty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <>
          {granting.map((computer) => {
            const tone = computerStatusTone(computer.status)
            const all = agentAccessOf(computer).mode === 'all'
            // Taking an All agents Computer away leaves it with every other agent.
            const removable = canEdit && !saving && computer.canEditAgentAccess === true
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

type ManagedMode = 'off' | 'ephemeral' | 'per-agent'

/** The agent's managed computer mode and the desktop it has from the pool (§15.1). */
function ManagedComputer({
  agentId,
  canEdit,
  computers
}: {
  agentId: string
  canEdit: boolean
  computers: readonly ComputerDto[]
}) {
  const t = useTranslations('Agents.detail.computers.managed')
  const tc = useTranslations('Computers')
  const isMobile = useIsMobile()
  const { orgPath } = useOrgs()
  const { getAgent, refresh } = useConsoleData()
  const { data: pool } = useComputerPool()
  const [saving, setSaving] = useState<ManagedMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mode: ManagedMode = getAgent(agentId)?.computerUse?.managed?.mode ?? 'off'
  const own = agentOwnComputers(computers, agentId)
  // Shown where the pool runs, or where an agent still carries a mode or a desktop from an earlier setup.
  if (!pool?.enabled && mode === 'off' && own.length === 0) return null
  const desktop = own.find((c) => c.allocation === 'per-agent')
  const sessions = own.filter((c) => c.allocation === 'ephemeral').length
  const shown = saving ?? mode

  const pick = async (next: ManagedMode) => {
    if (saving || !canEdit || next === mode) return
    setSaving(next)
    setError(null)
    try {
      await updateAgent(agentId, { computerUse: next === 'off' ? null : { managed: { mode: next } } })
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const options: ChoiceOption<ManagedMode>[] = [
    { value: 'off', icon: 'ban', title: t('off'), description: t('offDescription') },
    { value: 'ephemeral', icon: 'sparkles', title: t('ephemeral'), description: t('ephemeralDescription') },
    { value: 'per-agent', icon: 'hard-drive', title: t('perAgent'), description: t('perAgentDescription') }
  ]
  return (
    <div className="border-b border-(--border-subtle) px-4 py-4" data-managed-mode={mode}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-sans text-[13px] font-semibold leading-normal">{t('title')}</span>
        {!canEdit && (
          <span className="ml-auto font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {t('readOnly')}
          </span>
        )}
      </div>
      <p className="m-0 mb-3 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
        {t('description')}
      </p>
      {isMobile ? (
        <ChoicePills
          value={shown}
          onPick={(v) => void pick(v)}
          options={options}
          disabled={!canEdit || saving !== null}
        />
      ) : (
        <ChoiceTiles
          value={shown}
          onPick={(v) => void pick(v)}
          options={options}
          disabled={!canEdit || saving !== null}
        />
      )}
      {!pool?.enabled && (
        <p className="m-0 mt-3 flex items-start gap-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
          <span>{t('poolOff')}</span>
        </p>
      )}
      {error && (
        <div role="alert" className="mt-3 font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
          {error}
        </div>
      )}
      {(mode === 'per-agent' || desktop) && (
        <div
          className="mt-3 overflow-hidden rounded-md border border-(--border-subtle)"
          data-agent-desktop={desktop?.id ?? ''}
        >
          {desktop ? (
            <AttachedRow
              mark={<Icon name="monitor" size={18} />}
              name={desktop.name}
              meta={
                <span style={{ color: computerStatusTone(desktop.status).text }}>
                  {poolPhaseNote(desktop) ? tc(`poolPhase.${poolPhaseNote(desktop)!}`) : tc(`status.${desktop.status}`)}
                </span>
              }
              actions={
                <Link
                  className="iconbtn flex-none"
                  href={orgPath(`/computers/${desktop.id}`)}
                  title={tc('add.open')}
                  aria-label={tc('add.open')}
                >
                  <Icon name="arrow-up-right" size={15} />
                </Link>
              }
            />
          ) : (
            <div className="px-3 py-[10px] font-sans text-[12.5px] text-(--text-tertiary)">{t('notCreated')}</div>
          )}
          {desktop && mode !== 'per-agent' && (
            <p className="m-0 border-t border-(--border-subtle) px-3 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              {t('leftover')}
            </p>
          )}
        </div>
      )}
      {sessions > 0 && (
        <p className="m-0 mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('sessions', { count: sessions })}
        </p>
      )}
    </div>
  )
}
