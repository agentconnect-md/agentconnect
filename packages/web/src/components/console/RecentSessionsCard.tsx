'use client'

// The dashboard-style "recent sessions" card, extracted from HomeView so agent
// detail (and future surfaces) render the identical rows: title, agent icon +
// name, platform mark + channel, relative time. The small Card/CardLink/EmptyRow
// primitives live here too — HomeView's other cards reuse them.

import { type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { useUnnamedLabel } from '@/components/console/platforms/unnamed-label'
import { useLastReply } from '@/lib/use-last-reply'
import { Icon } from '@/components/ui'
import { AgentIconView, PlatformMark } from '@/components/marks'
import {
  isMergedConversationRow,
  rosterParticipantName,
  sessionChannelDisplay,
  unnamedPlaceHint,
  type Agent,
  type Session
} from '@/lib/data'

/** Cap visible faces while retaining every participant's name. */
const ROSTER_FACES = 4

export function Card({
  title,
  tabs,
  action,
  className,
  children
}: {
  title: string
  /** A control that scopes the card's rows, drawn beside the title. */
  tabs?: ReactNode
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`card overflow-hidden ${className ?? ''}`}>
      <div className="cardhead justify-between">
        <span className="flex min-w-0 items-center gap-3">
          <span className="cardtitle">{title}</span>
          {tabs}
        </span>
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
  title,
  sessions,
  loading,
  allHref,
  emptyText,
  limit = 6,
  className,
  showAgent = true,
  replyPreview = false,
  tabs,
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
  /** Show the last reply and group the agent and channel marks at the right edge. */
  replyPreview?: boolean
  tabs?: ReactNode
  /** Home supplies a fixed desktop row height to align the two dashboard columns. */
  rowClassName?: string
}) {
  const t = useTranslations('Home.dashboard')
  const unnamedLabel = useUnnamedLabel()
  const { orgPath } = useOrgs()
  const { getAgent, crons } = useConsoleData()
  const recent = sessions.slice(0, limit)
  return (
    <Card
      title={title ?? t('recent')}
      tabs={tabs}
      action={<CardLink href={allHref}>{t('allSessions')}</CardLink>}
      className={className}
    >
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
            const ch = sessionChannelDisplay(s, (id) => crons.find((c) => c.id === id)?.name, unnamedLabel)
            return (
              <Link
                key={s.id}
                // Route multi-participant rows to the merged conversation.
                href={
                  isMergedConversationRow(s)
                    ? orgPath(`/conversations/${encodeURIComponent(s.conversationKey!)}`)
                    : orgPath(`/sessions/${s.id}`)
                }
                className={`row click grid-cols-[1fr_auto] gap-x-3 ${rowClassName ?? ''}`}
              >
                {/* The title shares a row with the time; the second line spans both columns. */}
                <span className="contents">
                  <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-[7px]">
                    {s.unread && (
                      <span
                        role="img"
                        aria-label={t('unread')}
                        title={t('unread')}
                        className="h-[7px] w-[7px] flex-none rounded-full bg-(--brand)"
                      />
                    )}
                    <span
                      className={
                        s.unread
                          ? 'block truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)'
                          : 'block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)'
                      }
                    >
                      {s.title}
                    </span>
                  </span>
                  <span
                    className={`col-span-2 row-start-2 mt-[3px] flex min-w-0 items-center text-(--text-tertiary) ${replyPreview ? 'gap-3' : 'gap-[6px]'}`}
                  >
                    {replyPreview && <LastReply session={s} emptyText={t('noReply')} />}
                    {showAgent && (
                      <span className={`flex items-center gap-[6px] ${replyPreview ? 'flex-none' : 'min-w-0'}`}>
                        <AgentFaces session={s} owner={owner} iconOnly={replyPreview} />
                      </span>
                    )}
                    {s.channel && (
                      <span
                        className={
                          replyPreview
                            ? 'flex flex-none'
                            : `flex min-w-0 items-center gap-[6px] ${showAgent ? 'ml-auto pl-1' : ''}`
                        }
                        role={replyPreview ? 'img' : undefined}
                        aria-label={replyPreview ? ch.label : undefined}
                        title={replyPreview ? (unnamedPlaceHint(s, ch.label) ?? ch.label) : undefined}
                      >
                        <span className="imark h-4 w-4 flex-none rounded-xs">
                          <PlatformMark platform={ch.platform} fillPct={90} />
                        </span>
                        {!replyPreview && (
                          <span className="mono truncate text-[11px]" title={unnamedPlaceHint(s, ch.label)}>
                            {ch.label}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </span>
                <span className="mono col-start-2 row-start-1 self-start whitespace-nowrap text-[11.5px] text-(--text-tertiary)">
                  {s.time}
                </span>
              </Link>
            )
          })
        )}
      </>
    </Card>
  )
}

function LastReply({ session, emptyText }: { session: Session; emptyText: string }) {
  const reply = useLastReply(session, true)
  return (
    <span title={reply ?? undefined} className="min-w-0 flex-1 truncate font-sans text-[12px] leading-normal">
      {reply ?? emptyText}
    </span>
  )
}

// Keep the full conversation roster available even when only a few faces fit.
function AgentFaces({ session, owner, iconOnly }: { session: Session; owner?: Agent; iconOnly: boolean }) {
  const { getAgent } = useConsoleData()
  const roster = session.participants ?? []
  if (roster.length <= 1) {
    const name = session.agentName || '—'
    return (
      <>
        <span
          className="av h-[15px] w-[15px] flex-none rounded-xs"
          role={iconOnly ? 'img' : undefined}
          aria-label={iconOnly ? name : undefined}
          title={iconOnly ? name : undefined}
        >
          <AgentIconView icon={owner?.icon} runtime={owner?.runtime ?? session.runtime ?? 'claude'} size={15} />
        </span>
        {!iconOnly && <span className="truncate font-sans text-[11.5px] leading-normal">{name}</span>}
      </>
    )
  }
  const members = roster.map((p) => {
    const agent = getAgent(p.agentId)
    return { id: p.agentId, name: rosterParticipantName(p, agent), agent }
  })
  const names = members.map((m) => m.name).join(', ')
  return (
    <>
      <span
        className={`flex flex-none items-center ${iconOnly ? '-space-x-[3px]' : '-space-x-[5px]'}`}
        role={iconOnly ? 'img' : undefined}
        aria-label={iconOnly ? names : undefined}
        title={iconOnly ? names : undefined}
      >
        {members.slice(0, ROSTER_FACES).map((m) => (
          <span key={m.id} className="av h-[15px] w-[15px] flex-none rounded-xs" title={iconOnly ? undefined : m.name}>
            <AgentIconView icon={m.agent?.icon} runtime={m.agent?.runtime ?? ''} size={15} />
          </span>
        ))}
      </span>
      {!iconOnly && (
        <span title={names} className="truncate font-sans text-[11.5px] leading-normal">
          {names}
        </span>
      )}
    </>
  )
}
