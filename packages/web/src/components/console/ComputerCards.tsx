'use client'

// The Computer detail's read-only cards: `doctor` results with their fixes (§3.5) and the audit of recent activity (§8.2).
import { useState } from 'react'
import Link from 'next/link'
import useSWRInfinite from 'swr/infinite'
import { useTranslations } from 'next-intl'
import type { ComputerDoctorCheck } from '@agentconnect.md/protocol/computer'
import { fetchComputerAudit, type ComputerAuditEntryDto, type ComputerAuditPageDto, type ComputerDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { sortedDoctorChecks, useAgo } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { Button, Icon } from '@/components/ui'

const CHECK_ICON: Record<ComputerDoctorCheck['status'], { icon: string; color: string }> = {
  fail: { icon: 'circle-x', color: 'var(--status-error)' },
  warn: { icon: 'triangle-alert', color: 'var(--status-paused)' },
  info: { icon: 'info', color: 'var(--status-info)' },
  ok: { icon: 'circle-check', color: 'var(--status-online)' }
}

export function ComputerDoctorCard({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers.doctor')
  const ago = useAgo()
  const checks = sortedDoctorChecks(computer.doctor?.checks ?? [])
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {computer.doctor && (
          <span className="ml-auto font-mono text-[11px] text-(--text-tertiary)">
            {t('checkedAt', { when: ago(computer.doctor.checkedAt) })}
          </span>
        )}
      </div>
      {checks.length === 0 ? (
        <div className="px-4 py-5 font-sans text-[13px] font-normal leading-[1.55] text-(--text-tertiary)">
          {t('empty')}
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {checks.map((check, i) => {
            const mark = CHECK_ICON[check.status]
            return (
              <li
                key={`${check.name}-${i}`}
                data-doctor-check={check.name}
                className="flex items-start gap-[10px] border-b border-(--border-subtle) px-4 py-[11px] last:border-b-0"
              >
                <Icon name={mark.icon} size={16} color={mark.color} className="mt-[1px] flex-none" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="mono text-[12.5px] font-semibold">{check.name}</span>
                    <span className="min-w-0 break-words font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                      {check.detail}
                    </span>
                  </div>
                  {check.fix && check.status !== 'ok' && (
                    <div className="mt-[6px] rounded-sm border border-(--border-subtle) bg-(--surface-sunken) px-[10px] py-[7px] font-mono text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap text-(--text-primary)">
                      <span className="mr-[6px] font-sans font-semibold text-(--text-tertiary)">{t('fix')}</span>
                      {check.fix}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

const AUDIT_PAGE = 25

export function ComputerActivityCard({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers.activity')
  const { data, error, size, setSize, isValidating } = useSWRInfinite<ComputerAuditPageDto>(
    (index: number, previous: ComputerAuditPageDto | null) => {
      if (previous && !previous.nextCursor) return null
      return ['computer-audit', computer.id, index === 0 ? '' : (previous?.nextCursor ?? '')]
    },
    ([, id, cursor]: [string, string, string]) =>
      fetchComputerAudit(id, { limit: AUDIT_PAGE, ...(cursor ? { cursor } : {}) }),
    { refreshInterval: 15_000 }
  )
  const entries = (data ?? []).flatMap((page) => page.entries)
  const more = Boolean(data?.at(-1)?.nextCursor)
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead">
        <span className="cardtitle">{t('title')}</span>
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
        <ul className="m-0 list-none p-0">
          {entries.map((entry) => (
            <AuditRow
              key={entry.id}
              entry={entry}
              open={expanded === entry.id}
              onToggle={() => setExpanded((v) => (v === entry.id ? null : entry.id))}
            />
          ))}
        </ul>
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

function AuditRow({ entry, open, onToggle }: { entry: ComputerAuditEntryDto; open: boolean; onToggle: () => void }) {
  const t = useTranslations('Computers.activity')
  const ago = useAgo()
  const { agents } = useConsoleData()
  const { orgPath } = useOrgs()
  const agent = entry.agentId ? agents.find((a) => a.id === entry.agentId) : undefined
  const who = agent ? agentLabel(agent) : entry.agentId ? t('unknownAgent') : entry.client
  const args = Object.keys(entry.args).length > 0 ? JSON.stringify(entry.args) : null
  return (
    <li className="border-b border-(--border-subtle) last:border-b-0" data-audit-entry={entry.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 border-0 bg-transparent px-4 py-[10px] text-left hover:bg-(--surface-hover) desktop:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
      >
        <Icon
          name={entry.outcome === 'ok' ? 'circle-check' : 'circle-x'}
          size={15}
          color={entry.outcome === 'ok' ? 'var(--status-online)' : 'var(--status-error)'}
        />
        <span className="mono min-w-0 truncate text-[12.5px] text-(--text-primary)">{entry.tool}</span>
        <span className="col-start-2 row-start-2 min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-secondary) desktop:col-start-auto desktop:row-start-auto">
          {who}
          {entry.code && <span className="ml-2 font-mono text-[11px] text-(--status-error)">{entry.code}</span>}
        </span>
        <span className="hidden font-mono text-[11px] text-(--text-tertiary) desktop:inline">
          {entry.approval && entry.approval !== 'not_required' ? t(`approval.${entry.approval}`) : ''}
        </span>
        <span className="col-start-3 row-span-2 row-start-1 text-right font-mono text-[11px] text-(--text-tertiary) desktop:col-start-auto desktop:row-span-1 desktop:row-start-auto">
          {ago(entry.at)}
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
