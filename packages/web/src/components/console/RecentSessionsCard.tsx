'use client'

// The dashboard-style "recent sessions" card, extracted from HomeView so agent
// detail (and future surfaces) render the identical rows: title, agent icon +
// name, platform mark + channel, relative time. The small Card/CardLink/EmptyRow
// primitives live here too — HomeView's other cards reuse them.

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView, PlatformMark } from '@/components/marks'
import { sessionChannelDisplay, type Session } from '@/lib/data'
import { useIsMobile } from '@/lib/use-is-mobile'

export function Card({
  title,
  action,
  className,
  children,
  ref
}: {
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div ref={ref} className={`card overflow-hidden ${className ?? ''}`}>
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

export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-5 text-center font-sans text-[12.5px] leading-normal text-(--text-tertiary)">
      {children}
    </div>
  )
}

// First-load placeholder: same row grid as the real rows so the swap to data
// causes no layout shift. Title width cycles deterministically (no Math.random)
// so server and client render identically.
const SKEL_TITLE_WIDTHS = ['w-2/5', 'w-1/3', 'w-1/2', 'w-3/5']
function SessionRowSkeleton({ i }: { i: number }) {
  return (
    <div className="row grid-cols-[1fr_auto] gap-3">
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
  fillHeight = false
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
  /** Card height is set externally (Home: match the right column) — round the fitted row count UP and let the body scroll. */
  fillHeight?: boolean
}) {
  const { orgPath } = useOrgs()
  const { getAgent, crons } = useConsoleData()
  const cardRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<number | null>(null)
  // Mobile stacks the card in normal flow, so its height is its own content —
  // measuring there would feed back into itself. Fit rows on desktop only.
  const isMobile = useIsMobile()
  const canFill = fillHeight && !isMobile
  useEffect(() => {
    if (!canFill) return
    const el = cardRef.current
    const body = bodyRef.current
    if (!el || !body) return
    const measure = () => {
      const row = body.querySelector<HTMLElement>('a.row')
      if (!row || row.offsetHeight === 0) return
      setFit(Math.max(1, Math.ceil(body.clientHeight / row.offsetHeight)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [canFill, sessions.length])
  const recent = sessions.slice(0, canFill && fit !== null ? fit : limit)
  return (
    <Card
      ref={cardRef}
      title={title}
      action={<CardLink href={allHref}>All sessions</CardLink>}
      className={`${fillHeight ? 'desktop:flex desktop:flex-col' : ''} ${className ?? ''}`}
    >
      <div ref={bodyRef} className={fillHeight ? 'desktop:min-h-0 desktop:flex-1 desktop:overflow-y-auto' : undefined}>
        {loading && recent.length === 0 ? (
          Array.from({ length: 4 }, (_, i) => <SessionRowSkeleton key={i} i={i} />)
        ) : recent.length === 0 ? (
          <EmptyRow>{emptyText}</EmptyRow>
        ) : (
          recent.map((s) => {
            const owner = s.agentId ? getAgent(s.agentId) : undefined
            const ch = sessionChannelDisplay(s, (id) => crons.find((c) => c.id === id)?.name)
            return (
              <Link key={s.id} href={orgPath(`/sessions/${s.id}`)} className="row click grid-cols-[1fr_auto] gap-3">
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
      </div>
    </Card>
  )
}
