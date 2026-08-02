// The session detail page's left rail: the open session's direct family (parent,
// siblings, and children), globally pinned shortcuts, then the other sessions of
// the CURRENT agent. Family rows stay in their tree even when pinned and are
// removed from the ordinary list below, so lineage never appears twice. The rail
// only appears when there is another session to navigate to and only on desktop —
// ≤768px uses the relation card in SessionDetailView plus the Shell app bar's back
// affordance.
//
// A row is the owning integration's platform mark (Slack / Telegram / … ) plus the
// title, and nothing else: at 224px a per-row timestamp crowds out the one thing
// you are scanning for. Recency moves up to "Today" / "Yesterday" / … group
// headings, and the exact time — with the channel — moves into the hover tooltip.
// Hovering (or focusing) a row reveals its pin toggle; pinned sessions group above
// a divider, pin lit in the brand color, ahead of the dated groups. Pins live in
// localStorage — see lib/session-pins.ts for why they are not CP state.
//
// The caller's rows are the agent-filtered FIRST PAGE, so two kinds of row would
// otherwise be missing from a long-running agent's rail: the open session itself
// (a deep link to session 51+), and pinned runs that newer runs pushed off page
// one or that belong to another agent. Both are the rail's whole point, so
// `current` is merged in and off-page pins are fetched individually (bounded by
// SESSION_PIN_HYDRATE_MAX).

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { canonicalSessionId, mergeCanonicalSessions, sessionChannelDisplay, type Session } from '@/lib/data'
import { fetchSessionDetail, sessionFromDetailDto, type SessionDetailDto, type SessionRelationDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { PlatformMark } from '@/components/marks'
import { groupSessionsByAge } from '@/lib/session-age'
import {
  partitionPinned,
  pinnedIdsForOrg,
  readSessionPins,
  SESSION_PIN_HYDRATE_MAX,
  toggleSessionPin,
  writeSessionPins,
  type SessionPin
} from '@/lib/session-pins'

interface RailRow {
  id: string
  platform: string
  title: string
  tooltip: string
  session?: Session
}

const EMPTY_RELATIONS: SessionRelationDto[] = []

export function SessionRail({
  sessions,
  current,
  total,
  agentId,
  family,
  onSelect
}: {
  /** The agent-filtered first page of sessions, newest first. */
  sessions: Session[]
  /** The open session — merged in when it is not on the loaded page. */
  current: Session
  /** The agent's full session count (CP `total`); 0 when unknown (mock). */
  total: number
  /** Owning agent — scopes the footer link. */
  agentId: string | undefined
  /** Direct lineage from the detail endpoint. Undefined while it is unavailable. */
  family?: Pick<SessionDetailDto, 'parentSession' | 'siblingSessions' | 'childSessions'>
  /** Seed the persistent detail view before the route id changes. */
  onSelect: (session: Session) => void
}) {
  const { orgPath, activeOrg } = useOrgs()
  // Schedule-triggered rows show the schedule's name, so the rail needs the crons
  // list — resolve it here instead of threading another display-only callback.
  const { crons } = useConsoleData()
  const cronName = useCallback((cronId: string) => crons.find((c) => c.id === cronId)?.name, [crons])

  // Hydration: the server has no localStorage, so the first client paint must match
  // the SSR markup (every row unpinned) and the stored pins land in an effect.
  const [pins, setPins] = useState<SessionPin[]>([])
  useEffect(() => {
    setPins(readSessionPins())
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
  const parent = family?.parentSession ?? null
  const siblings = family?.siblingSessions ?? EMPTY_RELATIONS
  const children = family?.childSessions ?? EMPTY_RELATIONS
  const hasFamily = Boolean(parent || siblings.length > 0 || children.length > 0)
  const relatedIds = useMemo(() => {
    const ids = new Set<string>()
    if (!hasFamily) return ids
    ids.add(currentId)
    if (parent) ids.add(parent.id)
    for (const relation of siblings) ids.add(relation.id)
    for (const relation of children) ids.add(relation.id)
    return ids
  }, [children, currentId, hasFamily, parent, siblings])

  // Globally pinned rows that the loaded page or current family does not carry.
  // Fetched by id because the list endpoint cannot filter by id; a rail holds a
  // handful of pins, and the cap only bounds a pathological list. A row that fails
  // to load is simply not rendered — a 404 here means "missing or not authorized",
  // which is not proof of deletion, so the pin is left alone (see
  // lib/session-pins.ts).
  const loadedIds = useMemo(
    () => new Set([...sessions.map(canonicalSessionId), currentId, ...relatedIds]),
    [sessions, currentId, relatedIds]
  )
  const missingPinIds = useMemo(
    () =>
      pinnedIdsForOrg(pins, activeOrg?.id ?? '')
        .filter((id) => !loadedIds.has(id))
        .slice(0, SESSION_PIN_HYDRATE_MAX),
    [pins, activeOrg?.id, loadedIds]
  )
  const { data: hydratedPins } = useSWR(
    missingPinIds.length > 0 ? ['session-rail-pins', activeOrg?.id ?? '', missingPinIds.join(',')] : null,
    async () => {
      const rows = await Promise.all(
        missingPinIds.map((id) =>
          fetchSessionDetail(id, activeOrg?.id)
            .then(sessionFromDetailDto)
            .catch(() => null)
        )
      )
      return rows.filter((row): row is Session => row !== null)
    },
    { revalidateOnFocus: false }
  )

  // One de-duplicated list ordered newest-first. The CP already orders its page by
  // `lastActivityAt`, so this only decides where the merged rows land. The live
  // current row comes last so it replaces its persisted twin without losing streamed state.
  const rows = useMemo(
    () =>
      mergeCanonicalSessions([...sessions, ...(hydratedPins ?? []), current]).sort((a, b) =>
        (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
      ),
    [sessions, current, hydratedPins]
  )

  const ordinaryRows = useMemo(
    () => (hasFamily ? rows.filter((session) => !relatedIds.has(session.id)) : rows),
    [hasFamily, relatedIds, rows]
  )
  const { pinned, rest } = useMemo(() => partitionPinned(ordinaryRows, pins), [ordinaryRows, pins])
  // Dated groups cover the UNPINNED rows only — a pin is an explicit "keep this at
  // the top", which outranks how old the run is. `now` is read per render; the rail
  // only renders once its agent-filtered page has landed on the client, so there is
  // no server pass whose clock could disagree.
  const groups = useMemo(() => groupSessionsByAge(rest, new Date()), [rest])

  // A rail that would only show the session already on screen is noise. Direct
  // lineage still makes it useful when the current agent itself has one session.
  if (Math.max(total, rows.length) < 2 && !hasFamily) return null

  const sessionRow = (s: Session): RailRow => {
    const channel = sessionChannelDisplay(s, cronName)
    return {
      id: canonicalSessionId(s),
      platform: channel.platform,
      title: s.title,
      tooltip: `${s.title}\n${s.time} · ${channel.label}`,
      session: s
    }
  }
  const relationRow = (relation: SessionRelationDto): RailRow => {
    const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
    return {
      id: relation.id,
      platform: relation.platform,
      title,
      tooltip: title
    }
  }
  const isPinned = (sessionId: string) => pins.some((pin) => pin.id === sessionId)
  const row = (item: RailRow, pinnedRow: boolean, depth: 0 | 1 | 2 = 0, on = false) => {
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
          href={orgPath(`/sessions/${encodeURIComponent(item.id)}`)}
          title={item.tooltip}
          aria-current={on ? 'page' : undefined}
          onClick={(event) => {
            // A selected row is already the current view. Letting Next navigate
            // to the same dynamic URL needlessly refreshes its route payload.
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
          <span
            className={`min-w-0 flex-1 truncate font-sans text-[12.5px] leading-normal ${
              on ? 'font-semibold' : 'font-medium'
            }`}
          >
            {item.title}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => togglePin(item.id)}
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

  return (
    <div className="hidden w-[224px] flex-none desktop:block">
      <div className="sticky top-[-9px] flex max-h-[calc(100vh-110px)] flex-col pb-1">
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto">
          {hasFamily && (
            <>
              <div className="flex-none px-[9px] pb-[3px] font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase">
                Related
              </div>
              {parent && row(relationRow(parent), isPinned(parent.id))}
              {row(sessionRow(current), isPinned(currentId), parent ? 1 : 0, true)}
              {children.map((child) => row(relationRow(child), isPinned(child.id), parent ? 2 : 1))}
              {siblings.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
              {siblings.map((sibling) => row(relationRow(sibling), isPinned(sibling.id), 1))}
              {ordinaryRows.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
            </>
          )}
          {pinned.map((s) => row(sessionRow(s), true, 0, canonicalSessionId(s) === currentId))}
          {pinned.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
          {groups.map((g, i) => (
            <Fragment key={g.bucket}>
              {/* The first heading starts flush; separators already provide spacing
                  when Related or pinned rows precede it. */}
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
        <Link
          className="lnk mt-[10px] mr-[9px] ml-[9px] font-sans text-[12px] font-medium leading-normal"
          href={orgPath(agentId ? `/sessions?agent=${encodeURIComponent(agentId)}` : '/sessions')}
        >
          All sessions
          <Icon name="arrow-right" size={12} />
        </Link>
      </div>
    </div>
  )
}
