'use client'

// Computers (computer-use.md §10): the organization's registered desktops, a section of the Infra page.
import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ComputerDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
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
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import { SectionHeader } from '@/components/console/SectionHeader'
import { FLEET_GRID, FLEET_ROW } from '@/components/console/fleet-grid'
import { AllocationBadge, useAgentName } from '@/components/console/ComputerPoolCards'
import { ComputerEgressCard, ComputerQuotasCard } from '@/components/console/ComputerPlanCards'

export function ComputersSection() {
  const t = useTranslations('Computers')
  const { data, error, isLoading } = useComputers()
  const { data: pool } = useComputerPool()
  const { openModal } = useModal()
  const computers = useMemo(() => data ?? [], [data])

  return (
    <>
      <SectionHeader
        id="computers"
        label={t('title')}
        count={isLoading && computers.length === 0 ? undefined : computers.length}
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
      {isLoading && computers.length === 0 ? (
        <LoadingState padding={24} />
      ) : computers.length === 0 ? (
        <div className="card px-4 py-[18px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {t('empty.description')}
        </div>
      ) : (
        <div className={FLEET_GRID}>
          {computers.map((c) => (
            <ComputerRow key={c.id} computer={c} />
          ))}
        </div>
      )}
      {/* Limits and egress apply to every Computer the organization adds, so they show before the first one too. */}
      <div className="mt-[14px] grid grid-cols-1 items-start gap-[14px] desktop:grid-cols-2">
        <ComputerQuotasCard />
        {pool?.enabled && <ComputerEgressCard />}
      </div>
    </>
  )
}

function ComputerRow({ computer }: { computer: ComputerDto }) {
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
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-sans text-[14px] font-semibold leading-normal desktop:text-[13.5px]">
              {computer.name}
            </span>
            <AllocationBadge computer={computer} />
          </div>
          <div className="mt-[2px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px]">
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
      <div className="flex min-w-0 items-center gap-[14px] font-sans text-[12px] font-medium leading-normal max-desktop:justify-between">
        {doctor.total === 0 ? (
          <span className="text-(--text-tertiary)">{t('doctor.notReported')}</span>
        ) : doctor.fail > 0 ? (
          <span className="text-(--status-error)">
            <Icon name="circle-x" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.failing', { count: doctor.fail })}
          </span>
        ) : doctor.warn > 0 ? (
          <span className="text-[#9a6500]">
            <Icon name="triangle-alert" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.warning', { count: doctor.warn })}
          </span>
        ) : (
          <span className="text-(--status-online)">
            <Icon name="circle-check" size={13} className="mr-[5px] inline align-[-2px]" />
            {t('doctor.healthy')}
          </span>
        )}
        {computer.lease ? (
          <span data-lease-holder={computer.lease.agentId} className="truncate text-(--status-info)">
            {t('inUseBy', { agent: agentName(computer.lease.agentId, computer.lease.agentName) })}
            {waiting > 0 && <> · {t('waitingCount', { count: waiting })}</>}
          </span>
        ) : (
          <span className="font-mono text-[11px] font-normal text-(--text-tertiary) desktop:text-right">
            {computer.status === 'revoked'
              ? t('revoked')
              : t('lastSeen', { when: computer.lastSeenAt ? ago(computer.lastSeenAt) : t('never') })}
          </span>
        )}
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
