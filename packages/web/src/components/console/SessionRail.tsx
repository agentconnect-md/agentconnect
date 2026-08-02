'use client'

// The session detail page's left rail: every session of the CURRENT agent, so a
// run you are comparing against is one click away instead of a round trip through
// /sessions. It only appears when the agent has ≥2 sessions (a single-session
// agent's rail would just repeat the page you are on) and only on desktop —
// ≤768px navigates sessions through the Shell app bar's back affordance.
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
// one. Both are the rail's whole point, so `current` is merged in and this agent's
// off-page pins are fetched individually (bounded by SESSION_PIN_HYDRATE_MAX).

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { canonicalSessionId, mergeCanonicalSessions, sessionChannelDisplay, type Session } from '@/lib/data'
import { fetchSessionDetail, sessionFromDetailDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { PlatformMark } from '@/components/marks'
import { groupSessionsByAge } from '@/lib/session-age'
import {
  partitionPinned,
  pinnedIdsForAgent,
  readSessionPins,
  SESSION_PIN_HYDRATE_MAX,
  toggleSessionPin,
  writeSessionPins,
  type SessionPin
} from '@/lib/session-pins'

export function SessionRail({
  sessions,
  current,
  total,
  agentId
}: {
  /** The agent-filtered first page of sessions, newest first. */
  sessions: Session[]
  /** The open session — merged in when it is not on the loaded page. */
  current: Session
  /** The agent's full session count (CP `total`); 0 when unknown (mock). */
  total: number
  /** Owning agent — scopes the pins and the footer link. */
  agentId: string | undefined
}) {
  const { orgPath, activeOrg } = useOrgs()
  // Schedule-triggered rows show the schedule's name, so the rail needs the crons
  // list — read here rather than taken as a prop (a function prop on a 'use client'
  // module trips the Next TS plugin's Server-Action serializability check).
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
        const next = toggleSessionPin(prev, sessionId, agentId ?? '')
        writeSessionPins(next)
        return next
      })
    },
    [agentId]
  )

  // Pinned rows for THIS agent that the loaded page does not carry. Fetched by id
  // because the list endpoint cannot filter by id; a rail holds a handful of pins,
  // and the cap only bounds a pathological list. A row that fails to load is simply
  // not rendered — a 404 here means "missing or not authorized", which is not proof
  // of deletion, so the pin is left alone (see lib/session-pins.ts).
  const currentId = canonicalSessionId(current)
  const loadedIds = useMemo(() => new Set([...sessions.map(canonicalSessionId), currentId]), [sessions, currentId])
  const missingPinIds = useMemo(
    () =>
      pinnedIdsForAgent(pins, agentId ?? '')
        .filter((id) => !loadedIds.has(id))
        .slice(0, SESSION_PIN_HYDRATE_MAX),
    [pins, agentId, loadedIds]
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

  const { pinned, rest } = useMemo(() => partitionPinned(rows, pins), [rows, pins])
  // Dated groups cover the UNPINNED rows only — a pin is an explicit "keep this at
  // the top", which outranks how old the run is. `now` is read per render; the rail
  // only renders once its agent-filtered page has landed on the client, so there is
  // no server pass whose clock could disagree.
  const groups = useMemo(() => groupSessionsByAge(rest, new Date()), [rest])

  // The agent's real session count, not the loaded-page length — a 60-session agent
  // must not read "50". This also gates the rail, so it does not blink into view
  // once page one lands.
  const count = Math.max(total, rows.length)

  // A rail that would only show the session already on screen is noise.
  if (count < 2) return null

  const row = (s: Session, isPinned: boolean) => {
    const channel = sessionChannelDisplay(s, cronName)
    const on = s.id === currentId
    return (
      <div
        key={s.id}
        className={`group flex w-full items-center gap-2 rounded-sm px-[9px] py-[6px] ${
          on
            ? 'bg-(--brand-soft) text-(--text-primary)'
            : 'text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
        }`}
      >
        <Link
          href={orgPath(`/sessions/${encodeURIComponent(s.id)}`)}
          // The two facts the row itself drops — when it ran and where — plus the
          // untruncated title. `\n` is a real break: the tooltip layer renders
          // whitespace-pre-line.
          title={`${s.title}\n${s.time} · ${channel.label}`}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <span className="imark h-[18px] w-[18px] flex-none rounded-xs">
            <PlatformMark platform={channel.platform} fillPct={100} />
          </span>
          <span
            className={`min-w-0 flex-1 truncate font-sans text-[12.5px] leading-normal ${
              on ? 'font-semibold' : 'font-medium'
            }`}
          >
            {s.title}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => togglePin(s.id)}
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin session' : 'Pin session'}
          className={`-my-[2px] h-[19px] w-[19px] flex-none items-center justify-center rounded-[5px] border-0 bg-none p-0 hover:bg-(--surface-active) hover:text-(--brand) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none ${
            isPinned ? 'flex text-(--brand)' : 'hidden text-(--text-tertiary) group-hover:flex group-focus-within:flex'
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
        <div className="flex items-center gap-2 pr-[9px] pb-[7px] pl-[9px]">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-semibold leading-normal tracking-[0.08em] text-(--text-tertiary) uppercase">
            Sessions
          </span>
          <span className="mono flex-none text-[11px] text-(--text-tertiary)">{count}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto">
          {pinned.map((s) => row(s, true))}
          {pinned.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
          {groups.map((g, i) => (
            <Fragment key={g.bucket}>
              {/* No top margin on the very first heading — it would double the gap
                  the rail header already leaves (or the pinned divider's). */}
              <div
                className={`flex-none px-[9px] pb-[3px] font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase ${
                  i === 0 ? '' : 'pt-[11px]'
                }`}
              >
                {g.label}
              </div>
              {g.rows.map((s) => row(s, false))}
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
