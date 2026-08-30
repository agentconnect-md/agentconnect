'use client'

// Schedule detail (`/crons/[id]`) — design "isScheduleDetail". Header: name +
// Enabled/Disabled badge, agent / cron+human / target / audit meta,
// Toggle + "Run now" + an Edit/Delete menu. Below: the Runs card — the
// daemon-reported fire history (cron/report pairs), each linking to the ACP
// session it prompted. "Run now" only means the daemon ACCEPTED the fire; the
// outcome lands here asynchronously.

import { useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { agentLabel, platName } from '@/lib/data'
import { creatorLabel, fetchCronRuns, fmtDate, runCronNow } from '@/lib/api'
import { cronHuman, cronNext, cronUpdateInput, fmtNextRun, zonedDay } from '@/lib/cron'
import { useScheduleTimeZone } from '@/lib/schedule-timezone'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { useModal } from '@/components/console/ModalProvider'
import { VisibilityValue } from '@/components/console/VisibilityField'
import { NotFound } from '@/components/console/NotFound'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { consoleKeys } from '@/lib/swr-keys'
import { AgentIconView, LoadingState, PlatformMark } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'
import { ZoneSwitch } from '../ZoneSwitch'

function fmtStarted(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone })
  if (zonedDay(d, timeZone) === zonedDay(new Date(), timeZone)) return `Today · ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone })} · ${time}`
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—'
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

const RUN_STYLE = {
  running: { dot: 'var(--status-paused)', color: 'var(--text-secondary)', label: 'Running' },
  success: { dot: 'var(--status-online)', color: 'var(--text-primary)', label: 'Success' },
  failed: { dot: 'var(--status-error)', color: 'var(--status-error)', label: 'Failed' }
} as const

const RUN_GRID = 'grid-cols-[1.3fr_1.3fr_1.2fr_0.8fr_1.1fr]'
const RUN_REFRESH_MS = 10_000

