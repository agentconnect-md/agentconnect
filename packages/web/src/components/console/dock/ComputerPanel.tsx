'use client'

// The session dock's Computer tab: watch, expand and take control of a Computer the focused agent may use (computer-use.md §10).
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { fetchComputer, fetchComputers, type ComputerDto } from '@/lib/api'
import { agentOwnComputers } from '@/lib/computers'
import { ComputerViewerScreen, type ComputerViewerProps } from '@/components/console/ComputerViewer'
import { Button, Icon } from '@/components/ui'

export interface ComputerPanelProps {
  // The focused agent's Computers; ones this member cannot see drop out.
  computerIds: readonly string[]
  // Set when the agent takes a managed computer from the pool: its own kept one, or this session's fresh one (§15.1).
  managed?: { agentId: string; sessionId: string | null }
  // The screen streams only while the tab is shown.
  active: boolean
  createSession?: ComputerViewerProps['createSession']
}

const REFRESH_MS = 15_000

const NOTE = 'px-3 py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)'

// The pool computers that belong to this agent in this session; access grants never list them.
const managedOf = (all: readonly ComputerDto[], agentId: string, sessionId: string | null) =>
  agentOwnComputers(all, agentId).filter(
    (c) => c.allocation === 'per-agent' || (sessionId !== null && c.poolSessionId === sessionId)
  )

export function ComputerPanel({ computerIds, managed, active, createSession }: ComputerPanelProps) {
  const t = useTranslations('Sessions.detail')
  const tv = useTranslations('Computers.viewer')
  const [computers, setComputers] = useState<ComputerDto[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const key = computerIds.join(',')
  const managedAgentId = managed?.agentId ?? null
  const managedSessionId = managed?.sessionId ?? null

  // Read on showing and then every 15 s while shown, so a computer coming online, or a failed read, recovers in place.
  useEffect(() => {
    if (!active) return
    let live = true
    const ids = key ? key.split(',') : []
    const read = () =>
      void Promise.all([
        Promise.all(
          ids.map((id) =>
            fetchComputer(id).then(
              (computer): { id: string; computer: ComputerDto | null } => ({ id, computer }),
              () => ({ id, computer: null })
            )
          )
        ),
        managedAgentId
          ? fetchComputers().then(
              (all) => managedOf(all, managedAgentId, managedSessionId),
              () => null
            )
          : Promise.resolve([])
      ]).then(([found, pooled]) => {
        if (!live) return
        // A failed read keeps what the last good one saw: the viewer on screen must not vanish over a blip.
        setComputers((previous) => [
          ...found.flatMap(({ id, computer }) => {
            const kept = computer ?? previous?.find((candidate) => candidate.id === id)
            return kept ? [kept] : []
          }),
          ...(pooled ?? previous?.filter((c) => c.ownerAgentId === managedAgentId && !ids.includes(c.id)) ?? [])
        ])
      })
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [key, managedAgentId, managedSessionId, active])

  // Leaving the tab stops the stream, so a hidden panel spends no bandwidth.
  useEffect(() => {
    if (!active) setWatching(false)
  }, [active])

  if (computers === null) return <div className={NOTE}>{tv('connecting')}</div>
  if (computers.length === 0) return <div className={NOTE}>{t(managed ? 'computerOnDemand' : 'computerNone')}</div>
  const computer = computers.find((candidate) => candidate.id === selected) ?? computers[0]!
  const watchable = computer.status !== 'revoked' && computer.status !== 'offline'

  return (
    <div className="flex min-h-0 flex-col" data-computer-panel>
      <div className="flex items-center gap-2 border-b border-(--border-subtle) px-3 py-[7px]">
        <Icon name="monitor" size={14} />
        {computers.length > 1 ? (
          <select
            className="inp min-w-0 flex-1"
            aria-label={t('computerPick')}
            value={computer.id}
            onChange={(event) => {
              setSelected(event.target.value)
              setWatching(false)
            }}
          >
            {computers.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
            {computer.name}
          </span>
        )}
        <span className="font-mono text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {computer.status}
        </span>
        {watching ? (
          <Button variant="secondary" size="sm" onClick={() => setWatching(false)}>
            <Icon name="x" size={14} />
            {tv('close')}
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={!watchable} onClick={() => setWatching(true)}>
            <Icon name="monitor-play" size={14} />
            {tv('watch')}
          </Button>
        )}
      </div>
      {watching && active ? (
        <ComputerViewerScreen
          key={computer.id}
          computer={computer}
          compact
          {...(createSession ? { createSession } : {})}
        />
      ) : (
        <div className={NOTE}>{watchable ? tv('idle') : tv('offline')}</div>
      )}
    </div>
  )
}
