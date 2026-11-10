'use client'

// Computers (computer-use.md §10): the deployment's cloud computers and the organization's registered desktops, two sections of the Infra page.
import { useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import type { ComputerDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import {
  agentAccessOf,
  computerStatusTone,
  doctorCounts,
  poolPhaseNote,
  useComputerPool,
  useComputers
} from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { useModal } from '@/components/console/ModalProvider'
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import { SectionHeader } from '@/components/console/SectionHeader'
import { FLEET_GRID } from '@/components/console/fleet-grid'
import { useAgentName, useMemberName } from '@/components/console/computer-members'

export function ComputersSection() {
  const t = useTranslations('Computers')
  const { data, error, isLoading } = useComputers()
  const { data: pool } = useComputerPool()
  const { openModal } = useModal()
  const computers = useMemo(() => data ?? [], [data])
  const managed = useMemo(() => computers.filter((c) => c.kind === 'managed'), [computers])
  const own = useMemo(() => computers.filter((c) => c.kind !== 'managed'), [computers])
  // Kept while managed computers remain, so a deployment that turned the pool off still reaches them.
  const showPool = pool?.enabled === true || managed.length > 0
  const loading = isLoading && computers.length === 0

  return (
    <>
      {showPool && (
        <CloudComputersSection
          managed={managed}
          enabled={pool?.enabled === true}
          available={pool?.available === true}
        />
      )}
      <SectionHeader
        id="computers"
        label={t('title')}
        count={loading ? undefined : own.length}
        action={
          <button
            className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand)"
            onClick={() => openModal('computer')}
          >
            <Icon name="plus" size={13} />
            {t('addComputer')}
          </button>
        }
      />
      <p className="mt-0 mb-[10px] max-w-[720px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
        {t('description')}
      </p>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
        >
          {t('loadError', { message: error instanceof Error ? error.message : String(error) })}
        </div>
      )}
      {loading ? (
        <LoadingState padding={24} />
      ) : own.length === 0 ? (
        <div className="card px-4 py-[18px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {t('empty.description')}
        </div>
      ) : (
        <div className={FLEET_GRID}>
          {own.map((c) => (
            <ComputerRow key={c.id} computer={c} />
          ))}
        </div>
      )}
    </>
  )
}

/** The deployment's managed computers, listed each above the desktops members register themselves. */
function CloudComputersSection({
  managed,
  enabled,
  available
}: {
  managed: ComputerDto[]
  enabled: boolean
  available: boolean
}) {
  const t = useTranslations('Computers.cloud')
  const { openModal } = useModal()
  const { running, asleep } = poolCounts(managed)
  return (
    <>
      <SectionHeader
        id="cloud-computers"
        label={t('title')}
        count={managed.length}
        action={
          enabled && (
            <button
              className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand)"
              onClick={() => openModal('poolComputer')}
            >
              <Icon name="plus" size={13} />
              {t('add')}
            </button>
          )
        }
      />
      <p className="mt-0 mb-[10px] max-w-[720px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
        {t('description')}
        {(managed.length > 0 || (enabled && !available)) && (
          <span
            data-cloud-summary
            className="ml-[6px] font-mono text-[11.5px] whitespace-nowrap text-(--text-secondary)"
          >
            {managed.length > 0 && t('meta', { running, asleep })}
            {managed.length > 0 && enabled && !available && ' · '}
            {enabled && !available && <span className="text-(--status-error)">{t('unavailable')}</span>}
          </span>
        )}
      </p>
      {managed.length === 0 ? (
        <div className="card mb-6 px-4 py-[18px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {t('empty')}
        </div>
      ) : (
        <div className={FLEET_GRID}>
          {managed.map((c) => (
            <ComputerRow key={c.id} computer={c} />
          ))}
        </div>
      )}
    </>
  )
}

/** Running and asleep managed computers; one starting, failed or being removed is in neither. */
function poolCounts(managed: ComputerDto[]): { running: number; asleep: number } {
  const asleep = managed.filter((c) => c.status === 'sleeping').length
  const running = managed.filter((c) => c.status !== 'sleeping' && c.status !== 'offline' && c.status !== 'revoked')
  return { running: running.length, asleep }
}

/** A compact elapsed time ("2h"), for how long a cloud computer has slept. */
function useElapsed(): (iso: string) => string {
  const format = useFormatter()
  return useCallback(
    (iso: string) => {
      const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
      const [value, unit] =
        seconds < 60
          ? [seconds, 'second']
          : seconds < 3600
            ? [seconds / 60, 'minute']
            : seconds < 86400
              ? [seconds / 3600, 'hour']
              : [seconds / 86400, 'day']
      return format.number(Math.floor(value), { style: 'unit', unit, unitDisplay: 'narrow' })
    },
    [format]
  )
}

