'use client'

// The dashboard-style "recent sessions" card, extracted from HomeView so agent
// detail (and future surfaces) render the identical rows: title, agent icon +
// name, platform mark + channel, relative time. The small Card/CardLink/EmptyRow
// primitives live here too — HomeView's other cards reuse them.

import { type ReactNode } from 'react'
import Link from 'next/link'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView, PlatformMark } from '@/components/marks'
import { isMergedConversationRow, sessionChannelDisplay, type Session } from '@/lib/data'

export function Card({
  title,
  action,
  className,
  children
}: {
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`card overflow-hidden ${className ?? ''}`}>
      <div className="cardhead justify-between">
        <span className="cardtitle">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 font-sans text-[12px] font-medium leading-normal text-(--text-brand) hover:underline"
    >
      {children}
      <Icon name="arrow-right" size={12} color="var(--text-brand)" />
    </Link>
  )
}

export function EmptyRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-center justify-center px-4 py-5 text-center font-sans text-[12.5px] leading-normal text-(--text-tertiary) ${className ?? ''}`}
    >
      {children}
    </div>
  )
}

// First-load placeholder: same row grid as the real rows so the swap to data
// causes no layout shift. Title width cycles deterministically (no Math.random)
// so server and client render identically.
const SKEL_TITLE_WIDTHS = ['w-2/5', 'w-1/3', 'w-1/2', 'w-3/5']
function SessionRowSkeleton({ i, rowClassName }: { i: number; rowClassName?: string }) {
  return (
    <div className={`row grid-cols-[1fr_auto] gap-3 ${rowClassName ?? ''}`}>
      <span className="min-w-0">
        <span
          className={`block h-[13px] ${SKEL_TITLE_WIDTHS[i % SKEL_TITLE_WIDTHS.length]} animate-pulse rounded-full bg-(--surface-active)`}
        />
        <span className="mt-[6px] flex items-center gap-[6px]">
          <span className="h-[15px] w-[15px] animate-pulse rounded-xs bg-(--surface-active)" />
          <span className="h-[11px] w-16 animate-pulse rounded-full bg-(--surface-active)" />
        </span>
      </span>
      <span className="h-[11px] w-10 animate-pulse self-start rounded-full bg-(--surface-active)" />
    </div>
  )
}

export function RecentSessionsCard({
  title = 'Recent',
  sessions,
  loading,
  allHref,
  emptyText,
  limit = 6,
  className,
  showAgent = true,
  rowClassName
}: {
  title?: string
  sessions: Session[]
  loading: boolean
  allHref: string
  emptyText: ReactNode
  limit?: number
  className?: string
  /** Agent detail already scopes to one agent — hide the redundant icon+name there. */
  showAgent?: boolean
  /** Per-row utilities. Home pins every dashboard row to one shared height so its two
   * columns end on the same line (see HomeView's row-budget note); other surfaces let
   * the rows size to their content. */
  rowClassName?: string
}) {
  const { orgPath } = useOrgs()
  const { getAgent, crons } = useConsoleData()
  const recent = sessions.slice(0, limit)
  return (
    <Card title={title} action={<CardLink href={allHref}>All sessions</CardLink>} className={className}>
      <>
        {loading && recent.length === 0 ? (
          Array.from({ length: Math.min(4, limit) }, (_, i) => (
            <SessionRowSkeleton key={i} i={i} rowClassName={rowClassName} />
          ))
        ) : recent.length === 0 ? (
          <EmptyRow className={rowClassName}>{emptyText}</EmptyRow>
        ) : (
          recent.map((s) => {
            const owner = s.agentId ? getAgent(s.agentId) : undefined
            const ch = sessionChannelDisplay(s, (id) => crons.find((c) => c.id === id)?.name)
            return (
              <Link
                key={s.id}
                // These rows are conversations, so a multi-participant one goes to
                // the merged page rather than to whichever member represents it.
                href={
                  isMergedConversationRow(s)
                    ? orgPath(`/conversations/${encodeURIComponent(s.conversationKey!)}`)
                    : orgPath(`/sessions/${s.id}`)
                }
                className={`row click grid-cols-[1fr_auto] gap-3 ${rowClassName ?? ''}`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                    {s.title}
                  </span>
                  <span className="mt-[3px] flex items-center gap-[6px] text-(--text-tertiary)">
                    {showAgent && (
                      <>
                        <span className="av h-[15px] w-[15px] rounded-xs">
                          <AgentIconView
                            icon={owner?.icon}
                            runtime={owner?.runtime ?? s.runtime ?? 'claude'}
                            size={15}
                          />
                        </span>
                        <span className="truncate font-sans text-[11.5px] leading-normal">{s.agentName || '—'}</span>
                      </>
                    )}
                    {s.channel && (
                      <>
                        <span className="imark h-4 w-4 rounded-xs">
                          <PlatformMark platform={ch.platform} fillPct={90} />
                        </span>
                        <span className="mono truncate text-[11px]">{ch.label}</span>
                      </>
                    )}
                  </span>
                </span>
                <span className="mono self-start whitespace-nowrap text-[11.5px] text-(--text-tertiary)">{s.time}</span>
              </Link>
            )
          })
        )}
      </>
    </Card>
  )
}
