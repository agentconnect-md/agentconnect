'use client'

// The session dock's Computer tab: watch, expand and take control of a Computer the focused agent may use (computer-use.md §10).
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { fetchComputer, type ComputerDto } from '@/lib/api'
import { ComputerViewerScreen, type ComputerViewerProps } from '@/components/console/ComputerViewer'
import { Button, Icon } from '@/components/ui'

export interface ComputerPanelProps {
  // The focused agent's Computers; ones this member cannot see drop out.
  computerIds: readonly string[]
  // The screen streams only while the tab is shown.
  active: boolean
  createSession?: ComputerViewerProps['createSession']
}

const NOTE = 'px-3 py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)'

export function ComputerPanel({ computerIds, active, createSession }: ComputerPanelProps) {
  const t = useTranslations('Sessions.detail')
  const tv = useTranslations('Computers.viewer')
  const [computers, setComputers] = useState<ComputerDto[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const key = computerIds.join(',')

  // Keyed by the ids' content, not the array's identity, so a re-render does not refetch.
  useEffect(() => {
    let live = true
    setComputers(null)
    const ids = key ? key.split(',') : []
    void Promise.all(ids.map((id) => fetchComputer(id).catch(() => null))).then((found) => {
      if (live) setComputers(found.filter((computer): computer is ComputerDto => computer !== null))
    })
    return () => {
      live = false
    }
  }, [key])

  // Leaving the tab stops the stream, so a hidden panel spends no bandwidth.
  useEffect(() => {
    if (!active) setWatching(false)
  }, [active])

  if (computers === null) return <div className={NOTE}>{tv('connecting')}</div>
  if (computers.length === 0) return <div className={NOTE}>{t('computerNone')}</div>
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