export default function ScheduleDetailView() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { me } = useProfile()
  const { orgPath, activeOrg } = useOrgs()
  const { crons, cronsLoading, agents, integrations, allSessions, saveCron, deleteCron } = useConsoleData()
  const { openModal } = useModal()
  const isMobile = useIsMobile()
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const clock = useScheduleTimeZone()

  const c = crons.find((x) => x.id === id)

  const runsKey = consoleKeys.cronRuns(activeOrg?.id, id)
  const {
    data: runsData,
    error: runsError,
    mutate: mutateRuns
  } = useSWR(runsKey, ([, orgId, , cronId]) => fetchCronRuns(cronId, orgId), {
    refreshInterval: RUN_REFRESH_MS
  })
  const runs = runsData ?? null
  const runsLoadError = runsData === undefined && runsError

  if (!c) {
    return (
      <div className="wrap">
        {cronsLoading ? (
          <LoadingState fill />
        ) : (
          <NotFound
            icon="calendar-off"
            kind="SCHEDULE"
            title="Schedule not found"
            pre="No schedule "
            chip={id}
            post=" in this organization. It may have been removed by its owner."
            actionLabel="Back to schedules"
            actionHref={orgPath('/crons')}
            searchLabel="Search schedules"
          />
        )}
      </div>
    )
  }

  const owner = agents.find((a) => a.id === c.agentId)
  const agentName = owner ? agentLabel(owner) : c.agentId ? c.agentId.slice(0, 8) : '—'
  const agentRuntime = owner?.runtime || owner?.model || ''
  // The expression is never converted, so its reading names the zone it is interpreted in.
  const human = cronHuman(c.schedule)
  const humanInZone = human ? `${human} · ${c.timezone}` : human
  const zone = clock.zoneFor(c.timezone)
  const channelName = c.targetChannel
    ? (integrations
        .filter((i) => (c.targetIntegrationId ? i.id === c.targetIntegrationId : i.agentId === c.agentId))
        .flatMap((i) => i.channels)
        .find((ch) => ch.channelId === c.targetChannel)?.name ?? c.targetChannel)
    : null
  const ok = (runs ?? []).filter((r) => r.status === 'success').length
  const runSummary = runs === null ? '' : `${runs.length} runs · ${ok} success · ${runs.length - ok} not run or failed`
  // The run's session name (daemon-sourced via the sessions list); falls back to
  // a short id until that list loads or if the session has since aged out.
  const sessionName = (sid: string): string | undefined => allSessions.find((s) => s.id === sid)?.title

  const toggle = async (nextOn: boolean) => {
    const input = cronUpdateInput(c, { enabled: nextOn })
    if (!input || busy) return
    setBusy(true)
    try {
      await saveCron(c.id, input)
    } finally {
      setBusy(false)
    }
  }

  const runNow = async () => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      await runCronNow(c.id)
      setNotice('Run started — it will appear below when the daemon reports it.')
      void mutateRuns().catch(() => undefined)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setMenuOpen(false)
    await deleteCron(c.id)
    router.push(orgPath('/crons'))
  }

  if (isMobile) {
    // The Shell push bar owns the back arrow + name/agent title + ⋯ — render the body only.
    const next = c.enabled ? fmtNextRun(cronNext(c.schedule, c.timezone), zone) : '—'
    const cardStyle =
      'overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)'
    return (
      <div className="pb-6">
        {/* B1. Summary row */}
        <div className="flex items-center gap-3 border-b border-(--border-subtle) bg-(--surface-card) p-4">
          <span
            className={`flex h-12 w-12 flex-none items-center justify-center rounded-lg border border-(--border-subtle) bg-(--surface-sunken) ${
              c.enabled ? 'text-(--brand)' : 'text-(--text-tertiary)'
            }`}
          >
            <Icon name={c.enabled ? 'alarm-clock' : 'alarm-clock-off'} size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[15px] font-semibold leading-normal">{humanInZone ?? c.schedule}</div>
            <div className="mt-[2px] font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
              next run <span className="text-(--text-primary)">{next}</span>
            </div>
            <div className="mt-[2px]">
              <ZoneSwitch clock={clock} scheduleZone={c.timezone} />
            </div>
          </div>
          <span className={`inline-flex flex-none ${busy ? 'opacity-60' : ''}`}>
            <Toggle checked={c.enabled} onChange={(nextOn) => void toggle(nextOn)} />
          </span>
          {/* Single Edit affordance, at the top-right corner (opens the schedule editor). */}
          <button
            onClick={() => openModal('cron', c)}
            aria-label="Edit schedule"
            title="Edit schedule"
            className="iconbtn flex-none"
          >
            <Icon name="pencil" size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          {notice && (
            <div className="flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
              <Icon name="info" size={14} />
              {notice}
            </div>
          )}

          {/* B3. Task card */}
          <div className={cardStyle}>
            <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal">
              Task
            </div>
            <div className="whitespace-pre-wrap px-4 py-3 font-sans text-[14px] font-normal leading-[1.55] text-(--text-primary)">
              {c.trigger}
            </div>
          </div>

          {/* B4. Configuration card */}
          <div className={cardStyle}>
            <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal">
              Configuration
            </div>
            <button
              onClick={() => c.agentId && router.push(orgPath(`/agents/${c.agentId}`))}
              disabled={!c.agentId}
              className={`flex w-full items-center justify-between gap-4 border-0 border-b border-(--border-subtle) bg-(--surface-card) px-4 py-3 text-left ${
                c.agentId ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Agent</span>
              <span className="inline-flex items-center gap-2">
                <span className="av h-5 w-5 rounded-[5px]">
                  <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={20} />
                </span>
                <span className="font-sans text-[13px] font-semibold leading-normal">{agentName}</span>
              </span>
            </button>
            {channelName && (
              <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Post to</span>
                {c.targetPlatform === 'slack' && c.targetChannel ? (
                  <a
                    className="lnk inline-flex items-center gap-[6px] font-mono text-[12px] font-medium leading-normal text-(--text-link)"
                    href={`https://slack.com/app_redirect?channel=${c.targetChannel}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open #${channelName} in ${platName(c.targetPlatform)}`}
                  >
                    <span className="imark h-[14px] w-[14px]">
                      <PlatformMark platform={c.targetPlatform} fillPct={100} />
                    </span>
                    #{channelName}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-[6px]">
                    <span className="imark h-[14px] w-[14px]">
                      <PlatformMark platform={c.targetPlatform} fillPct={100} />
                    </span>
                    <span className="font-mono text-[12px] font-medium leading-normal">#{channelName}</span>
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Created</span>
              <span className="font-sans text-[14px] font-medium leading-normal">
                {creatorLabel(c.createdBy, me)}{' '}
                <span className="font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  · {fmtDate(c.createdAt)}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-(--border-subtle) px-4 py-3">
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Modified</span>
              <span className="font-sans text-[14px] font-medium leading-normal">
                {creatorLabel(c.lastModifiedBy, me)}{' '}
                <span className="font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  · {fmtDate(c.lastModifiedAt)}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-(--border-subtle) px-4 py-3">
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">
                Visibility
              </span>
              <VisibilityValue visibility={c.visibility} sharedWith={c.sharedWith} />
            </div>
          </div>

          {/* B5. Recent runs card */}
          <div className={cardStyle}>
            <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3">
              <div className="flex min-w-0 flex-col">
                <span className="font-sans text-[14px] font-semibold leading-normal">Recent runs</span>
                {runs !== null && runs.length > 0 && (
                  <span className="truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    {runSummary}
                  </span>
                )}
              </div>
              <button
                onClick={() => void runNow()}
                className={`flex flex-none cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-2 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) ${
                  busy ? 'opacity-60' : ''
                }`}
              >
                <Icon name="play" size={14} />
                Run now
              </button>
            </div>
            {runsLoadError ? (
              <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
                Couldn’t load recent runs.
              </div>
            ) : runs === null ? (
              <LoadingState />
            ) : runs.length === 0 ? (
              <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                No runs yet — they appear here after the schedule fires (or Run now).
              </div>
            ) : (
              runs.map((r, i) => {
                const st = RUN_STYLE[r.status]
                // Two lines carry what the desktop table's columns do: started + status
                // on top, the named session below; duration/reason stays right-pinned.
                const rowContent = (
                  <>
                    <span className="mt-[5px] h-2 w-2 flex-none rounded-full" style={{ background: st.dot }} />
                    <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                          {fmtStarted(r.startedAt, zone)}
                        </span>
                        <span className="font-sans text-[11px] font-medium leading-normal" style={{ color: st.color }}>
                          {st.label}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-[6px]">
                        {r.sessionId ? (
                          <span className="truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                            {sessionName(r.sessionId) ?? `${r.sessionId.slice(0, 8)}…`}
                          </span>
                        ) : (
                          <span className="flex-none font-sans text-[11px] font-normal leading-normal text-(--text-disabled)">
                            {channelName ? 'posted, no session' : 'headless'}
                          </span>
                        )}
                        {r.reason && (
                          <span
                            className={`truncate font-sans text-[11px] font-normal leading-normal ${
                              r.status === 'failed' ? 'text-(--red-600)' : 'text-(--text-tertiary)'
                            }`}
                          >
                            · {r.reason}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="mt-[1px] flex-none whitespace-nowrap font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {fmtDuration(r.durationMs)}
                    </span>
                  </>
                )
                const rowStyle = `flex w-full items-start gap-[11px] px-4 py-[11px] ${
                  i === 0 ? '' : 'border-t border-(--border-subtle)'
                }`
                // Preserve the session tap affordance from the desktop table.
                return r.sessionId ? (
                  <button
                    key={r.id}
                    onClick={() => router.push(orgPath(`/sessions/${r.sessionId}`))}
                    className={`${rowStyle} cursor-pointer bg-(--surface-card) text-left`}
                  >
                    {rowContent}
                    <Icon name="chevron-right" size={14} color="var(--text-tertiary)" className="mt-[3px] flex-none" />
                  </button>
                ) : (
                  <div key={r.id} className={rowStyle}>
                    {rowContent}
                  </div>
                )
              })
            )}
          </div>

          {/* B6. Delete button */}
          <button
            onClick={() => void remove()}
            className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[14px] font-semibold leading-normal text-(--red-600)"
          >
            <Icon name="trash-2" size={16} />
            Delete schedule
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px]">
            <h1 className="ptitle">{c.name ?? '—'}</h1>
            <span
              className={`badge ${
                c.enabled
                  ? 'bg-(--status-online-soft) text-(--status-online-text)'
                  : 'bg-(--surface-active) text-(--text-secondary)'
              }`}
            >
              <span className={`dot h-[6px] w-[6px] ${c.enabled ? 'bg-(--status-online)' : 'bg-(--text-disabled)'}`} />
              {c.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <span className={`inline-flex ${busy ? 'opacity-60' : ''}`}>
            <Toggle checked={c.enabled} onChange={(nextOn) => void toggle(nextOn)} />
          </span>
          <Button size="sm" onClick={() => void runNow()} className={busy ? 'opacity-60' : undefined}>
            <Icon name="play" size={14} />
            Run now
          </Button>
          <div className="relative flex-none">
            <button className="iconbtn" onClick={() => setMenuOpen((v) => !v)} title="Schedule actions">
              <Icon name="ellipsis" size={16} />
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-45" />
                <div className="dmenu right-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="dmi"
                    onClick={() => {
                      setMenuOpen(false)
                      openModal('cron', c)
                    }}
                  >
                    <Icon name="pencil" size={14} />
                    Edit
                  </button>
                  <div className="dmsep" />
                  <button className="dmi danger" onClick={() => void remove()}>
                    <Icon name="trash-2" size={14} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="mt-[9px] mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {c.agentId ? (
          <Link
            className="lnk font-mono text-[12px] font-normal leading-normal text-(--text-secondary)"
            href={orgPath(`/agents/${c.agentId}`)}
          >
            <span className="av h-4 w-4 rounded-xs">
              <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={16} />
            </span>
            {agentName}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-[6px]">
            <span className="av h-4 w-4 rounded-xs">
              <AgentIconView icon={owner?.icon} runtime={agentRuntime} size={16} />
            </span>
            <span className="mono text-[12px] text-(--text-secondary)">{agentName}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-[6px]">
          <Icon name="calendar-clock" size={13} color="var(--text-tertiary)" />
          <span className="mono text-[12px] text-(--text-secondary)">{c.schedule}</span>
          <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">{humanInZone}</span>
        </span>
        <span className="inline-flex items-center gap-[6px]">
          <Icon name="clock" size={13} color="var(--text-tertiary)" />
          <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">next run</span>
          <span className="mono text-[12px] text-(--text-secondary)">
            {c.enabled ? fmtNextRun(cronNext(c.schedule, c.timezone), zone) : '—'}
          </span>
        </span>
        <ZoneSwitch clock={clock} scheduleZone={c.timezone} />
        {channelName &&
          (c.targetPlatform === 'slack' && c.targetChannel ? (
            <a
              className="lnk font-mono text-[12px] font-normal leading-normal text-(--text-link)"
              href={`https://slack.com/app_redirect?channel=${c.targetChannel}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open #${channelName} in ${platName(c.targetPlatform)}`}
            >
              <span className="imark h-[13px] w-[13px]">
                <PlatformMark platform={c.targetPlatform} />
              </span>
              #{channelName}
            </a>
          ) : (
            <span className="inline-flex items-center gap-[6px]">
              <span className="imark h-[13px] w-[13px]">
                <PlatformMark platform={c.targetPlatform} />
              </span>
              <span className="mono text-[12px] text-(--text-secondary)">#{channelName}</span>
            </span>
          ))}
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          Created by {creatorLabel(c.createdBy, me)} · {fmtDate(c.createdAt)}
        </span>
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          Modified by {creatorLabel(c.lastModifiedBy, me)} · {fmtDate(c.lastModifiedAt)}
        </span>
        <VisibilityValue visibility={c.visibility} sharedWith={c.sharedWith} />
      </div>

      {notice && (
        <div className="mb-[14px] flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
          <Icon name="info" size={14} />
          {notice}
        </div>
      )}

      <div className="card mb-[18px]">
        <div className="cardhead">
          <span className="cardtitle">Task</span>
        </div>
        <div className="whitespace-pre-wrap px-4 py-[14px] font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-primary)">
          {c.trigger}
        </div>
      </div>

      <div className="card">
        <div className="cardhead justify-between">
          <span className="cardtitle">Runs</span>
          <span className="mono text-[11px] text-(--text-tertiary)">{runSummary}</span>
        </div>
        {runsLoadError ? (
          <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            Couldn’t load recent runs.
          </div>
        ) : runs === null ? (
          <LoadingState />
        ) : runs.length === 0 ? (
          <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No runs yet — they appear here after the schedule fires (or Run now).
          </div>
        ) : (
          <>
            <div className={`row h ${RUN_GRID}`}>
              <span>Started</span>
              <span>Status</span>
              <span>Target</span>
              <span>Duration</span>
              <span>Session</span>
            </div>
            {runs.map((r) => {
              const st = RUN_STYLE[r.status]
              return (
                <div key={r.id} className={`row items-center ${RUN_GRID}`}>
                  <span className="mono text-[12px] text-(--text-primary)">{fmtStarted(r.startedAt, zone)}</span>
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-[6px]">
                      <span className="dot h-[6px] w-[6px]" style={{ background: st.dot }} />
                      <span className="font-sans text-[12px] font-medium leading-normal" style={{ color: st.color }}>
                        {st.label}
                      </span>
                    </span>
                    {r.reason && (
                      <div className="mt-[2px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                        {r.reason}
                      </div>
                    )}
                  </div>
                  {channelName ? (
                    <span className="inline-flex min-w-0 items-center gap-[6px]">
                      <span className="imark h-4 w-4 flex-none rounded-xs">
                        <PlatformMark platform={c.targetPlatform} />
                      </span>
                      <span className="mono truncate text-[11.5px] text-(--text-secondary)">#{channelName}</span>
                    </span>
                  ) : (
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-disabled)">
                      headless
                    </span>
                  )}
                  <span className="mono text-[12px] text-(--text-secondary)">{fmtDuration(r.durationMs)}</span>
                  {r.sessionId ? (
                    <button
                      onClick={() => router.push(orgPath(`/sessions/${r.sessionId}`))}
                      title="Open session"
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center justify-self-start gap-[5px] border-0 bg-transparent p-0 font-sans text-[12px] font-medium leading-normal text-(--brand)"
                    >
                      <span className="truncate">{sessionName(r.sessionId) ?? `${r.sessionId.slice(0, 8)}…`}</span>
                      <Icon name="arrow-up-right" size={12} className="flex-none" />
                    </button>
                  ) : (
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-disabled)">—</span>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
