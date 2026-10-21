'use client'

// Computers (computer-use.md §10): the organization's registered desktops, next to Daemons.
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
import { Button, Icon } from '@/components/ui'
import { useMemberName } from '@/components/console/computer-members'
import { AllocationBadge, useAgentName } from '@/components/console/ComputerPoolCards'
import { ComputerEgressCard, ComputerQuotasCard } from '@/components/console/ComputerPlanCards'

export default function ComputersView() {
  const t = useTranslations('Computers')
  const { data, error, isLoading } = useComputers()
  const { data: pool } = useComputerPool()
  const { openModal } = useModal()
  const computers = useMemo(() => data ?? [], [data])
  const online = computers.filter((c) => c.status !== 'offline' && c.status !== 'revoked').length

  return (
    <div className="wrap px-4 pt-[14px] pb-1 desktop:p-0">
      {/* On mobile the Shell app bar supplies the title and the "+" that opens the same dialog. */}
      <div className="mb-4 hidden min-h-[34px] items-center gap-4 desktop:flex">
        <div className="flex-1">
          <p className="psub mt-0">{t('description')}</p>
        </div>
        <Button size="sm" onClick={() => openModal('computer')}>
          <Icon name="plus" size={15} />
          {t('addComputer')}
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
        >
          {t('loadError', { message: error instanceof Error ? error.message : String(error) })}
        </div>
      )}
      {isLoading && computers.length === 0 ? (
        <LoadingState fill />
      ) : computers.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
          <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="monitor" size={22} color="var(--text-tertiary)" />
          </span>
          <div className="font-sans text-[15px] font-semibold leading-normal">{t('empty.title')}</div>
          <div className="max-w-[420px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
            {t('empty.description')}
          </div>
          <Button variant="secondary" size="sm" onClick={() => openModal('computer')}>
            <Icon name="plus" size={15} />
            {t('addComputer')}
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 desktop:hidden">
            <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">
              <span className="h-2 w-2 rounded-full bg-(--status-online)" />
              {t('summary.connected', { count: online })}
            </span>
            <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">
              <span className="h-2 w-2 rounded-full bg-(--text-tertiary)" />
              {t('summary.disconnected', { count: computers.length - online })}
            </span>
          </div>
          <div className="flex flex-col gap-[10px]">
            {computers.map((c) => (
              <ComputerRow key={c.id} computer={c} />
            ))}
          </div>
        </>
      )}
      {/* Limits and egress apply to every Computer the organization adds, so they show before the first one too. */}
      <div className="mt-[18px] grid grid-cols-1 items-start gap-[14px] desktop:grid-cols-2">
        <ComputerQuotasCard />
        {pool?.enabled && <ComputerEgressCard />}
      </div>
    </div>
  )
}

function ComputerRow({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers')
  const ago = useAgo()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const { agents } = useConsoleData()
  const memberName = useMemberName()
  const agentName = useAgentName()
  const tone = computerStatusTone(computer.status)
  const poolNote = poolPhaseNote(computer)
  const waiting = computer.waiting?.length ?? 0
  const doctor = doctorCounts(computer)
  const access = agentAccessOf(computer)
  const granted = access.agents.map((id) => agents.find((a) => a.id === id)).filter((a) => a !== undefined)
  const seen = computer.lastSeenAt ? ago(computer.lastSeenAt) : t('never')
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
      className="card click grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-[13px] max-desktop:rounded-lg desktop:grid-cols-[auto_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] desktop:gap-x-5"
    >
      <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name="monitor" size={19} color="var(--text-secondary)" />
        <span
          className="absolute -right-1 -bottom-1 h-3 w-3 rounded-full border-2 border-(--surface-card)"
          style={{ background: tone.dot }}
        />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-sans text-[14px] font-semibold leading-normal">{computer.name}</span>
          <span
            className="inline-flex flex-none items-center rounded-full px-2 py-[1px] font-sans text-[11px] font-semibold leading-normal"
            style={{ background: tone.bg, color: tone.text }}
          >
            {poolNote ? t(`poolPhase.${poolNote}`) : t(`status.${computer.status}`)}
          </span>
          <AllocationBadge computer={computer} />
        </div>
        <div className="mt-[2px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t(`os.${computer.os}`)} · {t(`session.${computer.session}`)} ·{' '}
          {t('ownedBy', { name: memberName(computer.ownerUserId) })}
        </div>
      </div>
      <div className="col-span-2 min-w-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) desktop:col-span-1">
        <Icon name="bot" size={13} className="mr-[6px] inline align-[-2px] text-(--text-tertiary)" />
        {computer.ownerAgentId && computer.allocation !== 'manual'
          ? t('madeFor', { agent: agentName(computer.ownerAgentId) })
          : access.mode === 'all'
            ? t('allAgents')
            : granted.length === 0
              ? t('noAgents')
              : granted.length <= 2
                ? granted.map((a) => agentLabel(a)).join(', ')
                : t('agentCount', { count: granted.length })}
      </div>
      <div className="col-span-2 min-w-0 font-sans text-[12.5px] font-normal leading-normal desktop:col-span-1">
        {doctor.total === 0 ? (
          <span className="text-(--text-tertiary)">{t('doctor.notReported')}</span>
        ) : doctor.fail > 0 ? (
          <span className="text-(--status-error)">
            <Icon name="circle-x" size={13} className="mr-[6px] inline align-[-2px]" />
            {t('doctor.failing', { count: doctor.fail })}
          </span>
        ) : doctor.warn > 0 ? (
          <span className="text-[#9a6500]">
            <Icon name="triangle-alert" size={13} className="mr-[6px] inline align-[-2px]" />
            {t('doctor.warning', { count: doctor.warn })}
          </span>
        ) : (
          <span className="text-(--status-online)">
            <Icon name="circle-check" size={13} className="mr-[6px] inline align-[-2px]" />
            {t('doctor.healthy')}
          </span>
        )}
      </div>
      <div className="col-span-2 font-mono text-[11.5px] text-(--text-tertiary) desktop:col-span-1 desktop:text-right">
        {computer.lease ? (
          <span data-lease-holder={computer.lease.agentId} className="font-sans text-[12px] text-(--status-info)">
            {t('inUseBy', { agent: agentName(computer.lease.agentId, computer.lease.agentName) })}
            {waiting > 0 && <> · {t('waitingCount', { count: waiting })}</>}
          </span>
        ) : computer.status === 'revoked' ? (
          t('revoked')
        ) : (
          t('lastSeen', { when: seen })
        )}
      </div>
    </div>
  )
}
