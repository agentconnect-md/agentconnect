'use client'

// The session detail page's left rail: every session of the CURRENT agent, so a
// run you are comparing against is one click away instead of a round trip through
// /sessions. It only appears when the agent has ≥2 sessions (a single-session
// agent's rail would just repeat the page you are on) and only on desktop —
// ≤768px navigates sessions through the Shell app bar's back affordance.
//
// Rows carry the owning integration's platform mark (Slack / Telegram / … ),
// the title, and the relative time. Hovering a row swaps the time for a pin
// toggle; pinned sessions group above a divider, pin lit in the brand color.
// Pins live in localStorage — see lib/session-pins.ts for why they are not CP state.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { sessionChannelDisplay, type Session } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { PlatformMark } from '@/components/marks'
import {
  partitionPinned,
  pruneSessionPins,
  readSessionPins,
  toggleSessionPin,
  writeSessionPins
} from '@/lib/session-pins'

export function SessionRail({
  sessions,
  currentId,
  agentId
}: {
  /** The current agent's sessions, newest first. */
  sessions: Session[]
  currentId: string
  /** Target of the footer link — the global list pre-filtered to this agent. */
  agentId: string | undefined
}) {
  const { orgPath } = useOrgs()
  // Schedule-triggered rows show the schedule's name, so the rail needs the crons
  // list — read here rather than taken as a prop (a function prop on a 'use client'
  // module trips the Next TS plugin's Server-Action serializability check).
  const { crons } = useConsoleData()
  const cronName = useCallback((cronId: string) => crons.find((c) => c.id === cronId)?.name, [crons])
  // Hydration: the server has no localStorage, so the first client paint must match
  // the SSR markup (every row unpinned) and the stored pins land in an effect.
  const [pins, setPins] = useState<string[]>([])
  useEffect(() => {
    setPins(readSessionPins())
  }, [])

  const togglePin = useCallback((sessionId: string) => {
    setPins((prev) => {
      const next = toggleSessionPin(prev, sessionId)
      writeSessionPins(next)
      return next
    })
  }, [])

  // Forget stale ids only once the list is over its cap (see pruneSessionPins:
  // a session outside the loaded page is unknown, not deleted).
  useEffect(() => {
    setPins((prev) => {
      const next = pruneSessionPins(
        prev,
        sessions.map((s) => s.id)
      )
      if (next.length === prev.length) return prev
      writeSessionPins(next)
      return next
    })
  }, [sessions])

  const { pinned, rest } = useMemo(() => partitionPinned(sessions, pins), [sessions, pins])

  // A rail that would only show the session already on screen is noise.
  if (sessions.length < 2) return null

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
          // The channel is the one fact the row has no room for, so the tooltip
          // adds it rather than repeating the visible title alone.
          title={`${s.title} · ${channel.label}`}
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
          <span
            className={`mono flex-none text-[10.5px] font-medium text-(--text-tertiary) ${
              isPinned ? 'hidden' : 'group-hover:hidden'
            }`}
          >
            {s.time}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => togglePin(s.id)}
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin session' : 'Pin session'}
          className={`-my-[2px] h-[19px] w-[19px] flex-none items-center justify-center rounded-[5px] border-0 bg-none p-0 hover:bg-(--surface-active) hover:text-(--brand) ${
            isPinned ? 'flex text-(--brand)' : 'hidden text-(--text-tertiary) group-hover:flex'
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
          <span className="mono flex-none text-[11px] text-(--text-tertiary)">{sessions.length}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto">
          {pinned.map((s) => row(s, true))}
          {pinned.length > 0 && <div className="mx-[9px] my-[6px] h-px flex-none bg-(--border-subtle)" />}
          {rest.map((s) => row(s, false))}
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
