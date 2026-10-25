'use client'

// Computers (computer-use.md §10): the deployment's managed computers and the organization's registered desktops, two sections of the Infra page.
import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ComputerDto } from '@/lib/api'
import { agentLabel, status } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useConsoleData } from '@/lib/data-context'
import {
  agentAccessOf,
  computerStatusTone,
  doctorCounts,
  poolPhaseNote,
  useComputerPool,
  useComputers,
  useAgo
} from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { useModal } from '@/components/console/ModalProvider'
import { KubernetesMark, LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import { SectionHeader } from '@/components/console/SectionHeader'
import { FLEET_GRID, FLEET_ROW } from '@/components/console/fleet-grid'
import { useAgentName } from '@/components/console/ComputerPoolCards'

export function ComputersSection() {
  const t = useTranslations('Computers')
  const { data, error, isLoading } = useComputers()
  const { data: pool } = useComputerPool()
  const { openModal } = useModal()
  const computers = useMemo(() => data ?? [], [data])
  // Managed computers are one pool entry in a section of their own, like the daemon pool; self-hosted ones are listed each.
  const managed = useMemo(() => computers.filter((c) => c.kind === 'managed'), [computers])
  const own = useMemo(() => computers.filter((c) => c.kind !== 'managed'), [computers])
  // Kept while managed computers remain, so a deployment that turned the pool off still reaches them.
  const showPool = pool?.enabled === true || managed.length > 0
  const loading = isLoading && computers.length === 0

  return (
    <>
      {showPool && <ManagedComputersSection managed={managed} available={pool?.available === true} />}
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

/** The deployment's managed computers, apart from the desktops members register themselves. */
function ManagedComputersSection({ managed, available }: { managed: ComputerDto[]; available: boolean }) {
  const t = useTranslations('Computers.poolEntry')
  const { openModal } = useModal()
  const title = useComputerPoolTitle()
  return (
    <>
      <SectionHeader
        id="managed-computers"
        label={title}
        count={managed.length}
        action={
          <button
            className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand)"
            onClick={() => openModal('poolComputer')}
          >
            <Icon name="plus" size={13} />
            {t('add')}
          </button>
        }
      />
      <p className="mt-0 mb-[10px] max-w-[720px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
        {t('description')}
      </p>
      <div className={FLEET_GRID}>
        <ComputerPoolEntry managed={managed} available={available} />
      </div>
    </>
  )
}

/** What the managed pool is called: AgentConnect's product on the managed install, the operator's cluster elsewhere. */
export function useComputerPoolTitle(): string {
  const t = useTranslations('Computers.poolEntry')
  return featureFlagEnabled('managed') ? t('managedTitle') : t('clusterTitle')
}

/** Running and asleep managed computers; one starting, failed or being removed is in neither. */
export function poolCounts(managed: ComputerDto[]): { running: number; asleep: number } {
  const asleep = managed.filter((c) => c.status === 'sleeping').length
  const running = managed.filter((c) => c.status !== 'sleeping' && c.status !== 'offline' && c.status !== 'revoked')
  return { running: running.length, asleep }
}

/** The managed pool as one entry, drawn like the daemon pool's card; its computers are listed on its own page. */
function ComputerPoolEntry({ managed, available }: { managed: ComputerDto[]; available: boolean }) {
  const t = useTranslations('Computers.poolEntry')
  const router = useRouter()
  const { orgPath } = useOrgs()
  const title = useComputerPoolTitle()
  const managedInstall = featureFlagEnabled('managed')
  const s = status(available ? 'online' : 'offline')
  const { running, asleep } = poolCounts(managed)
  const meta = managed.length === 0 ? t('none') : t('meta', { running, asleep })
  const statusLabel = available ? t('available') : t('unavailable')
  const open = () => router.push(orgPath('/computers/pool'))
  return (
    <div
      role="link"
      tabIndex={0}
      data-computer-pool
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
      }}
      className={`card click flex cursor-pointer items-center gap-3 p-[14px] max-desktop:rounded-lg desktop:gap-[14px] desktop:px-4 desktop:py-[13px] ${FLEET_ROW}`}
    >
      <span
        className={`relative flex h-10 w-10 flex-none items-center justify-center rounded-md desktop:h-[38px] desktop:w-[38px] desktop:rounded-[9px] ${
          managedInstall ? 'bg-(--brand-soft)' : 'border border-(--border-subtle) bg-(--surface-sunken)'
        }`}
      >
        {managedInstall ? (
          <Icon name="cloud" size={19} color={available ? 'var(--brand)' : 'var(--text-tertiary)'} />
        ) : (
          <span className="flex h-[19px] w-[19px]">
            <KubernetesMark />
          </span>
        )}
        <span
          className="absolute -right-[3px] -bottom-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card)"
          style={{ background: s.dot }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-sans text-[14px] font-semibold leading-normal desktop:text-[13.5px]">{title}</div>
        <div className="mt-[2px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px]">
          {meta}
        </div>
      </div>
      <div className="hidden flex-none text-right desktop:block">
        <div className="mono text-[14px] leading-normal font-semibold">{managed.length}</div>
        <div className="font-sans text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('countLabel')}
        </div>
      </div>
      <span
        className="badge flex-none max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]"
        style={{ background: s.bg, color: s.text }}
      >
        {statusLabel}
      </span>
      <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="desktop:hidden" />
    </div>
  )
}

export function ComputerRow({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers')
  const ago = useAgo()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const { agents } = useConsoleData()
  const agentName = useAgentName()
  const tone = computerStatusTone(computer.status)
  const poolNote = poolPhaseNote(computer)
  const statusLabel = poolNote ? t(`poolPhase.${poolNote}`) : t(`status.${computer.status}`)
  const waiting = computer.waiting?.length ?? 0
  const doctor = doctorCounts(computer)
  const access = agentAccessOf(computer)
  const granted = access.agents.map((id) => agents.find((a) => a.id === id)).filter((a) => a !== undefined)
  const accessText =
    computer.ownerAgentId && computer.allocation !== 'manual'
      ? t('madeFor', { agent: agentName(computer.ownerAgentId) })
      : access.mode === 'all'
        ? t('allAgents')
        : granted.length === 0
          ? t('noAgents')
          : granted.length <= 2
            ? granted.map((a) => agentLabel(a)).join(', ')
            : t('agentCount', { count: granted.length })
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
      className={`card click flex cursor-pointer flex-col gap-[10px] p-[14px] max-desktop:rounded-lg desktop:flex-row desktop:items-center desktop:gap-[14px] desktop:px-4 desktop:py-[13px] ${FLEET_ROW}`}
    >
      <div className="flex w-full min-w-0 items-center gap-3 desktop:w-auto desktop:flex-1 desktop:gap-[11px]">
        <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken) desktop:h-[38px] desktop:w-[38px] desktop:rounded-[9px]">
          <Icon
            name="monitor"
            size={19}
            color={
              computer.status === 'offline' || computer.status === 'revoked'
                ? 'var(--text-tertiary)'
                : 'var(--text-secondary)'
            }
          />
          <span
            className="absolute -right-[3px] -bottom-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card)"
            style={{ background: tone.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-[14px] font-semibold leading-normal desktop:text-[13.5px]">
            {computer.name}
          </div>
          {/* The allocation rides in the meta line: a pill beside the name left it no width at the grid's 470px floor. */}
          <div className="mt-[2px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px]">
            {computer.allocation && `${t(`allocation.${computer.allocation}`)} · `}
            {t(`os.${computer.os}`)} · {t(`session.${computer.session}`)} · {accessText}
          </div>
        </div>
        <span
          className="badge flex-none px-[10px] py-[3px] text-[12px] desktop:hidden"
          style={{ background: tone.bg, color: tone.text }}
        >
          {statusLabel}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-[14px] font-sans text-[12px] font-medium leading-normal desktop:flex-none">
        {/* Checks over last seen in one fixed column; passing checks say nothing, since green read as a ready computer. */}
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 desktop:w-[128px] desktop:flex-none desktop:flex-col desktop:items-end desktop:justify-center desktop:gap-[3px]">
          {doctor.total === 0 ? (
            <span className="max-w-full truncate text-(--text-tertiary)">{t('doctor.notReported')}</span>
          ) : doctor.fail > 0 ? (
            <span className="max-w-full truncate text-(--status-error)">
              <Icon name="circle-x" size={13} className="mr-[5px] inline align-[-2px]" />
              {t('doctor.failing', { count: doctor.fail })}
            </span>
          ) : doctor.warn > 0 ? (
            <span className="max-w-full truncate text-[#9a6500]">
              <Icon name="triangle-alert" size={13} className="mr-[5px] inline align-[-2px]" />
              {t('doctor.warning', { count: doctor.warn })}
            </span>
          ) : null}
          {computer.lease ? (
            <span data-lease-holder={computer.lease.agentId} className="max-w-full truncate text-(--status-info)">
              {t('inUseBy', { agent: agentName(computer.lease.agentId, computer.lease.agentName) })}
              {waiting > 0 && <> · {t('waitingCount', { count: waiting })}</>}
            </span>
          ) : (
            <span className="max-w-full truncate font-mono text-[11px] font-normal text-(--text-tertiary)">
              {computer.status === 'revoked'
                ? t('revoked')
                : t('lastSeen', { when: computer.lastSeenAt ? ago(computer.lastSeenAt) : t('never') })}
            </span>
          )}
        </div>
        <span className="hidden w-24 flex-none items-center gap-[7px] desktop:flex">
          <span className="dot" style={{ background: tone.dot }} />
          <span className="truncate font-sans text-[12.5px] font-medium leading-normal" style={{ color: tone.text }}>
            {statusLabel}
          </span>
        </span>
      </div>
    </div>
  )
}
