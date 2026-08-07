// The session detail page's RIGHT rail ([nav · body · rail], flush with the page
// edge): the open session's direct family (parent, siblings, and children),
// globally pinned shortcuts, then the other sessions of the CURRENT agent. Family
// rows stay in their tree even when pinned and are removed from the ordinary list
// below, so lineage never appears twice. Rows only appear when there is another
// session to navigate to. ≥1240px (`wide:`) draws the inline column; 769–1239px
// collapses it to a floating top-right button; ≤768px moves that trigger INTO the
// shell's app bar (MobileActionSlot), because a fixed overlay would cover the
// session title. Both collapsed bands open the SAME popover from one click latch —
// pointer capability does not follow width (a 1024px iPad sits in the middle band),
// so there is no hover-only path anywhere. The relation card in SessionDetailView
// still carries lineage.
//
// The COLUMN, though, is unconditional above `wide` (SessionRailSlot). The
// detail body is centred in whatever horizontal space the rail leaves it, so any
// state-dependent column is a layout shift waiting for its trigger: the rail's list
// is a round-trip behind the session, so an emptiable column collapses on first
// paint and shoves the transcript 125px sideways when the rows land — and the same
// jump fires again on every rail click that crosses from a busy agent to a quiet
// one, since this view survives navigation rather than remounting. Holding the
// column costs a rail-less session an empty gutter; it buys a body whose position
// is a constant of the route.
//
// A row is the owning integration's platform mark (Slack / Telegram / … ) plus the
// title, and nothing else: at 224px a per-row timestamp crowds out the one thing
// you are scanning for. Recency moves up to "Today" / "Yesterday" / … group
// headings, and the exact time — with the channel — moves into the hover tooltip.
// Hovering (or focusing) a row reveals its pin toggle; pinned sessions group above
// a divider, pin lit in the brand color, ahead of the dated groups. Pins live in
// localStorage — see lib/session-pins.ts for why they are not CP state.
//
// Above the list sits the agent filter: a chip per selected agent (removable), plus
// a "+" that opens the agent picker. It is seeded by the caller with the agents in
// the open CONVERSATION, so the rail's default question is "the other threads these
// same agents worked in"; clearing it widens the list to every session the viewer
// can see. Two or more agents mean conversations they SHARE — the CP resolves that
// against the conversation each row belongs to, not against the row itself.
//
// The caller's rows are the filtered FIRST PAGE, so two kinds of row would
// otherwise be missing from a long-running agent's rail: the open session itself
// (a deep link to session 51+), and pinned runs that newer runs pushed off page
// one or that belong to another agent. Both are the rail's whole point, so
// `current` is merged in and off-page pins are fetched individually (bounded by
// SESSION_PIN_HYDRATE_MAX). `current` stays merged in under a foreign agent filter
// too — the open session is where the reader is, and dropping its row would leave
// the rail with nothing marked `aria-current`.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
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
import { fetchSessionDetail, sessionFromDetailDto, type SessionDetailDto, type SessionRelationDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView, PlatformMark } from '@/components/marks'
import { useMobileActionSlot } from '@/components/console/Shell'
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

interface RailRow {
  id: string
  platform: string
  title: string
  tooltip: string
  /** The edge this row sits on, for readers the indent does not reach. Absent on
   *  a plain list row, which sits on no edge at all. */
  relationLabel?: string
  /** Where the row goes. A multi-participant row is a CONVERSATION, and the merged
   *  page is its default surfaced view (merged-conversation-view.md §5.3). */
  href: string
  /** The id this row's pin toggle writes: the member already pinned when there is
   *  one, so unpinning releases the pin that is actually claiming the row. */
  pinId: string
  session?: Session
}

const EMPTY_RELATIONS: SessionRelationDto[] = []

/** {@link sessionPinIds} over a rail row, whose id is canonical (a live playground
 *  row still carries its synthetic route id). */
function pinIdsOf(session: Session): string[] {
  return sessionPinIds({
    id: canonicalSessionId(session),
    ...(session.memberSessionIds ? { memberSessionIds: session.memberSessionIds } : {})
  })
}

