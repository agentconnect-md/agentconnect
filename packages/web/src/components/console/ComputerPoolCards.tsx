'use client'

// A managed computer's pool state with wake / sleep / reset (computer-use.md §10, §15.1), and who has control or waits (§4.4).
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { resetComputer, sleepComputer, wakeComputer, type ComputerDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useAgo } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { Button, Icon } from '@/components/ui'

/** The agent's name, or a neutral label for one the caller cannot see. */
export function useAgentName(): (agentId: string | null | undefined, fallback?: string | null) => string {
  const t = useTranslations('Computers')
  const { agents } = useConsoleData()
  return (agentId, fallback) => {
    const agent = agentId ? agents.find((a) => a.id === agentId) : undefined
    return agent ? agentLabel(agent) : (fallback ?? t('hiddenAgent'))
  }
}

/** A small mark naming how a managed computer is allocated; nothing for a self-hosted one. */
export function AllocationBadge({ computer }: { computer: Pick<ComputerDto, 'allocation'> }) {
  const t = useTranslations('Computers.allocation')
  if (!computer.allocation) return null
  return (
    <span className="inline-flex flex-none items-center gap-1 rounded-full border border-(--border-subtle) px-2 py-[1px] font-sans text-[11px] font-medium leading-normal text-(--text-secondary)">
      <Icon name={computer.allocation === 'manual' ? 'server' : 'bot'} size={11} />
      {t(computer.allocation)}
    </span>
  )
}

type PoolAction = 'wake' | 'sleep' | 'reset'

export function ComputerPoolCard({
  computer,
  onChanged
}: {
  computer: ComputerDto
  onChanged: (next: ComputerDto) => void
}) {
  const t = useTranslations('Computers.pool')
  const tc = useTranslations('Computers')
  const agentName = useAgentName()
  const [busy, setBusy] = useState<PoolAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  if (!computer.allocation) return null
  const actions = computer.poolActions ?? { wake: false, sleep: false, reset: false }

  const run = async (action: PoolAction) => {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      const call = action === 'wake' ? wakeComputer : action === 'sleep' ? sleepComputer : resetComputer
      onChanged(await call(computer.id))
      setConfirmReset(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const owner = agentName(computer.ownerAgentId)
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg" data-pool-card>
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        <AllocationBadge computer={computer} />
      </div>
      <p className="m-0 px-4 pt-3 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
        {t(`hint.${computer.allocation}`, { agent: owner })}
      </p>
      <div className="py-[6px]">
        <Line label={tc('detail.allocation')}>{tc(`detail.allocationValue.${computer.allocation}`)}</Line>
        {computer.ownerAgentId && <Line label={tc('detail.ownerAgent')}>{owner}</Line>}
        <Line label={t('phase')}>
          <span data-pool-phase={computer.poolPhase ?? ''}>
            {computer.poolPhase ? tc(`poolPhase.${computer.poolPhase}`) : '—'}
          </span>
        </Line>
        {computer.poolError && (
          <Line label={t('error')}>
            <span className="text-(--status-error)">{computer.poolError}</span>
          </Line>
        )}
      </div>
      {(actions.wake || actions.sleep || actions.reset) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) px-4 py-3 max-desktop:[&>button]:h-10 max-desktop:[&>button]:flex-1">
          {error && (
            <span
              role="alert"
              className="w-full min-w-0 font-sans text-[12.5px] leading-[1.5] text-(--status-error) desktop:w-auto desktop:flex-1"
            >
              {error}
            </span>
          )}
          {actions.wake && (
            <Button size="sm" disabled={busy !== null} onClick={() => void run('wake')}>
              <Icon name="sunrise" size={15} />
              {t('wake')}
            </Button>
          )}
          {actions.sleep && (
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void run('sleep')}>
              <Icon name="moon" size={15} />
              {t('sleep')}
            </Button>
          )}
          {actions.reset && (
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmReset(true)}>
              <Icon name="rotate-ccw" size={15} />
              {t('reset')}
            </Button>
          )}
        </div>
      )}
      {confirmReset && (
        <ConfirmationDialog
          title={t('resetTitle')}
          confirmLabel={t('resetConfirm')}
          busyLabel={t('resetBusy')}
          busy={busy === 'reset'}
          error={error}
          destructive
          onConfirm={() => void run('reset')}
          onClose={() => setConfirmReset(false)}
        >
          {t('resetBody', { name: computer.name })}
        </ConfirmationDialog>
      )}
    </div>
  )
}

/** Who has control of the desktop now and who waits in line (§4.4); shown for every Computer an agent may share. */
export function ComputerLeaseCard({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers.lease')
  const ago = useAgo()
  const { orgPath } = useOrgs()
  const agentName = useAgentName()
  const lease = computer.lease ?? null
  const waiting = computer.waiting ?? []
  const session = (sessionId: string) => (
    <Link
      className="iconbtn flex-none"
      href={orgPath(`/sessions/${encodeURIComponent(sessionId)}`)}
      title={t('openSession')}
      aria-label={t('openSession')}
    >
      <Icon name="arrow-up-right" size={15} />
    </Link>
  )
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg" data-lease-card>
      <div className="cardhead">
        <span className="cardtitle">{t('title')}</span>
      </div>
      <p className="m-0 px-4 pt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        {t('note')}
      </p>
      <div className="px-4 py-3">
        {lease ? (
          <div className="flex items-center gap-3" data-lease-holder={lease.agentId}>
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--status-info-soft)">
              <Icon name="mouse-pointer-2" size={16} color="var(--status-info)" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-sans text-[13px] font-semibold leading-normal">
                {agentName(lease.agentId, lease.agentName)}
              </div>
              <div className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {t('holder')} · {t('since', { when: ago(lease.acquiredAt) })}
              </div>
            </div>
            {session(lease.sessionId)}
          </div>
        ) : (
          <div className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{t('free')}</div>
        )}
        {waiting.length > 0 && (
          <>
            <div className="mt-4 mb-2 font-sans text-[12px] font-semibold leading-normal text-(--text-tertiary)">
              {t('queue')}
            </div>
            <ol className="m-0 list-none overflow-hidden rounded-md border border-(--border-subtle) p-0">
              {waiting.map((w, i) => (
                <li
                  key={`${w.agentId}/${w.sessionId}`}
                  data-lease-waiter={w.agentId}
                  className="flex items-center gap-3 border-b border-(--border-subtle) px-3 py-[9px] last:border-b-0"
                >
                  <span className="w-5 flex-none text-center font-mono text-[12px] text-(--text-tertiary)">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-sans text-[13px] font-medium leading-normal">
                      {agentName(w.agentId)}
                    </div>
                    <div className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {t('queued', { when: ago(w.since) })}
                    </div>
                  </div>
                  {session(w.sessionId)}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row grid-cols-[auto_1fr] gap-3">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span className="min-w-0 text-right font-sans text-[12.5px] font-medium leading-normal">{children}</span>
    </div>
  )
}
