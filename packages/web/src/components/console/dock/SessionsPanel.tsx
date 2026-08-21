'use client'

// The dock's Sessions tab, hosted at 380–760px: the open session's family, then global pins, then the agent's other sessions by recency.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import {
  agentLabel,
  canonicalSessionId,
  conversationRowKey,
  isMergedConversationRow,
  mergeCanonicalSessions,
  sessionChannelDisplay,
  type Agent,
  type Session
} from '@/lib/data'
import { fetchSessionDetail, sessionFromDetailDto, type SessionRelationDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { AgentIconView, PlatformMark } from '@/components/marks'
import type { DockTabStatus } from './SessionDock'
import { groupSessionsByAge } from '@/lib/session-age'
import {
  partitionPinned,
  pinnedIdsForOrg,
  sessionPinIds,
  readSessionPins,
  SESSION_PIN_HYDRATE_MAX,
  toggleSessionPin,
  writeSessionPins,
  type SessionPin
} from '@/lib/session-pins'

interface PanelRow {
  id: string
  platform: string
  title: string
  tooltip: string
  /** Last activity, inline beside the title. Absent on a relation row, whose wire shape carries no timestamp. */
  time?: string
  /** The edge this row sits on, for readers the indent does not reach. Absent on a plain list row, which sits on none. */
  relationLabel?: string
  /** Where the row goes. A multi-participant row is a CONVERSATION, whose merged page is its default view (§5.3). */
  href: string
  /** The id this row's pin toggle writes: the member already pinned, if any, so unpinning releases the pin actually claiming the row. */
  pinId: string
  session?: Session
}

const EMPTY_RELATIONS: SessionRelationDto[] = []

/** {@link sessionPinIds} over a panel row, whose id is canonical — a live playground row still carries its synthetic route id. */
function pinIdsOf(session: Session): string[] {
  return sessionPinIds({
    id: canonicalSessionId(session),
    ...(session.memberSessionIds ? { memberSessionIds: session.memberSessionIds } : {})
  })
}

/** Whether the list has nothing worth drawing. Exported because a caller widening a collapsed seed has to gate on this same verdict: re-deriving it from the page count alone gets lineage and off-page pins wrong in the one direction that throws a serviceable list away, seeded chips with it. */
export function sessionsPanelWouldHide(input: {
  total: number
  /** The FULL row set — page + hydrated pins + the open session — not the caller's page, which never carried another agent's pin. */
  rowCount: number
  /** Lineage keeps a one-row page worth drawing, since it renders its own Related tree. */
  hasFamily: boolean
  filterTouched: boolean
}): boolean {
  return Math.max(input.total, input.rowCount) < 2 && !input.hasFamily && !input.filterTouched
}

/** That verdict as the tab status: unreported, or a hide while the caller still fetches, is `loading`; only a settled hide is `empty`. */
export function sessionsTabStatus(wouldHide: boolean | null, inputsSettled: boolean): DockTabStatus {
  if (wouldHide === false) return 'ready'
  return wouldHide !== null && inputsSettled ? 'empty' : 'loading'
}

// First-load placeholder the dock draws while the tab is `loading`: same box and
// row geometry as the real panel, so the swap to rows causes no layout shift.
// Title widths cycle deterministically (no Math.random) so SSR and client match.
const SKEL_TITLE_WIDTHS = ['w-3/5', 'w-2/5', 'w-1/2', 'w-3/4', 'w-1/3']
export function SessionsPanelSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col px-[13px] pt-3 pb-[10px]">
      {/* Header: the "All sessions" escape link's footprint. */}
      <div className="mb-[9px] flex flex-none items-center justify-end px-[9px] py-[3px]">
        <span className="h-[12px] w-20 animate-pulse rounded-full bg-(--surface-active)" />
      </div>
      {/* Agent filter row: one chip plus the "+" picker button. */}
      <div className="mb-[7px] flex flex-none items-center gap-[5px] px-[9px]">
        <span className="h-[22px] w-24 animate-pulse rounded-md bg-(--surface-active)" />
        <span className="h-[22px] w-[22px] flex-none animate-pulse rounded-sm bg-(--surface-active)" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex w-full flex-none items-center gap-2 px-[9px] py-[6px]">
            <span className="h-[18px] w-[18px] flex-none animate-pulse rounded-xs bg-(--surface-active)" />
            <span
              className={`h-[13px] ${SKEL_TITLE_WIDTHS[i % SKEL_TITLE_WIDTHS.length]} animate-pulse rounded-full bg-(--surface-active)`}
            />
            <span className="ml-auto h-[11px] w-10 flex-none animate-pulse rounded-full bg-(--surface-active)" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function SessionsPanel({
  sessions,
  current,
  total,
  agentIds,
  filterTouched,
  onAgentIdsChange,
  family,
  flatView = false,
  childOriginById,
  roomLineage,
  onSelect,
  onWouldHideChange
}: {
  /** The filtered first page of sessions, newest first. */
  sessions: Session[]
  /** The open session — merged in when the page lacks it, foreign filter or not, since the list must mark something `aria-current`. */
  current: Session
  /** The filtered session count (CP `total`); 0 when unknown (mock). */
  total: number
  /** Agents the list is filtered to; empty = every session the viewer can see. Two or more mean the conversations they SHARE — not the union of their sessions — which the CP resolves against the conversation each row belongs to, not the row. */
  agentIds: string[]
  /** Whether `agentIds` is the reader's own choice, not the seeded default — comparing the ids cannot tell the two apart. */
  filterTouched: boolean
  /** Edit the filter. The caller owns it — this panel is not the only thing it scopes. */
  onAgentIdsChange: (agentIds: string[]) => void
  /** Direct lineage in the panel's own three levels, not either source's wire shape. Undefined while it is unavailable. */
  family?: {
    /** LEVEL 0 — whatever woke the open row: at most one parent for a session, one per externally woken member for a conversation. */
    parentSessions: SessionRelationDto[]
    /** LEVEL 1, beside the open row under a divider: the other children of its parent. A conversation has none, so its caller omits this. */
    siblingSessions?: SessionRelationDto[]
    /** LEVEL 2 — whatever the open row woke. */
    childSessions: SessionRelationDto[]
  }
  /** Keep raw session rows and links instead of collapsing into conversations. */
  flatView?: boolean
  /** Delegation target id → waking member agentId (conversation mode). */
  childOriginById?: ReadonlyMap<string, string>
  /** Attribution INSIDE the open conversation — both ends are participants here, so neither is a navigation target (§9.1). */
  roomLineage?: { wokenBy: SessionRelationDto | null; woke: SessionRelationDto[] }
  /** Seed the persistent detail view before the route id changes. */
  onSelect: (session: Session) => void
  /** Whether the panel would draw nothing. The caller owns the fetches, so it re-asks a collapsed SEED and derives the tab `status`. */
  onWouldHideChange?: (wouldHide: boolean) => void
}) {
  const { orgPath, activeOrg } = useOrgs()
  const flatSearch = flatView ? '?view=flat' : ''
  // Schedule-triggered rows show the schedule's name; `agents` backs the chips.
  const { agents, crons } = useConsoleData()
  const cronName = useCallback((cronId: string) => crons.find((c) => c.id === cronId)?.name, [crons])
  // A new session starts a fresh playground with the open session's agent — the panel's one forward action, kept beside the escape to the full list.
  const router = useRouter()
  const { openPlayground } = usePlayground()
  const currentAgent = current.agentId ? agents.find((a) => a.id === current.agentId) : undefined
  const onNewSession = () => {
    if (!currentAgent) return
    const pid = openPlayground(currentAgent)
    router.push(orgPath(`/sessions/${pid}`))
  }

  // Pins are localStorage (lib/session-pins.ts says why not the CP); SSR has none, so they land in an effect to match the first paint.
  const [pins, setPins] = useState<SessionPin[]>([])
  // Tracked apart from the pins: an unread store and an empty one look the same, and the verdict below must not confuse them.
  const [pinsRead, setPinsRead] = useState(false)
  useEffect(() => {
    setPins(readSessionPins())
    setPinsRead(true)
  }, [])

  const togglePin = useCallback(
    (sessionId: string) => {
      setPins((prev) => {
        const next = toggleSessionPin(prev, sessionId, activeOrg?.id ?? '')
        writeSessionPins(next)
        return next
      })
    },
    [activeOrg?.id]
  )

  const currentId = canonicalSessionId(current)
  const parents = family?.parentSessions ?? EMPTY_RELATIONS
  const siblings = family?.siblingSessions ?? EMPTY_RELATIONS
  const children = family?.childSessions ?? EMPTY_RELATIONS
  // Fellow PARTICIPANTS, kept apart from `family`: same tree level as the matching slot, never its navigate-away meaning.
  const wokenBy = roomLineage?.wokenBy ?? null
  const woke = roomLineage?.woke ?? EMPTY_RELATIONS
  const hasFamily = Boolean(
    parents.length > 0 || siblings.length > 0 || children.length > 0 || wokenBy || woke.length > 0
  )
  const relatedIds = useMemo(() => {
    const ids = new Set<string>()
    if (!hasFamily) return ids
    ids.add(currentId)
    if (wokenBy) ids.add(wokenBy.id)
    for (const relation of parents) ids.add(relation.id)
    for (const relation of siblings) ids.add(relation.id)
    for (const relation of children) ids.add(relation.id)
    for (const relation of woke) ids.add(relation.id)
    return ids
  }, [children, currentId, hasFamily, parents, siblings, wokenBy, woke])

  // Every MEMBER of a listed conversation counts as loaded: hydrating one would put the same conversation in the list twice.
  const loadedIds = useMemo(
    () => new Set([...sessions.flatMap(pinIdsOf), currentId, ...relatedIds]),
    [sessions, currentId, relatedIds]
  )
  // Pinned rows the page and family do not carry, fetched by id because the list endpoint cannot filter by one.
  const missingPinIds = useMemo(
    () =>
      pinnedIdsForOrg(pins, activeOrg?.id ?? '')
        .filter((id) => !loadedIds.has(id))
        .slice(0, SESSION_PIN_HYDRATE_MAX),
    [pins, activeOrg?.id, loadedIds]
  )
  const { data: hydratedPins } = useSWR(
    missingPinIds.length > 0 ? ['dock-session-pins', activeOrg?.id ?? '', missingPinIds.join(',')] : null,
    async () => {
      const rows = await Promise.all(
        missingPinIds.map((id) =>
          fetchSessionDetail(id, activeOrg?.id)
            .then(sessionFromDetailDto)
            // Not drawn rather than unpinned: 404 here means missing OR unauthorized, which is no proof of deletion (lib/session-pins.ts).
            .catch(() => null)
        )
      )
      return rows.filter((row): row is Session => row !== null)
    },
    { revalidateOnFocus: false }
  )

  // One list, newest-first: the CP already orders its page by `lastActivityAt`, so this only decides where the merged rows land.
  const rows = useMemo(() => {
    const byConversation = new Map<string, Session>()
    // Collapsed by CONVERSATION first — two rows of one can name different representatives — with `current` last, so the live row wins.
    for (const session of [...sessions, ...(hydratedPins ?? []), current]) {
      const key = conversationRowKey(session)
      const seen = byConversation.get(key)
      // Layered, not replaced: `current` has the live state but not the roster its pin and link match.
      byConversation.set(key, seen ? { ...seen, ...session } : session)
    }
    return mergeCanonicalSessions([...byConversation.values()]).sort((a, b) =>
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
    )
  }, [sessions, current, hydratedPins])

  // Family rows keep their place in the tree, so they leave the list below and lineage never appears twice.
  const ordinaryRows = useMemo(
    () => (hasFamily ? rows.filter((session) => !relatedIds.has(session.id)) : rows),
    [hasFamily, relatedIds, rows]
  )
  const { pinned, rest } = useMemo(() => partitionPinned(ordinaryRows, pins, pinIdsOf), [ordinaryRows, pins])
  // Dated groups cover UNPINNED rows only — a pin outranks age. `now` per render is safe: this list only ever lands on the client.
  const groups = useMemo(() => groupSessionsByAge(rest, new Date()), [rest])

  // A list holding only the session already on screen is noise, so it draws nothing — and hiding takes the agent picker with it.
  const empty = sessionsPanelWouldHide({ total, rowCount: rows.length, hasFamily, filterTouched })

  // Reported FROM HERE, the only place the whole verdict exists (`rows` = the caller's page + globally hydrated pins + the open row), and withheld until this panel's OWN pins settle: an unread store reads as a collapsed list, and the caller LATCHES the first verdict.
  const pinsSettled = pinsRead && (missingPinIds.length === 0 || hydratedPins !== undefined)
  useEffect(() => {
    if (!pinsSettled) return
    onWouldHideChange?.(empty)
  }, [empty, pinsSettled, onWouldHideChange])

  if (empty) return null

  const sessionRow = (s: Session): PanelRow => {
    const channel = sessionChannelDisplay(s, cronName)
    const id = canonicalSessionId(s)
    const merged = !flatView && isMergedConversationRow(s)
    return {
      // The SESSION id: what `current` is matched against and what a fresh pin records. Pin LOOKUP goes through every member.
      id,
      platform: channel.platform,
      title: s.title,
      // The channel stays tooltip-only: a reader scanning titles never needs it, and it is what would push the title into an ellipsis.
      tooltip: `${s.title}\n${s.time} · ${channel.label}`,
      time: s.time,
      href: merged
        ? orgPath(`/conversations/${encodeURIComponent(s.conversationKey!)}`)
        : orgPath(`/sessions/${encodeURIComponent(id)}${flatSearch}`),
      pinId: rowPin(s).id,
      session: s
    }
  }
  // `relationLabel` names the edge in the tooltip and in sr-only text — the same words an attribution row uses, because it is the same edge.
  const relationRow = (relation: SessionRelationDto, relationLabel?: string): PanelRow => {
    const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
    return {
      id: relation.id,
      platform: relation.platform,
      title,
      tooltip: relationLabel ? `${relationLabel}\n${title}` : title,
      ...(relationLabel ? { relationLabel } : {}),
      href: orgPath(`/sessions/${encodeURIComponent(relation.id)}${flatSearch}`),
      pinId: relation.id
    }
  }
  const isPinned = (sessionId: string) => pins.some((pin) => pin.id === sessionId)
  // A conversation row is pinned when ANY member is, and unpinning must release that same pin or it keeps claiming the row.
  const rowPin = (s: Session) => {
    const ids = pinIdsOf(s)
    return { pinned: ids.some(isPinned), id: ids.find(isPinned) ?? canonicalSessionId(s) }
  }
  // Attribution answers WHO, so the row is built around the AGENT: participants share a title and a platform, so those two name nobody.
  const attributionRow = (relation: SessionRelationDto, depth: 0 | 1 | 2, relationLabel: string) => {
    const agent = agents.find((candidate) => candidate.id === relation.agentId)
    // As the filter chips resolve names: the org roster first, then the relation's own projection (older CPs omit it), then the raw id.
    const name = agent ? agentLabel(agent) : relation.agentName?.trim() || relation.agentId
    const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
    return (
      // Not navigation (§9.1): the target is a participant of the conversation already open, so no link — and no pin either.
      <div
        key={`attribution-${relation.id}`}
        title={`${relationLabel} ${name}\n${title}`}
        className={`flex w-full min-w-0 items-center gap-2 rounded-sm py-[6px] pr-[9px] text-(--text-secondary) ${
          depth === 2 ? 'pl-[26px]' : 'pl-[9px]'
        }`}
      >
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="-mt-2 h-[15px] w-[13px] flex-none rounded-bl-[4px] border-b-[1.5px] border-l-[1.5px] border-(--border-strong)"
          />
        )}
        <span className="av h-[18px] w-[18px] flex-none rounded-xs">
          <AgentIconView icon={agent?.icon} runtime={agent?.runtime ?? ''} size={18} />
        </span>
        {/* Direction is the row's place in the tree, which a screen reader hears nothing of — hence these words, and the tooltip's. */}
        <span className="sr-only">{relationLabel}</span>
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-medium leading-normal">{name}</span>
      </div>
    )
  }

  const row = (item: PanelRow, pinnedRow: boolean, depth: 0 | 1 | 2 = 0, on = false) => {
    return (
      <div
        key={item.id}
        className={`group relative w-full rounded-sm ${
          on
            ? 'bg-(--brand-soft) text-(--text-primary)'
            : 'text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
        }`}
      >
        <Link
          href={item.href}
          title={item.tooltip}
          aria-current={on ? 'page' : undefined}
          onClick={(event) => {
            // A selected row is the current view; letting Next navigate to the same URL refreshes its route payload for nothing.
            if (on) {
              event.preventDefault()
              return
            }
            if (item.session) onSelect(item.session)
          }}
          className={`flex w-full min-w-0 items-center gap-2 rounded-sm py-[6px] pr-[34px] focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none ${
            depth === 2 ? 'pl-[26px]' : 'pl-[9px]'
          }`}
        >
          {depth > 0 && (
            <span
              aria-hidden="true"
              className="-mt-2 h-[15px] w-[13px] flex-none rounded-bl-[4px] border-b-[1.5px] border-l-[1.5px] border-(--border-strong)"
            />
          )}
          <span className="imark h-[18px] w-[18px] flex-none rounded-xs">
            <PlatformMark platform={item.platform} fillPct={100} />
          </span>
          {item.relationLabel && <span className="sr-only">{item.relationLabel}</span>}
          <span
            className={`min-w-0 flex-1 truncate font-sans text-[12.5px] leading-normal ${
              on ? 'font-semibold' : 'font-medium'
            }`}
          >
            {item.title}
          </span>
          {/* Mono, tertiary and last: the dock's width makes it affordable, but you read it after finding the row, not while scanning. */}
          {item.time && (
            <span className="flex-none font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
              {item.time}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={() => togglePin(item.pinId)}
          aria-pressed={pinnedRow}
          title={pinnedRow ? 'Unpin session' : 'Pin session'}
          className={`absolute top-1/2 right-[7px] z-10 flex h-[19px] w-[19px] -translate-y-1/2 items-center justify-center rounded-[5px] border-0 bg-none p-0 hover:bg-(--surface-active) hover:text-(--brand) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none ${
            pinnedRow
              ? 'text-(--brand)'
              : 'pointer-events-none opacity-0 text-(--text-tertiary) group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
          }`}
        >
          <Icon name="pin" size={12} />
        </button>
      </div>
    )
  }

  // Three levels, and the indent is the only thing saying which is which: whatever woke the open row, the open row, whatever it woke.
  const aboveCurrent = Boolean(parents.length > 0 || wokenBy)
  const currentDepth = aboveCurrent ? 1 : 0
  const delegatedDepth = aboveCurrent ? 2 : 1

  const allSessionsQuery = new URLSearchParams()
  if (flatView) allSessionsQuery.set('view', 'flat')
  if (agentIds.length === 1) allSessionsQuery.set('agent', agentIds[0]!)
  const allSessionsHref = orgPath(`/sessions${allSessionsQuery.size ? `?${allSessionsQuery}` : ''}`)

  return (
    <div className="flex min-h-0 flex-1 flex-col px-[13px] pt-3 pb-[10px]">
      {/* The tab names the panel, so the header holds the one forward action plus the escape to /sessions, carrying the filter unless that page cannot ask it. */}
      <div className="mb-[9px] flex flex-none items-center gap-2 px-[9px]">
        {currentAgent ? (
          <Button size="sm" onClick={onNewSession} ariaLabel={`New session with ${agentLabel(currentAgent)}`}>
            <Icon name="plus" size={14} />
            New session
          </Button>
        ) : null}
        <Link className="lnk ml-auto font-sans text-[12px] font-medium leading-normal" href={allSessionsHref}>
          All sessions
          <Icon name="arrow-right" size={12} />
        </Link>
      </div>
      <PanelAgentFilter agents={agents} selected={agentIds} onChange={onAgentIdsChange} />
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto">
        {hasFamily && (
          <>
            <div className="flex-none px-[9px] pb-[3px] font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase">
              Related
            </div>
            {/* Level 0, all of it: the lift unions parents without recording which member each woke, so nesting them would invent a chain. */}
            {parents.map((parent) => row(relationRow(parent, 'Delegated by'), isPinned(parent.id)))}
            {/* Attribution, not navigation: a parent's edge, but living in THIS conversation, so a link would come right back. */}
            {wokenBy && attributionRow(wokenBy, 0, 'Delegated by')}
            {row(sessionRow(current), rowPin(current).pinned, currentDepth, true)}
            {woke.map((target) => attributionRow(target, delegatedDepth, 'Delegated to'))}
            {children.map((child, index) => {
              const origin = childOriginById?.get(child.id)
              const previousOrigin = index > 0 ? childOriginById?.get(children[index - 1]!.id) : undefined
              const originAgent = origin ? agents.find((agent) => agent.id === origin) : undefined
              return (
                <Fragment key={child.id}>
                  {origin !== undefined && origin !== previousOrigin && (
                    <div className="flex-none px-[9px] pt-[4px] pb-[1px] font-mono text-[9.5px] font-medium tracking-[0.06em] text-(--text-tertiary)">
                      via {originAgent ? agentLabel(originAgent) : origin}
                    </div>
                  )}
                  {row(relationRow(child, 'Delegated to'), isPinned(child.id), delegatedDepth)}
                </Fragment>
              )
            })}
            {/* Lineage siblings share the open row's parent, so they sit at ITS level under a divider — and on neither edge the words name. */}
            {siblings.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
            {siblings.map((sibling) => row(relationRow(sibling), isPinned(sibling.id), 1))}
            {ordinaryRows.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
          </>
        )}
        {pinned.map((s) => row(sessionRow(s), true, 0, canonicalSessionId(s) === currentId))}
        {pinned.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
        {groups.map((g, i) => (
          <Fragment key={g.bucket}>
            {/* The first heading starts flush; a preceding Related or pinned block already provides the spacing. */}
            <div
              className={`flex-none px-[9px] pb-[3px] font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase ${
                i === 0 ? '' : 'pt-[11px]'
              }`}
            >
              {g.label}
            </div>
            {g.rows.map((s) => row(sessionRow(s), false, 0, canonicalSessionId(s) === currentId))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

// The filter above the list: a chip per selected agent, then the "+" picker. Nothing selected reads "All agents", not an unexplained gap.
function PanelAgentFilter({
  agents,
  selected,
  onChange
}: {
  agents: Agent[]
  selected: string[]
  onChange: (agentIds: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // A restricted agent can own the open session while staying out of this roster: show its id rather than misdescribe the list as unfiltered.
  const chips = selected
    .map((id) => {
      const agent = agents.find((a) => a.id === id)
      return { id, label: agent ? agentLabel(agent) : id, agent }
    })
    // Alphabetical, since neither the roster nor the org list is ordered by anything the reader can see.
    .sort((a, b) => a.label.localeCompare(b.label))

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    // Captured and marked handled, so Escape closes this menu without also closing the dock overlay it is drawn inside.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const q = query.trim().toLowerCase()
  const shown = agents
    .filter((agent) => agentLabel(agent).toLowerCase().includes(q))
    .sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)))

  return (
    <div className="relative mb-[7px] flex flex-none flex-wrap items-center gap-[5px] px-[9px]">
      {chips.length === 0 && (
        <span className="py-[3px] font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)">
          All agents
        </span>
      )}
      {chips.map((chip) => (
        <span
          key={chip.id}
          title={chip.label}
          className="inline-flex h-[26px] min-w-0 max-w-full items-center gap-[5px] rounded-md border border-(--border-default) bg-(--surface-card) py-0 pr-[3px] pl-[6px]"
        >
          <span className="av h-[15px] w-[15px] flex-none rounded-xs">
            <AgentIconView icon={chip.agent?.icon} runtime={chip.agent?.runtime ?? ''} size={15} />
          </span>
          <span className="min-w-0 truncate font-sans text-[12px] font-medium leading-normal text-(--text-primary)">
            {chip.label}
          </span>
          <button
            type="button"
            onClick={() => onChange(selected.filter((id) => id !== chip.id))}
            title="Remove from filter"
            aria-label={`Remove ${chip.label} from the agent filter`}
            className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-xs border-0 bg-none p-0 text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none"
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Filter by agent"
        aria-label="Filter by agent"
        aria-expanded={open}
        className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-sm border p-0 focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none ${
          open
            ? 'border-(--brand) bg-(--surface-card) text-(--brand)'
            : 'border-(--border-default) bg-(--surface-card) text-(--text-tertiary) hover:border-(--border-strong) hover:bg-(--surface-hover) hover:text-(--text-primary)'
        }`}
      >
        <Icon name="plus" size={12} />
      </button>
      {open && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          {/* .fmenu anchors to the row's left edge with its own 210px minimum, which the dock beats at every width. */}
          <div className="fmenu" role="listbox">
            <input
              className="fsearch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter agents…"
              autoFocus
              aria-label="Filter agents"
            />
            {shown.map((agent) => {
              const on = selected.includes(agent.id)
              return (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className="fopt"
                  // The menu stays open while picking: building a set one closing menu at a time is three clicks for what should be two.
                  onClick={() => onChange(on ? selected.filter((id) => id !== agent.id) : [...selected, agent.id])}
                >
                  <span className="av h-5 w-5 flex-none rounded-xs">
                    <AgentIconView icon={agent.icon} runtime={agent.runtime} size={20} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{agentLabel(agent)}</span>
                  {on && <Icon name="check" size={14} color="var(--brand)" className="flex-none" />}
                </button>
              )
            })}
            {shown.length === 0 && <div className="fnohit">No matches</div>}
          </div>
        </>
      )}
    </div>
  )
}