/**
 * The rail's footprint with nothing in it — the shape every session detail state
 * holds so the body beside it never moves. Used by the loading branch, which has
 * no rail to draw, and by a rail with no rows worth drawing.
 *
 * The column sits on the page's RIGHT edge ([nav · body · rail]): the negative
 * right margin bleeds over `.content`'s 30px padding so the reserved track plus
 * that padding equals the fixed 250px panel the real rail pins to the viewport
 * edge. Keep these box classes identical to the real rail's container below.
 */
/**
 * Whether the rail has nothing worth drawing, over the inputs it settles from.
 *
 * `rowCount` is the FULL row set — the agent-filtered page merged with globally
 * hydrated pins and the open session — not the page the caller fetched: a pin from
 * another agent is a row the page never carried. `hasFamily` keeps a one-row page
 * worth drawing on its own, since lineage renders its own Related tree.
 *
 * Exported because a caller that widens a collapsed seed has to gate on the same
 * verdict, and re-deriving it from the page count alone gets the lineage and pin
 * cases wrong in the direction that throws a good rail away.
 */
export function railWouldHide(input: {
  total: number
  rowCount: number
  hasFamily: boolean
  filterTouched: boolean
}): boolean {
  return Math.max(input.total, input.rowCount) < 2 && !input.hasFamily && !input.filterTouched
}

export function SessionRailSlot() {
  return <div aria-hidden="true" className="-mr-[30px] hidden w-[250px] flex-none wide:block" />
}