export function ComputerRow({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers')
  const format = useFormatter()
  const elapsed = useElapsed()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const { agents } = useConsoleData()
  const { me } = useProfile()
  const agentName = useAgentName()
  const memberName = useMemberName()
  const cloud = computer.kind === 'managed'
  const tone = computerStatusTone(computer.status)
  const poolNote = poolPhaseNote(computer)
  const statusLabel = poolNote
    ? t(`poolPhase.${poolNote}`)
    : cloud && computer.status === 'online'
      ? t('cloud.running')
      : t(`status.${computer.status}`)
  const dimmed = computer.status === 'offline' || computer.status === 'revoked'
  const waiting = computer.waiting?.length ?? 0
  const doctor = doctorCounts(computer)
  const access = agentAccessOf(computer)
  const granted = access.agents.map((id) => agents.find((a) => a.id === id)).filter((a) => a !== undefined)
  // A cloud computer names who made it, an agent's own or a member's; a registered one names the agents it admits.
  const byAgent = cloud && computer.ownerAgentId && computer.allocation !== 'manual' ? computer.ownerAgentId : null
  const accessText = byAgent
    ? t('cloud.by', { name: agentName(byAgent) })
    : cloud
      ? computer.ownerUserId === me?.userId
        ? t('cloud.byYou')
        : t('cloud.by', { name: memberName(computer.ownerUserId) })
      : access.mode === 'all'
        ? t('allAgents')
        : granted.length === 0
          ? t('noAgents')
          : granted.length <= 2
            ? granted.map((a) => agentLabel(a)).join(', ')
            : t('agentCount', { count: granted.length })
  const seen = computer.lastSeenAt
    ? computer.status === 'sleeping'
      ? t('cloud.idle', { when: elapsed(computer.lastSeenAt) })
      : format.relativeTime(new Date(computer.lastSeenAt), { now: Date.now(), style: 'narrow' })
    : t('lastSeen', { when: t('never') })
  const open = () => router.push(orgPath(`/computers/${computer.id}`))
  return (
    <div
      role="link"
      tabIndex={0}
      data-computer-row={computer.id}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
      }}
      className={`card click flex cursor-pointer flex-col gap-[10px] p-[14px] max-desktop:rounded-lg desktop:flex-row desktop:items-center desktop:gap-[14px] desktop:min-h-[68px] desktop:px-4 desktop:py-[11px]`}
    >
      <div className="flex w-full min-w-0 items-center gap-3 desktop:w-auto desktop:flex-1 desktop:gap-[11px]">
        <span
          className={`relative flex h-10 w-10 flex-none items-center justify-center rounded-md desktop:h-9 desktop:w-9 desktop:rounded-[8px] ${
            cloud ? 'bg-(--brand-soft)' : 'border border-(--border-subtle) bg-(--surface-sunken)'
          }`}
        >
          <Icon
            name="monitor"
            size={19}
            color={cloud ? 'var(--brand)' : dimmed ? 'var(--text-tertiary)' : 'var(--text-secondary)'}
          />
          <span
            className="absolute -right-[2px] -bottom-[2px] h-[9px] w-[9px] rounded-full shadow-[0_0_0_2px_var(--surface-card)]"
            style={{ background: tone.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14px] font-semibold leading-normal desktop:text-[13.5px]">
            {computer.name}
          </div>
          <div className="mt-[2px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px]">
            {t(`os.${computer.os}`)} · {t(`session.${computer.session}`)} ·{' '}
            {byAgent && <Icon name="bot" size={12} className="mr-[3px] inline align-[-2px]" />}
            {accessText}
          </div>
        </div>
        <span
          className="badge flex-none px-[10px] py-[3px] text-[12px] desktop:hidden"
          style={{ background: tone.bg, color: tone.text }}
        >
          {statusLabel}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-[14px] font-sans text-[12px] font-medium leading-normal desktop:flex-none desktop:justify-end">
        {/* Cloud checks are the pool's, so only problems show; an offline computer's old passes read as nothing. */}
        {doctor.fail > 0 ? (
          <span className="min-w-0 truncate text-(--status-error)">
            <Icon name="circle-x" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.failing', { count: doctor.fail })}
          </span>
        ) : doctor.warn > 0 ? (
          <span className="min-w-0 truncate text-[#9a6500]">
            <Icon name="triangle-alert" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.warning', { count: doctor.warn })}
          </span>
        ) : cloud ? null : doctor.total === 0 ? (
          <span className="min-w-0 truncate text-(--text-tertiary)">
            <Icon name="circle-minus" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.none')}
          </span>
        ) : dimmed ? null : (
          <span className="min-w-0 truncate text-(--status-online)" data-doctor-pass>
            <Icon name="circle-check" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.allPass')}
          </span>
        )}
        {/* Who holds it rides in the tooltip, so every row reads the same: checks, last seen, status. */}
        <span
          className={
            computer.lease
              ? 'flex-none font-mono text-[11px] font-normal text-(--status-info)'
              : 'flex-none font-mono text-[11px] font-normal text-(--text-tertiary)'
          }
          title={
            computer.lease
              ? [
                  t('inUseBy', { agent: agentName(computer.lease.agentId, computer.lease.agentName) }),
                  waiting > 0 ? t('waitingCount', { count: waiting }) : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
          data-lease-holder={computer.lease?.agentId}
        >
          {computer.status === 'revoked' ? t('revoked') : seen}
        </span>
        <span className="hidden min-w-16 flex-none items-center gap-[7px] desktop:flex">
          <span className="dot" style={{ background: tone.dot }} />
          <span className="truncate font-sans text-[12.5px] font-medium leading-normal" style={{ color: tone.text }}>
            {statusLabel}
          </span>
        </span>
      </div>
    </div>
  )
}
