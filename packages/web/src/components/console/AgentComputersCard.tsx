'use client'

// The agent setting for computer use (computer-use.md §4.1): turn it on and pick Computers; each Computer's policy must agree.
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { setComputerPolicy, type AgentComputerUse, type ComputerDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { computerStatusTone, useComputers } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { AttachedEmpty, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { Button, Icon, Toggle } from '@/components/ui'

const OFF: AgentComputerUse = { enabled: false, computers: [] }

const same = (a: AgentComputerUse, b: AgentComputerUse) =>
  a.enabled === b.enabled &&
  a.computers.length === b.computers.length &&
  a.computers.every((id, i) => b.computers[i] === id)

export function AgentComputersCard({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const t = useTranslations('Agents.detail.computers')
  const tc = useTranslations('Computers')
  const { getAgent, updateAgent } = useConsoleData()
  const { orgPath } = useOrgs()
  const { data: computers, error: listError, mutate } = useComputers()
  const stored = getAgent(agentId)?.computerUse ?? OFF
  // The agent list refreshes in the background after a save, so the saved value shows until it catches up.
  const [pending, setPending] = useState<AgentComputerUse | null>(null)
  const value = pending && !same(pending, stored) ? pending : stored
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (next: AgentComputerUse) => {
    if (saving || !canEdit) return
    setSaving(true)
    setError(null)
    try {
      await updateAgent(agentId, { computerUse: next })
      setPending(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  // The Computer's owner may grant the agent from here; anyone else has to ask them.
  const grant = async (computer: ComputerDto) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const policy = { ...computer.policy, allowedAgents: [...computer.policy.allowedAgents, agentId] }
      await setComputerPolicy(computer.id, policy)
      await mutate()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const live = (computers ?? []).filter((c) => c.status !== 'revoked')
  const available = live.filter((c) => !value.computers.includes(c.id))
  const menu =
    canEdit && value.enabled ? (
      <AttachMenu
        ariaLabel={t('add')}
        disabled={saving || !computers}
        actions={[]}
        groups={[
          {
            heading: t('available'),
            icon: 'monitor',
            emptyLabel: t('noMore'),
            options: available.map((c) => ({
              key: c.id,
              name: c.name,
              meta: c.os,
              onPick: () => void save({ ...value, computers: [...value.computers, c.id] })
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
        <div className="ml-auto flex items-center gap-2">
          {menu}
          <Toggle
            checked={value.enabled}
            disabled={!canEdit || saving}
            ariaLabel={t('enable')}
            onChange={(enabled) => void save({ ...value, enabled })}
          />
        </div>
      </div>
      {failure && (
        <div role="alert" className="px-4 py-3 text-[13px] text-(--status-error)">
          {failure}
        </div>
      )}
      {!value.enabled ? (
        <AttachedEmpty title={t('off')} hint={t('offHint')} />
      ) : value.computers.length === 0 ? (
        <AttachedEmpty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        value.computers.map((id) => {
          const computer = computers?.find((c) => c.id === id)
          const granted = computer?.policy.allowedAgents.includes(agentId) ?? false
          const tone = computer ? computerStatusTone(computer.status) : null
          return (
            <AttachedRow
              key={id}
              mark={<Icon name="monitor" size={18} />}
              name={computer?.name ?? t('unavailable')}
              meta={
                computer ? (
                  <>
                    <span style={{ color: tone?.text }}>{tc(`status.${computer.status}`)}</span>
                    {' · '}
                    {granted ? t('granted') : t('notGranted')}
                  </>
                ) : (
                  id
                )
              }
              dimmed={!computer}
              actions={
                computer ? (
                  <span className="flex flex-none items-center gap-2">
                    {!granted && computer.canEditPolicy && (
                      <Button variant="secondary" size="xs" disabled={saving} onClick={() => void grant(computer)}>
                        {t('grant')}
                      </Button>
                    )}
                    <Link
                      className="iconbtn"
                      href={orgPath(`/computers/${id}`)}
                      title={t('open')}
                      aria-label={t('open')}
                    >
                      <Icon name="arrow-up-right" size={15} />
                    </Link>
                  </span>
                ) : undefined
              }
              onRemove={
                canEdit && !saving
                  ? () => void save({ ...value, computers: value.computers.filter((v) => v !== id) })
                  : undefined
              }
              removeTitle={t('remove')}
            />
          )
        })
      )}
    </div>
  )
}