export function SessionRail({
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
  /** The open session — merged in when it is not on the loaded page. */
  current: Session
  /** The filtered session count (CP `total`); 0 when unknown (mock). */
  total: number
  /** Agents the list is filtered to; empty = every session the viewer can see. */
  agentIds: string[]
  /** Whether `agentIds` is the reader's own choice rather than the seeded default. */
  filterTouched: boolean
  /** Edit the filter. The caller owns it — the rail is not the only thing it scopes. */
  onAgentIdsChange: (agentIds: string[]) => void
  /** Direct lineage from the detail endpoint. Undefined while it is unavailable. */
  family?: Pick<SessionDetailDto, 'parentSession' | 'siblingSessions' | 'childSessions'>
  /** Keep raw session rows and links instead of collapsing into conversations. */
  flatView?: boolean
  /** Delegation target id → waking member agentId (conversation mode). */
  childOriginById?: ReadonlyMap<string, string>
  /** Attribution INSIDE the open conversation — who woke the open row, and whom
   *  it woke. Separate from `family` because both ends are participants of this
   *  same conversation, so neither is a navigation target (§9.1). */
  roomLineage?: { wokenBy: SessionRelationDto | null; woke: SessionRelationDto[] }
  /** Seed the persistent detail view before the route id changes. */
  onSelect: (session: Session) => void
  /** Whether the rail is about to draw nothing — see the `empty` note below. The
   *  caller owns the fetches, so a collapsed SEED is re-asked there, not here. */
  onWouldHideChange?: (wouldHide: boolean) => void
}) {
  const { orgPath, activeOrg } = useOrgs()
  const flatSearch = flatView ? '?view=flat' : ''
  // Schedule-triggered rows show the schedule's name, so the rail needs the crons
  // list — resolve it here instead of threading another display-only callback.
  // `agents` backs the filter chips and their picker.
  const { agents, crons } = useConsoleData()
  const cronName = useCallback((cronId: string) => crons.find((c) => c.id === cronId)?.name, [crons])

  const { register: registerMobileAction } = useMobileActionSlot()
  // Below `wide`, where the list has no column: whether a click has latched the panel
  // open. Both collapsed triggers share it, and it is the ONLY visibility source in
  // either band — pointer capability does not follow width (a 1024px iPad lands in
  // the 769–1239px band with no hover and no reliable focus-on-tap in Safari), so
  // there is no CSS hover reveal to disagree with `aria-expanded`.
  const [listOpen, setListOpen] = useState(false)

  // Hydration: the server has no localStorage, so the first client paint must match
  // the SSR markup (every row unpinned) and the stored pins land in an effect.
  const [pins, setPins] = useState<SessionPin[]>([])
  // Tracked separately from the pins themselves: "no pins yet" is what an unread
  // store and a genuinely empty one both look like, and the hide verdict reported
  // below must not mistake the first for the second.
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
  const parent = family?.parentSession ?? null
  const siblings = family?.siblingSessions ?? EMPTY_RELATIONS
  const children = family?.childSessions ?? EMPTY_RELATIONS
  // Attribution inside the open conversation, kept apart from `family` on
  // purpose: these are fellow PARTICIPANTS, not other conversations, so they
  // share the tree level of the matching `family` slot but never its
  // navigate-away meaning.
  const wokenBy = roomLineage?.wokenBy ?? null
  const woke = roomLineage?.woke ?? EMPTY_RELATIONS
  const hasFamily = Boolean(parent || siblings.length > 0 || children.length > 0 || wokenBy || woke.length > 0)
  const relatedIds = useMemo(() => {
    const ids = new Set<string>()
    if (!hasFamily) return ids
    ids.add(currentId)
    if (parent) ids.add(parent.id)
    if (wokenBy) ids.add(wokenBy.id)
    for (const relation of siblings) ids.add(relation.id)
    for (const relation of children) ids.add(relation.id)
    for (const relation of woke) ids.add(relation.id)
    return ids
  }, [children, currentId, hasFamily, parent, siblings, wokenBy, woke])

  // Globally pinned rows that the loaded page or current family does not carry.
  // Fetched by id because the list endpoint cannot filter by id; a rail holds a
  // handful of pins, and the cap only bounds a pathological list. A row that fails
  // to load is simply not rendered — a 404 here means "missing or not authorized",
  // which is not proof of deletion, so the pin is left alone (see
  // lib/session-pins.ts).
  // Every MEMBER of a listed conversation counts as loaded, not just the row's
  // representative: a pin on the member who has since stopped being newest is
  // already on screen as that conversation, and hydrating it would put the same
  // conversation in the rail twice.
  const loadedIds = useMemo(
    () => new Set([...sessions.flatMap(pinIdsOf), currentId, ...relatedIds]),
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
  //
  // Rows are collapsed by CONVERSATION before the id merge. Two rows of one
  // conversation can carry different representatives — the list names the newest
  // member the FILTER still covers, `current` names the newest member outright —
  // so narrowing to one of two participants would otherwise put the open
  // conversation on screen twice. Later entries win, which is why `current` is
  // last: it is the live row, and it must not be replaced by its persisted twin.
  const rows = useMemo(() => {
    const byConversation = new Map<string, Session>()
    for (const session of [...sessions, ...(hydratedPins ?? []), current]) {
      const key = conversationRowKey(session)
      const seen = byConversation.get(key)
      // Layered, not replaced: `current` carries the live state but not the roster
      // the list row was built with, and dropping that would cost the row its
      // members — the very thing its pin and its link are matched on.
      byConversation.set(key, seen ? { ...seen, ...session } : session)
    }
    return mergeCanonicalSessions([...byConversation.values()]).sort((a, b) =>
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
    )
  }, [sessions, current, hydratedPins])

  const ordinaryRows = useMemo(
    () => (hasFamily ? rows.filter((session) => !relatedIds.has(session.id)) : rows),
    [hasFamily, relatedIds, rows]
  )
  const { pinned, rest } = useMemo(() => partitionPinned(ordinaryRows, pins, pinIdsOf), [ordinaryRows, pins])
  // Dated groups cover the UNPINNED rows only — a pin is an explicit "keep this at
  // the top", which outranks how old the run is. `now` is read per render; the rail
  // only renders once its agent-filtered page has landed on the client, so there is
  // no server pass whose clock could disagree.
  const groups = useMemo(() => groupSessionsByAge(rest, new Date()), [rest])

  // A rail that would only show the session already on screen is noise, so it draws
  // nothing — but it still holds its column, because a body that re-centres is worse
  // noise than an empty gutter (see the header). Direct lineage keeps the rows worth
  // drawing when the current agent itself has one session. A filter the reader chose
  // is the exception: emptying the rail would take the filter control away with it,
  // leaving no way back to a wider list. That has to come from `filterTouched` and
  // not from comparing `agentIds` against the open session — filtering to agent B
  // and then opening B's only session lands on a filter that LOOKS like the default
  // while still being the reader's own.
  //
  // This test is also true while the rail's page is still in flight, since `rows` is
  // the open session alone until it lands. Same answer either way: hold the column,
  // fill it when there is something to fill it with.
  const empty = railWouldHide({ total, rowCount: rows.length, hasFamily, filterTouched })

  // Hiding takes the agent picker with it, so a SEEDED filter that narrowed the
  // list this far would strand the reader with an empty gutter and no way to
  // widen it. The caller re-asks that question unfiltered — reported rather than
  // decided here because the rail does not own its fetches, and REPORTED FROM
  // HERE because this is the only place the whole verdict exists: `rows` is the
  // page merged with globally hydrated pins and the open row, and `hasFamily`
  // can keep a one-row page worth drawing on its own.
  //
  // Withheld until the rail's OWN inputs have settled. An unhydrated pin store and
  // an in-flight pin fetch both read as "no pins", which is indistinguishable from
  // a collapsed rail — and the caller latches the first verdict it is given, so
  // reporting that snapshot would freeze a race into a permanent widen. The
  // caller waits on lineage the same way before acting on this.
  const pinsSettled = pinsRead && (missingPinIds.length === 0 || hydratedPins !== undefined)
  useEffect(() => {
    if (!pinsSettled) return
    onWouldHideChange?.(empty)
  }, [empty, pinsSettled, onWouldHideChange])

  // ≤768px has no column to hold, so the list hangs off a shell-owned app-bar
  // button (see MobileActionSlot) whose panel is rendered below. Registration has
  // to happen before the empty early-return, or the hook order would depend on
  // whether the rail found rows.
  const toggleList = useCallback(() => setListOpen((v) => !v), [])
  const closeList = useCallback(() => setListOpen(false), [])
  useEffect(() => {
    if (empty) return
    registerMobileAction({
      icon: 'panel-right',
      label: 'Sessions list',
      active: listOpen,
      onClick: toggleList
    })
    return () => registerMobileAction(null)
  }, [empty, listOpen, toggleList, registerMobileAction])
  // The detail view survives navigation, so a tapped row would otherwise leave the
  // panel open over the session it just opened.
  useEffect(() => setListOpen(false), [currentId])

  if (empty) return <SessionRailSlot />

  const sessionRow = (s: Session): RailRow => {
    const channel = sessionChannelDisplay(s, cronName)
    const id = canonicalSessionId(s)
    const merged = !flatView && isMergedConversationRow(s)
    return {
      // The SESSION id: it is what `current` is matched against and what a fresh
      // pin records. Pin LOOKUP goes through every member (see sessionPinIds).
      id,
      platform: channel.platform,
      title: s.title,
      tooltip: `${s.title}\n${s.time} · ${channel.label}`,
      href: merged
        ? orgPath(`/conversations/${encodeURIComponent(s.conversationKey!)}`)
        : orgPath(`/sessions/${encodeURIComponent(id)}${flatSearch}`),
      pinId: rowPin(s).id,
      session: s
    }
  }
  // `relationLabel` names the edge in the tooltip and in sr-only text — the same
  // two words an attribution row uses, because it is the same edge: a lineage
  // parent and an in-room `wokenBy` differ only in where the other end lives,
  // and the row already shows that by being a link or not. Omitted for siblings,
  // whose slot means two different things by page (see conversation-lineage.ts).
  const relationRow = (relation: SessionRelationDto, relationLabel?: string): RailRow => {
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
  // A conversation row is pinned when ANY of its members is, and unpinning it
  // must release that same member — pinning the current representative instead
  // would leave the old pin behind, still claiming the row.
  const rowPin = (s: Session) => {
    const ids = pinIdsOf(s)
    return { pinned: ids.some(isPinned), id: ids.find(isPinned) ?? canonicalSessionId(s) }
  }
  // An attribution row answers WHO, so it is built around the agent, not the
  // session. The generic row renders a session title and a platform mark, and
  // neither identifies anyone here: participants of one thread routinely share
  // a title (it is derived from the same first message) and necessarily share
  // the platform, so a row built from those two fields would name nobody, and
  // several `woke` rows would be indistinguishable.
  //
  // The DIRECTION rides on the row's place in the tree — waker above the open
  // row, woken below it — and not on a heading, which spent a line restating
  // that indent and usually the title too: a conversation is named after its
  // first message, typically the human @mentioning the very agent that then
  // delegates. `relationLabel` moves into the hover tooltip, and stays as
  // `sr-only` text besides, since indentation is a visual relation that a
  // screen reader hears nothing of and a tooltip never reaches.
  //
  // It is also NOT navigation, which is §9.1's own title. The target is a
  // participant of the conversation already on screen, so `/sessions/:id` would
  // redirect straight back here (§5.3 carries no `?focus`, by decision) — a
  // round trip that lands the reader where they started. Render the fact: no
  // link, and no pin toggle, which is a shortcut to another conversation.
  //
  // Name resolution mirrors the filter chips: the org roster first, then the
  // relation's own projection (older CPs omit it), then the raw id — a
  // restricted agent can own a member session while staying out of this
  // viewer's roster, and showing an id beats showing nothing.
  const attributionRow = (relation: SessionRelationDto, depth: 0 | 1 | 2, relationLabel: string) => {
    const agent = agents.find((candidate) => candidate.id === relation.agentId)
    const name = agent ? agentLabel(agent) : relation.agentName?.trim() || relation.agentId
    const title = relation.title?.trim() || `Session ${relation.id.slice(0, 8)}`
    return (
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
        <span className="sr-only">{relationLabel}</span>
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-medium leading-normal">{name}</span>
      </div>
    )
  }

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
          href={item.href}
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
          {item.relationLabel && <span className="sr-only">{item.relationLabel}</span>}
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

  // The Related tree is exactly three levels — whatever woke the open row, the
  // open row, whatever it woke — and the indent is now the only thing saying
  // which is which. A cross-room parent and an in-room `wokenBy` are the SAME
  // edge seen from two locations, so they share level 0 rather than nesting:
  // the lift unions parents across every member without recording WHICH member
  // each one woke, so hanging `wokenBy` under `parent` would draw a chain the
  // data does not contain. `woke` and cross-room `children` share level 2 for
  // the same reason. Siblings sit at the open row's own level, below a divider.
  const aboveCurrent = Boolean(parent || wokenBy)
  const currentDepth = aboveCurrent ? 1 : 0
  const delegatedDepth = aboveCurrent ? 2 : 1

  const allSessionsQuery = new URLSearchParams()
  if (flatView) allSessionsQuery.set('view', 'flat')
  if (agentIds.length === 1) allSessionsQuery.set('agent', agentIds[0]!)
  const allSessionsHref = orgPath(`/sessions${allSessionsQuery.size ? `?${allSessionsQuery}` : ''}`)

  // One list, two containers: the ≥wide inline right column, and the 769–1239px
  // floating button whose hover/focus popover shows the same list. Duplicating
  // the rendered rows is cheap; duplicating the data plumbing would not be.
  const body = (
    <>
      {/* Header: the list names itself, and "All sessions" rides the title row so
          the escape to the full page is always visible, not below a long scroll.
          The link carries the rail's filter when the list can ask the same
          question — the sessions page filters by ONE agent, so a
          shared-conversation filter is dropped rather than silently narrowed. */}
      <div className="mb-[9px] flex flex-none items-center justify-between gap-2 px-[9px]">
        <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Sessions</span>
        <Link className="lnk font-sans text-[12px] font-medium leading-normal" href={allSessionsHref}>
          All sessions
          <Icon name="arrow-right" size={12} />
        </Link>
      </div>
      <RailAgentFilter agents={agents} selected={agentIds} onChange={onAgentIdsChange} />
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto">
        {hasFamily && (
          <>
            <div className="flex-none px-[9px] pb-[3px] font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase">
              Related
            </div>
            {parent && row(relationRow(parent, 'Delegated by'), isPinned(parent.id))}
            {/* Attribution, not navigation: the participant that woke the open
                row, then the ones it woke. Same lineage edge as `parent` — the
                only difference is that these two live in THIS conversation, so
                their link would come straight back to the page you are on.
                That difference is already in the row: an agent mark and a name
                that do not click, against a platform mark and a title that do. */}
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
    </>
  )

  return (
    <>
      {/* ≥1240px: inline right column. The in-flow div only reserves the track (box
          classes must match SessionRailSlot); the panel itself is FIXED to the
          viewport's right edge — sticky inside the padded `.content` scroller gets
          pushed down by its 34px top padding, so it could never sit flush. */}
      <div className="-mr-[30px] hidden w-[250px] flex-none wide:block">
        <div className="fixed top-0 right-0 bottom-0 flex w-[250px] flex-col border-l border-(--border-subtle) bg-(--surface-app) px-[13px] pt-[18px] pb-[10px]">
          {body}
        </div>
      </div>
      {/* 769–1239px: the rail collapses to a floating top-right button, opened by a
          CLICK. There is deliberately no CSS hover/focus reveal left here. This band
          is not mouse-only — a 1024px iPad has no hover and Safari does not focus a
          button on tap — so hover cannot be the opening path; and keeping it as a
          SECOND path made the state incoherent: closing the latch left the button
          still hovered/focused, so `group-hover:block` re-showed a panel whose
          trigger now read `aria-expanded="false"`, and the click looked ineffective.
          One latch drives both the panel and `aria-expanded`, in every band. */}
      <div className="fixed top-[10px] right-[14px] z-50 hidden desktop:max-wide:block">
        <button
          type="button"
          aria-label="Sessions list"
          aria-haspopup="true"
          aria-expanded={listOpen}
          onClick={toggleList}
          className={`flex h-9 w-9 items-center justify-center rounded-full border bg-(--surface-card) shadow-(--shadow-sm) hover:text-(--text-primary) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none ${
            listOpen ? 'border-(--brand) text-(--brand)' : 'border-(--border-default) text-(--text-secondary)'
          }`}
        >
          <Icon name="panel-right" size={16} />
        </button>
        {listOpen && (
          <div className="absolute top-full right-0 w-[264px] pt-[6px]">
            <div className="flex max-h-[75vh] flex-col rounded-lg border border-(--border-default) bg-(--surface-card) p-[10px] shadow-(--shadow-lg)">
              {body}
            </div>
          </div>
        )}
      </div>
      {/* ≤768px: the same list, dropped under the app bar by its shell-owned button.
          The trigger lives in `.mtop` rather than floating over the page, so it
          cannot cover the session title the way a fixed overlay would.

          Both nodes are `fixed` and sit at the top level of this fragment ON PURPOSE:
          the caller's row is a flex container with `gap-[26px]`, and an ordinary
          wrapper div here — zero-width, but still a flex ITEM — would spend that gap
          as 26px of dead space on the transcript's right edge. Positioned children
          are out of flow, so they are not flex items and contribute no gap. */}
      {/* Tap-away close for BOTH collapsed bands (`wide:hidden`), so a latched panel
          is never a trap on a device that cannot hover. It sits under the triggers
          (z-40 vs their z-50) so the tablet button still toggles itself shut; the
          mobile trigger lives in the un-layered app bar, so there the scrim takes
          that tap instead — which closes the panel just the same. */}
      {listOpen && <div className="fixed inset-0 z-40 wide:hidden" onClick={closeList} aria-hidden="true" />}
      {listOpen && (
        <div
          role="dialog"
          aria-label="Sessions list"
          className="fixed top-[52px] right-[8px] z-50 hidden max-h-[70vh] w-[min(300px,calc(100vw-16px))] flex-col rounded-lg border border-(--border-default) bg-(--surface-card) p-[10px] shadow-(--shadow-lg) max-desktop:flex"
        >
          {body}
        </div>
      )}
    </>
  )
}

// The filter above the list: one chip per selected agent, then the "+" picker.
// With nothing selected the chip row reads "All agents", so the rail always says
// what it is showing rather than leaving an unexplained gap above the first group.
//
// Multi-select: each menu row toggles its agent, and two or more of them narrow
// the list to the conversations they SHARE, which is a different question from
// the union of their sessions — see the CP's conversation-participant filter.
// The menu stays open while picking, because building a set of agents one
// closing menu at a time is three clicks for what should be two.
function RailAgentFilter({
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
  // A restricted agent can own the open session while staying out of this viewer's
  // roster; show the id rather than dropping the chip and silently misdescribing
  // the list as unfiltered.
  //
  // Both lists read alphabetically. Neither the roster nor the org agent list is
  // ordered by anything the reader can see — activity reshuffles one and the API
  // the other — so a filter that named the same agents twice in a row could still
  // look different each time.
  const chips = selected
    .map((id) => {
      const agent = agents.find((a) => a.id === id)
      return { id, label: agent ? agentLabel(agent) : id, agent }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
          {/* .fmenu anchors to the row's left edge; the rail is 224px, so widen the
              menu past its own 210px minimum only through the row's own width. */}
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
