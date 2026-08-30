'use client'

// Schedules (`/crons`) — design "isSchedules". Cron jobs that run an agent on a
// timer. Columns: Schedule (name + task), Agent, Cron (expr + human reading),
// Last run (daemon-reported, dot), Next run (client-side croner preview),
// Toggle. Rows open the schedule detail page (edit/delete live there). The CP
// owns each definition; the owning daemon fires it.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { agentLabel } from '@/lib/data'
import type { CronDto } from '@/lib/api'
import { cronHuman, cronNext, cronUpdateInput, fmtNextRun } from '@/lib/cron'
import { useScheduleTimeZone } from '@/lib/schedule-timezone'
import { useConsoleData } from '@/lib/data-context'
import { useModal } from '@/components/console/ModalProvider'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { LoadingState } from '@/components/marks'
import { RestrictedLock } from '@/components/console/VisibilityField'
import { Button, Icon, Toggle } from '@/components/ui'

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const GRID = 'grid-cols-[2.2fr_1.1fr_1.3fr_1.1fr_1.1fr_44px] gap-3'

export default function CronsView() {
  const { crons, cronsLoading } = useConsoleData()
  const { openModal } = useModal()
  const isMobile = useIsMobile()

  if (isMobile) {
    // The Shell app bar owns the title + search + "+" (add) — start at the body.
    if (cronsLoading && crons.length === 0) {
      return <LoadingState fill />
    }
    if (crons.length === 0) {
      return (
        <div className="px-4 py-3">
          <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
            <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
              <Icon name="calendar-clock" size={22} color="var(--text-tertiary)" />
            </span>
            <div className="font-sans text-[15px] font-semibold leading-normal">No schedules yet</div>
            <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
              Create a schedule to run an agent on a timer — a daily report, a nightly dependency audit, a periodic
              sweep.
            </div>
            <Button variant="secondary" size="sm" onClick={() => openModal('cron')}>
              <Icon name="plus" size={15} />
              New schedule
            </Button>
          </div>
        </div>
      )
    }

    const enabledCount = crons.filter((c) => c.enabled).length
    // The list DTO carries no per-cron last-run status, so "failing" can't be
    // derived here — omit the failing chip (see spec Step 1 §2).
    const nextTimes = crons
      .filter((c) => c.enabled)
      .map((c) => cronNext(c.schedule, c.timezone))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())
    const soonest = nextTimes[0] ?? null

    return (
      <div className="pb-6">
        <div className="flex items-center gap-2 px-4 pt-[14px] pb-1">
          <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">
            <span className="h-2 w-2 rounded-full bg-(--status-online)" />
            {enabledCount} enabled
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
            next: {soonest ? fmtNextRun(soonest) : '—'}
          </span>
        </div>
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          {crons.map((c, i) => (
            <MobileCronRow key={c.id} c={c} i={i} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <div className="flex-1">
          <p className="psub mt-0">Cron jobs that run an agent on a timer — reports, sweeps, audits.</p>
        </div>
        <Button size="sm" onClick={() => openModal('cron')}>
          <Icon name="plus" size={15} />
          New schedule
        </Button>
      </div>

      {cronsLoading && crons.length === 0 ? (
        <LoadingState fill />
      ) : crons.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
          <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="calendar-clock" size={22} color="var(--text-tertiary)" />
          </span>
          <div className="font-sans text-[15px] font-semibold leading-normal">No schedules yet</div>
          <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
            Create a schedule to run an agent on a timer — a daily report, a nightly dependency audit, a periodic sweep.
          </div>
          <Button variant="secondary" size="sm" onClick={() => openModal('cron')}>
            <Icon name="plus" size={15} />
            New schedule
          </Button>
        </div>
      ) : (
        <div className="card">
          <div className={`row h ${GRID}`}>
            <span>Schedule</span>
            <span>Agent</span>
            <span>Cron</span>
            <span>Last run</span>
            <span>Next run</span>
            <span />
          </div>
          {crons.map((c) => (
            <CronRow key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function CronRow({ c }: { c: CronDto }) {
  const { agents, saveCron } = useConsoleData()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const [busy, setBusy] = useState(false)

  const owner = agents.find((a) => a.id === c.agentId)
  const agentName = owner ? agentLabel(owner) : c.agentId ? c.agentId.slice(0, 8) : '—'
  const clock = useScheduleTimeZone()
  // The expression is never converted, so its reading names the zone it is interpreted in.
  const human = cronHuman(c.schedule)
  const next = c.enabled ? fmtNextRun(cronNext(c.schedule, c.timezone), clock.zoneFor(c.timezone)) : '—'
  const ran = !!c.lastRunAt

  const toggle = async (nextOn: boolean) => {
    const input = cronUpdateInput(c, { enabled: nextOn })
    if (!input || busy) return // orphaned (agent deleted) — re-assign via Edit first
    setBusy(true)
    try {
      await saveCron(c.id, input)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`row click ${GRID}`} onClick={() => router.push(orgPath(`/crons/${c.id}`))}>
      <div className="min-w-0">
        <div
          className={`font-sans text-[13px] font-semibold leading-normal ${
            c.name ? 'text-(--text-primary)' : 'text-(--text-tertiary)'
          }`}
        >
          <span className="flex min-w-0 items-center gap-[6px]">
            <span className="truncate">{c.name ?? '—'}</span>
            <RestrictedLock
              show={c.visibility === 'restricted'}
              title="Selected — only shared members can see this schedule"
            />
          </span>
        </div>
        <div
          className="mt-[2px] truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
          title={c.trigger}
        >
          {c.trigger}
        </div>
      </div>
      <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{agentName}</span>
      <div className="min-w-0">
        <span className="mono text-[12px] text-(--text-primary)">{c.schedule}</span>
        <div className="mt-[2px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
          {human ? `${human} · ${c.timezone}` : 'invalid expression'}
        </div>
      </div>
      <span className="inline-flex items-center gap-[6px]">
        <span className={`dot h-[6px] w-[6px] ${ran ? 'bg-(--status-online)' : 'bg-(--text-disabled)'}`} />
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          {ran ? `ran · ${fmtWhen(c.lastRunAt)}` : 'never'}
        </span>
      </span>
      <span className={`mono text-[12px] ${next === '—' ? 'text-(--text-tertiary)' : 'text-(--text-primary)'}`}>
        {next}
      </span>
      <span className={`inline-flex ${busy ? 'opacity-60' : ''}`} onClick={(e) => e.stopPropagation()}>
        <Toggle checked={c.enabled} onChange={(nextOn) => void toggle(nextOn)} />
      </span>
    </div>
  )
}

// Mobile list row. The whole row taps through to the detail page; the alarm tile
// is a nested button that flips enabled/disabled in place — the touch-friendly
// equivalent of the desktop row's Toggle (same full-payload PUT). The tile tints
// brand when enabled, so its state doubles as the affordance.
function MobileCronRow({ c, i }: { c: CronDto; i: number }) {
  const { agents, saveCron } = useConsoleData()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const [busy, setBusy] = useState(false)

  const owner = agents.find((a) => a.id === c.agentId)
  const agentName = owner ? agentLabel(owner) : c.agentId ? c.agentId.slice(0, 8) : '—'
  const clock = useScheduleTimeZone()
  const human = cronHuman(c.schedule)
  const meta = `${agentName} · ${human ? `${human} · ${c.timezone}` : c.schedule}`
  const next = c.enabled ? fmtNextRun(cronNext(c.schedule, c.timezone), clock.zoneFor(c.timezone)) : 'off'
  const ran = !!c.lastRunAt

  const toggle = async () => {
    const input = cronUpdateInput(c, { enabled: !c.enabled })
    if (!input || busy) return // orphaned (agent deleted) — re-assign via Edit first
    setBusy(true)
    try {
      await saveCron(c.id, input)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={() => router.push(orgPath(`/crons/${c.id}`))}
      className={`flex min-h-18 w-full cursor-pointer items-center gap-3 bg-(--surface-card) px-4 py-3 text-left ${
        i === 0 ? '' : 'border-t border-(--border-subtle)'
      } ${c.enabled ? '' : 'opacity-55'}`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void toggle()
        }}
        disabled={!c.agentId || busy}
        aria-pressed={c.enabled}
        aria-label={c.enabled ? 'Disable schedule' : 'Enable schedule'}
        title={!c.agentId ? 'Re-assign an agent first' : c.enabled ? 'Tap to disable' : 'Tap to enable'}
        className={`flex h-10 w-10 flex-none items-center justify-center rounded-md border active:opacity-70 ${
          c.enabled
            ? 'border-(--brand-soft) bg-(--brand-soft) text-(--brand)'
            : 'border-(--border-subtle) bg-(--surface-sunken) text-(--text-tertiary)'
        } ${busy ? 'opacity-60' : ''} ${c.agentId ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Icon name={c.enabled ? 'alarm-clock' : 'alarm-clock-off'} size={20} />
      </button>
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={`truncate font-sans text-[14px] font-semibold leading-normal ${
              c.name ? 'text-(--text-primary)' : 'text-(--text-tertiary)'
            }`}
          >
            {c.name ?? '—'}
          </span>
          <RestrictedLock
            show={c.visibility === 'restricted'}
            title="Selected — only shared members can see this schedule"
          />
        </span>
        <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">{meta}</span>
      </span>
      <span className="flex flex-none flex-col items-end gap-[2px]">
        <span
          className={`font-mono text-[12px] font-medium leading-normal ${
            c.enabled ? 'text-(--text-primary)' : 'text-(--text-tertiary)'
          }`}
        >
          {next}
        </span>
        <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
          {ran ? `ran · ${fmtWhen(c.lastRunAt)}` : 'never'}
        </span>
      </span>
    </div>
  )
}
