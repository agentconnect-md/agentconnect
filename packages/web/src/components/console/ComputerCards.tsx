'use client'

// The Computer detail's read-only cards: `doctor` results with their fixes (§3.5) and the audit of recent activity (§8.2).
import { useState } from 'react'
import Link from 'next/link'
import useSWRInfinite from 'swr/infinite'
import { useFormatter, useTranslations } from 'next-intl'
import type { ComputerDoctorCheck } from '@agentconnect.md/protocol/computer'
import { fetchComputerAudit, type ComputerAuditEntryDto, type ComputerAuditPageDto, type ComputerDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { sortedDoctorChecks, useAgo } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { useMemberName } from '@/components/console/computer-members'
import { Button, Icon } from '@/components/ui'

const CHECK_ICON: Record<ComputerDoctorCheck['status'], { icon: string; color: string }> = {
  fail: { icon: 'circle-x', color: 'var(--status-error)' },
  warn: { icon: 'triangle-alert', color: 'var(--status-paused)' },
  info: { icon: 'info', color: 'var(--status-info)' },
  ok: { icon: 'circle-check', color: 'var(--status-online)' }
}

const CHECK_ROW: Record<ComputerDoctorCheck['status'], string> = {
  fail: 'border-t border-(--border-subtle) bg-(--status-error-soft) px-4 py-[8px]',
  warn: 'border-t border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[8px]',
  info: 'border-t border-(--border-subtle) px-4 py-[8px]',
  ok: 'border-t border-(--border-subtle) px-4 py-[8px]'
}

const SUMMARY_ORDER = ['fail', 'warn', 'ok', 'info'] as const

export function ComputerDoctorCard({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers.doctor')
  const ago = useAgo()
  const [showPassing, setShowPassing] = useState(false)
  const checks = sortedDoctorChecks(computer.doctor?.checks ?? [])
  const passing = checks.filter((check) => check.status === 'ok').length
  const shown = showPassing ? checks : checks.filter((check) => check.status !== 'ok')
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead gap-2">
        <span className="cardtitle flex-none">{t('title')}</span>
        <span className="ml-2 flex min-w-0 items-center gap-[10px] overflow-hidden">
          {SUMMARY_ORDER.map((status) => {
            const count = checks.filter((check) => check.status === status).length
            if (count === 0) return null
            return (
              <span
                key={status}
                className="inline-flex items-center gap-1 font-sans text-[12px] font-medium leading-normal whitespace-nowrap"
                style={{ color: CHECK_ICON[status].color }}
              >
                <Icon name={CHECK_ICON[status].icon} size={13} />
                {t(`summary.${status}`, { count })}
              </span>
            )
          })}
        </span>
        {computer.doctor && (
          <span className="ml-auto flex-none font-mono text-[11px] whitespace-nowrap text-(--text-tertiary)">
            {t('checkedAt', { when: ago(computer.doctor.checkedAt) })}
          </span>
        )}
      </div>
      {checks.length === 0 ? (
        <div className="px-4 py-5 font-sans text-[13px] font-normal leading-[1.55] text-(--text-tertiary)">
          {t('empty')}
        </div>
      ) : (
        <>
          <ul className="m-0 -mt-px list-none p-0">
            {shown.map((check, i) => {
              const mark = CHECK_ICON[check.status]
              return (
                <li key={`${check.name}-${i}`} data-doctor-check={check.name} className={CHECK_ROW[check.status]}>
                  <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-[10px] desktop:grid-cols-[16px_128px_minmax(0,1fr)]">
                    <Icon name={mark.icon} size={14} color={mark.color} className="mt-[2px]" />
                    <span className="mono truncate text-[12px] leading-[1.5] font-semibold text-(--text-primary)">
                      {check.name}
                    </span>
                    <span className="col-start-2 min-w-0 break-words font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary) desktop:col-start-auto">
                      {check.detail}
                    </span>
                  </div>
                  {check.fix && check.status !== 'ok' && (
                    <div className="mt-[6px] ml-[26px] rounded-sm border border-(--border-subtle) bg-(--surface-card) px-[10px] py-[7px] font-mono text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap text-(--text-primary)">
                      <span className="mr-[6px] font-sans font-semibold text-(--text-tertiary)">{t('fix')}</span>
                      {check.fix}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {passing > 0 && (
            <button
              type="button"
              aria-expanded={showPassing}
              onClick={() => setShowPassing((v) => !v)}
              className="flex h-[34px] w-full cursor-pointer items-center gap-[6px] border-0 border-t border-(--border-subtle) bg-(--surface-card) px-4 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            >
              <Icon name={showPassing ? 'chevron-up' : 'chevron-down'} size={14} />
              {showPassing ? t('hidePassing') : t('showPassing', { count: passing })}
            </button>
          )}
        </>
      )}
    </div>
  )
}

const AUDIT_PAGE = 25

type ActivityFilter = 'all' | 'viewers' | 'agents'

const ACTIVITY_FILTERS: readonly ActivityFilter[] = ['all', 'viewers', 'agents']

// A viewer's input is audited under `console:<userId>`; an agent's under its own client with its agent id.
const VIEWER_CLIENT = 'console:'

export function ComputerActivityCard({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers.activity')
  const format = useFormatter()
  const { data, error, size, setSize, isValidating } = useSWRInfinite<ComputerAuditPageDto>(
    (index: number, previous: ComputerAuditPageDto | null) => {
      if (previous && !previous.nextCursor) return null
      return ['computer-audit', computer.id, index === 0 ? '' : (previous?.nextCursor ?? '')]
    },
    ([, id, cursor]: [string, string, string]) =>
      fetchComputerAudit(id, { limit: AUDIT_PAGE, ...(cursor ? { cursor } : {}) }),
    { refreshInterval: 15_000 }
  )
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const entries = (data ?? [])
    .flatMap((page) => page.entries)
    .filter((entry) => filter === 'all' || (filter === 'agents') === (entry.agentId !== null))
  const more = Boolean(data?.at(-1)?.nextCursor)
  const [expanded, setExpanded] = useState<string | null>(null)
  const groups = groupByDay(entries, (at) => dayLabel(at, format, t))
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead flex-wrap gap-2">
        <div className="pillbar" role="radiogroup" aria-label={t('filterLabel')}>
          {ACTIVITY_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              className={filter === value ? 'pill on' : 'pill'}
              onClick={() => setFilter(value)}
            >
              {t(`filter.${value}`)}
            </button>
          ))}
        </div>
        <span className="ml-auto font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('note')}
        </span>
      </div>
      {error ? (
        <div role="alert" className="px-4 py-4 text-[13px] text-(--status-error)">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-5 font-sans text-[13px] font-normal leading-[1.55] text-(--text-tertiary)">
          {data ? t('empty') : t('loading')}
        </div>
      ) : (
        <div className="-mt-px">
          {groups.map((group) => (
            <section key={group.label}>
              <div className="eyebrow border-t border-(--border-subtle) bg-(--surface-sunken) px-4 pt-[9px] pb-[7px]">
                {group.label}
              </div>
              <ul className="m-0 list-none p-0">
                {group.entries.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    open={expanded === entry.id}
                    onToggle={() => setExpanded((v) => (v === entry.id ? null : entry.id))}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {more && (
        <div className="border-t border-(--border-subtle) px-4 py-3">
          <Button variant="secondary" size="xs" disabled={isValidating} onClick={() => void setSize(size + 1)}>
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  )
}

function groupByDay(
  entries: ComputerAuditEntryDto[],
  label: (at: Date) => string
): { label: string; entries: ComputerAuditEntryDto[] }[] {
  const groups: { label: string; entries: ComputerAuditEntryDto[] }[] = []
  for (const entry of entries) {
    const name = label(new Date(entry.at))
    const last = groups.at(-1)
    if (last?.label === name) last.entries.push(entry)
    else groups.push({ label: name, entries: [entry] })
  }
  return groups
}

function dayLabel(
  at: Date,
  format: ReturnType<typeof useFormatter>,
  t: ReturnType<typeof useTranslations<'Computers.activity'>>
): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (daysAgo === 0) return t('today')
  if (daysAgo === 1) return t('yesterday')
  return format.dateTime(at, { dateStyle: 'medium' })
}

function AuditRow({ entry, open, onToggle }: { entry: ComputerAuditEntryDto; open: boolean; onToggle: () => void }) {
  const t = useTranslations('Computers.activity')
  const format = useFormatter()
  const { agents } = useConsoleData()
  const { orgPath } = useOrgs()
  const memberName = useMemberName()
  const agent = entry.agentId ? agents.find((a) => a.id === entry.agentId) : undefined
  const viewer = !entry.agentId && entry.client.startsWith(VIEWER_CLIENT)
  const who = agent
    ? agentLabel(agent)
    : entry.agentId
      ? t('unknownAgent')
      : viewer
        ? memberName(entry.client.slice(VIEWER_CLIENT.length))
        : entry.client
  const actor = entry.agentId ?? entry.client
  const args = Object.keys(entry.args).length > 0 ? JSON.stringify(entry.args) : null
  return (
    <li className="border-t border-(--border-subtle)" data-audit-entry={entry.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-0 bg-transparent px-4 py-[8px] text-left hover:bg-(--surface-hover) desktop:grid-cols-[16px_minmax(120px,180px)_minmax(0,1fr)_auto]"
      >
        <Icon
          name={entry.outcome === 'ok' ? 'circle-check' : 'circle-x'}
          size={14}
          color={entry.outcome === 'ok' ? 'var(--status-online)' : 'var(--status-error)'}
        />
        <span className="mono min-w-0 truncate text-[12.5px] text-(--text-primary)">{entry.tool}</span>
        <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-[7px] desktop:col-start-auto desktop:row-start-auto">
          {entry.agentId ? (
            <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-xs bg-(--text-primary)">
              <Icon name="bot" size={11} color="var(--surface-card)" />
            </span>
          ) : (
            <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-(--surface-active) font-sans text-[9px] font-semibold leading-normal text-(--text-secondary)">
              {who.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="flex-none font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
            {who}
          </span>
          <span
            className="mono hidden min-w-0 truncate text-[11.5px] text-(--text-tertiary) desktop:inline"
            title={actor}
          >
            {actor}
          </span>
          {entry.code && <span className="flex-none font-mono text-[11px] text-(--status-error)">{entry.code}</span>}
        </span>
        <span
          className="col-start-3 row-span-2 row-start-1 text-right font-mono text-[11.5px] text-(--text-tertiary) desktop:col-start-auto desktop:row-span-1 desktop:row-start-auto"
          title={format.dateTime(new Date(entry.at), { dateStyle: 'medium', timeStyle: 'medium' })}
        >
          {format.dateTime(new Date(entry.at), {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          })}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 bg-(--surface-sunken) px-4 py-[10px] font-sans text-[12px] leading-[1.5] text-(--text-secondary)">
          <span>
            {t('took', { ms: entry.ms })}
            {entry.textLength !== null && <> · {t('typed', { count: entry.textLength })}</>}
            {entry.approval && <> · {t(`approval.${entry.approval}`)}</>}
          </span>
          {args && <code className="mono block text-[11.5px] break-all text-(--text-primary)">{args}</code>}
          {entry.sessionId && (
            <Link
              className="text-(--brand-soft-text)"
              href={orgPath(`/sessions/${encodeURIComponent(entry.sessionId)}`)}
            >
              {t('openSession')}
            </Link>
          )}
        </div>
      )}
    </li>
  )
}
