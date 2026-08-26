'use client'

// The console's unified search (design: the top-bar `sr.*` box + `.srpanel`).
// One box searches agents, daemons, schedules and sessions BY NAME, plus the
// console's own pages and settings (the static SEARCH_PAGES index — labels and
// on-page feature keywords); results are grouped (each capped at 3, with the full
// match count shown), keyboard-navigable (↑↓ move · ↵ open · esc close), and ⌘K
// focuses it from anywhere. Selecting a result routes to that entity's page.
// Matching runs client-side over the already-loaded read models and the static
// page index — no new CP endpoint. The one extra read: opening authed search
// pulls the three session-access states through their existing endpoints
// (SWR-deduped with the Settings page) to gate that card's entry.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import {
  agentDaemonLabel,
  agentLabel,
  effectiveAgentStatus,
  groupFleetStatus,
  isPoolPlacementKind,
  localDaemons,
  placementIcon,
  poolFleetStatus,
  poolLabel,
  presentedDaemonStatus,
  status
} from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { cronHuman } from '@/lib/cron'
import { isAuthConfigured } from '@/lib/auth'
import { fetchSessionExternalAccess, type SessionAccessProvider } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'
import { SEARCH_PAGES, navVisible, type ConsolePage } from './nav'

type SearchKind = 'agent' | 'daemon' | 'schedule' | 'session' | 'page' | 'setting'

interface SearchItem {
  key: string
  kind: SearchKind
  title: string
  meta: string
  aux: string
  /** Agent status dot color; other kinds render an icon well instead. */
  dot?: string
  /** Agent avatar fields (agents only); runtime is the legacy-icon fallback. */
  icon?: AgentIcon | null
  model?: string
  runtime?: string
  /** Icon-well glyph: the entry's nav icon for a page/setting, the placement's own glyph for the
   *  pool and groups. Absent ⇒ the kind's default. */
  iconName?: string
  /** Org-scoped navigation target for this result. */
  href: string
}

interface SearchGroup {
  kind: SearchKind
  label: string
  count: number
  items: SearchItem[]
}

// The type-filter chips shown atop the results panel: "All" plus one per kind
// that has matches. `key: 'all'` clears the type narrowing.
type TypeFilter = 'all' | SearchKind

// Per-group result cap (design shows the first 3, with the total count beside the
// label so a wider match set is still discoverable).
const CAP = 3

// Icon-well glyph for every non-agent kind (agents render their avatar instead). Pages, settings
// and the three infra entities carry their own glyph on the item; the rest are fixed per kind.
const wellIcon = (it: SearchItem): string => {
  if (it.kind === 'daemon') return it.iconName ?? 'server'
  if (it.kind === 'schedule') return 'alarm-clock'
  if (it.kind === 'session') return 'message-square-text'
  return it.iconName ?? 'panel-left'
}

export function GlobalSearch({
  autoFocus = false,
  mobile = false,
  rail = false,
  onClose
}: { autoFocus?: boolean; mobile?: boolean; rail?: boolean; onClose?: () => void } = {}) {
  const router = useRouter()
  const { orgPath, myRole, activeOrg } = useOrgs()
  const { agents, daemons, crons, allSessions, memberSets, orgSetIds } = useConsoleData()

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [activeType, setActiveType] = useState<TypeFilter>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  // Shortcut hint: ⌘K on macOS, Ctrl K elsewhere. Detected post-mount so SSR
  // (which has no `navigator`) hydrates cleanly, then flips if on Windows/Linux.
  const [isMac, setIsMac] = useState(true)
  useEffect(() => {
    setIsMac(/Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent))
  }, [])

  const query = q.trim().toLowerCase()

  const daemonById = useMemo(() => new Map(daemons.map((d) => [d.daemonId, d])), [daemons])
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  // Settings/Profile only exist in authed mode — no-auth deployments bounce those
  // routes to /home (see Shell), so hide their search entries there. Detected
  // post-mount (like `isMac` above) because the runtime config lives on `window`.
  const [authed, setAuthed] = useState(false)
  useEffect(() => {
    setAuthed(isAuthConfigured())
  }, [])

  // The Session access card hides itself when every provider is unavailable AND
  // disabled (SettingsView's SessionAccessCard) — mirror that state so its search
  // entry never points at a missing anchor. Read only while the panel is open;
  // SWR dedupes these with the Settings page's own reads.
  const accessKey = (provider: SessionAccessProvider) =>
    open && authed ? consoleKeys.sessionAccess(activeOrg?.id, provider) : null
  const accessFetcher = ([, scopedOrgId, , provider]: NonNullable<ReturnType<typeof accessKey>>) =>
    fetchSessionExternalAccess(provider, scopedOrgId)
  const slackAccess = useSWR(accessKey('slack'), accessFetcher)
  const githubAccess = useSWR(accessKey('github'), accessFetcher)
  const feishuAccess = useSWR(accessKey('feishu'), accessFetcher)
  // Mirrors `hasNothingToOffer`: hidden only once all three are KNOWN dead —
  // pending/failed reads keep the entry, as the card also renders then.
  const sessionAccessRenders = [slackAccess, githubAccess, feishuAccess].some(
    ({ data }) => data === undefined || data.available || data.enabled
  )

  const groups = useMemo<SearchGroup[]>(() => {
    // `hit('')` matches everything, so an empty query yields every entity. That's
    // deliberate: the chip COUNTS use it (a filter row you can see before typing,
    // per the mobile design), while the RESULTS list stays gated on a non-empty
    // query via `shownGroups` below.
    const hit = (s: string | null | undefined) => (s ?? '').toLowerCase().includes(query)

    const agentMatches = agents.filter((a) => hit(agentLabel(a)) || hit(a.name))
    const agentItems: SearchItem[] = agentMatches.slice(0, CAP).map((a) => {
      // Gate "online" on the owning daemon being connected (as the Agents view does), and surface
      // what it RUNS ON by display name — never its host, and never a set resolved as a machine.
      const owning = daemonById.get(a.daemon)
      const s = status(effectiveAgentStatus(a, owning))
      const placement = agentDaemonLabel(a, daemons, memberSets)
      return {
        key: `agent:${a.id}`,
        kind: 'agent',
        title: agentLabel(a),
        meta: [a.model || undefined, placement === '—' ? undefined : placement].filter(Boolean).join(' · '),
        aux: s.label,
        dot: s.dot,
        icon: a.icon,
        model: a.model || a.runtime,
        runtime: a.runtime,
        href: orgPath(`/agents/${a.id}`)
      }
    })

    // Hosted-agent count per daemon — agents assigned to it (mirrors the detail
    // view's "Agents hosted"). NOT daemon.agents, which is the active-session count.
    const hostedByDaemon = new Map<string, number>()
    for (const a of agents) hostedByDaemon.set(a.daemon, (hostedByDaemon.get(a.daemon) ?? 0) + 1)
    const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
    // The Infra page's own three entities, in its own order — the pool as ONE entry, the machines,
    // then the groups. Matching `daemons` alone found every pool Pod under the pool's shared name
    // (N identical rows, each opening a Pod that a roll replaces) and no group at all.
    const poolMembers = featureFlagEnabled('daemon-pool') ? daemons.filter((d) => d.pool) : []
    const poolMatches =
      poolMembers.length > 0 && hit(poolLabel())
        ? [
            {
              key: 'daemon:pool',
              kind: 'daemon' as const,
              title: poolLabel(),
              meta: plural(
                agents.filter((a) => isPoolPlacementKind(a.placementKind, a.setId, orgSetIds)).length,
                'agent'
              ),
              aux: status(poolFleetStatus(poolMembers)).label,
              iconName: placementIcon('pool'),
              href: orgPath('/daemons/cluster')
            }
          ]
        : []
    const machineMatches = localDaemons(daemons)
      .filter((d) => hit(d.name))
      .map((d) => ({
        key: `daemon:${d.daemonId}`,
        kind: 'daemon' as const,
        title: d.name,
        meta: [d.version || undefined, plural(hostedByDaemon.get(d.daemonId) ?? 0, 'agent')]
          .filter(Boolean)
          .join(' · '),
        aux: status(presentedDaemonStatus(d)).label,
        iconName: placementIcon('daemon'),
        href: orgPath(`/daemons/${d.daemonId}`)
      }))
    const groupMatches = (featureFlagEnabled('daemon-groups') ? memberSets : [])
      .filter((group) => hit(group.name))
      .map((group) => ({
        key: `group:${group.setId}`,
        kind: 'daemon' as const,
        title: group.name,
        meta: [plural(group.memberDaemonIds.length, 'daemon'), plural(group.agentCount, 'agent')].join(' · '),
        aux: status(groupFleetStatus(group, daemons)).label,
        iconName: placementIcon('group'),
        href: orgPath(`/daemons/groups/${group.setId}`)
      }))
    const daemonMatches: SearchItem[] = [...poolMatches, ...machineMatches, ...groupMatches]
    const daemonItems = daemonMatches.slice(0, CAP)

    // Only named schedules are searchable — legacy/CLI cron rows have a null name.
    // The `c.name` guard also keeps them out of the empty-query chip count (where
    // `hit('')` would otherwise match a null name).
    const cronMatches = crons.filter((c) => c.name != null && hit(c.name))
    const cronItems: SearchItem[] = cronMatches.slice(0, CAP).map((c) => {
      const owner = c.agentId ? agentById.get(c.agentId) : undefined
      const agentName = owner ? agentLabel(owner) : c.agentId ? c.agentId.slice(0, 8) : '—'
      return {
        key: `schedule:${c.id}`,
        kind: 'schedule',
        title: c.name ?? '—',
        meta: [agentName, cronHuman(c.schedule)].filter(Boolean).join(' · '),
        aux: c.enabled ? 'enabled' : 'disabled',
        href: orgPath(`/crons/${c.id}`)
      }
    })

    const sessionMatches = allSessions.filter((s) => hit(s.title))
    const sessionItems: SearchItem[] = sessionMatches.slice(0, CAP).map((s) => ({
      key: `session:${s.id}`,
      kind: 'session',
      title: s.title,
      meta: [s.agentName, s.channel].filter(Boolean).join(' · '),
      aux: s.time,
      href: orgPath(`/sessions/${s.id}`)
    }))

    // Console pages and settings — the static SEARCH_PAGES index. Matches on the
    // label or any keyword (route aliases + the settings that live on the page).
    const pageHit = (p: ConsolePage) => hit(p.label) || (p.keywords ?? []).some(hit)
    const toItem = (p: ConsolePage): SearchItem => ({
      key: `${p.kind}:${p.href}`,
      kind: p.kind,
      title: p.label,
      meta: p.href,
      aux: '',
      iconName: p.icon,
      href: orgPath(p.href)
    })
    // `navVisible` keeps search from offering a destination this deployment does
    // not have — the rail hides those, and a result must not dead-end either.
    const pageMatches = SEARCH_PAGES.filter((p) => p.kind === 'page' && navVisible(p) && pageHit(p))
    // Owner-only entries point at cards SettingsView doesn't render for other
    // roles — hide them so a result never navigates to a missing anchor. Same
    // for Session access when the whole card is absent on this deployment.
    const settingMatches = authed
      ? SEARCH_PAGES.filter(
          (p) =>
            p.kind === 'setting' &&
            (!p.ownerOnly || myRole === 'owner') &&
            (p.href !== '/settings#session-access' || sessionAccessRenders) &&
            pageHit(p)
        )
      : []

    // Keep all groups (even empty ones) so the chip row can show every type's
    // count; the visible list filters empties + the active type below.
    return [
      { kind: 'agent' as const, label: 'Agents', count: agentMatches.length, items: agentItems },
      { kind: 'daemon' as const, label: 'Daemons', count: daemonMatches.length, items: daemonItems },
      { kind: 'schedule' as const, label: 'Schedules', count: cronMatches.length, items: cronItems },
      { kind: 'session' as const, label: 'Sessions', count: sessionMatches.length, items: sessionItems },
      {
        kind: 'page' as const,
        label: 'Pages',
        count: pageMatches.length,
        items: pageMatches.slice(0, CAP).map(toItem)
      },
      {
        kind: 'setting' as const,
        label: 'Settings',
        count: settingMatches.length,
        items: settingMatches.slice(0, CAP).map(toItem)
      }
    ]
  }, [
    query,
    agents,
    daemons,
    memberSets,
    orgSetIds,
    crons,
    allSessions,
    daemonById,
    agentById,
    orgPath,
    authed,
    myRole,
    sessionAccessRenders
  ])

  const totalCount = useMemo(() => groups.reduce((n, g) => n + g.count, 0), [groups])
  // Chips: "All" + every kind with at least one match.
  const typeChips = useMemo<{ key: TypeFilter; label: string; count: number }[]>(
    () => [
      { key: 'all', label: 'All', count: totalCount },
      ...groups.filter((g) => g.count > 0).map((g) => ({ key: g.kind, label: g.label, count: g.count }))
    ],
    [groups, totalCount]
  )
  // The groups actually rendered: only once there's a query, non-empty, narrowed
  // to the active type chip. Empty query → no results (the hint shows instead),
  // even though the chips above still display per-type counts.
  const shownGroups = useMemo(
    () => (query ? groups.filter((g) => g.items.length > 0 && (activeType === 'all' || g.kind === activeType)) : []),
    [groups, activeType, query]
  )

  const flat = useMemo(() => shownGroups.flatMap((g) => g.items), [shownGroups])
  const idxByKey = useMemo(() => new Map(flat.map((it, i) => [it.key, i])), [flat])
  // Keep the highlight in range as the result set shrinks/grows under the cursor.
  const selClamped = Math.min(sel, Math.max(0, flat.length - 1))

  const reset = useCallback(() => {
    setOpen(false)
    setQ('')
    setSel(0)
    setActiveType('all')
  }, [])

  const go = useCallback(
    (item: SearchItem) => {
      reset()
      router.push(item.href)
    },
    [reset, router]
  )

  // When mounted inside the mobile full-screen search overlay, open + focus the input
  // immediately (the desktop instance stays closed until ⌘K / focus).
  useEffect(() => {
    if (!autoFocus) return
    setOpen(true)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [autoFocus])

  // ⌘K / Ctrl-K opens + focuses the box from anywhere in the console.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen(true)
        setTimeout(() => inputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length) setSel((selClamped + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length) setSel((selClamped - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      const item = flat[selClamped]
      if (item) go(item)
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const isHint = open && query === ''
  const isEmpty = open && query !== '' && totalCount === 0
  const hasResults = open && flat.length > 0
  // The active type chip filtered everything out, though other types have matches.
  const noneInType = open && query !== '' && totalCount > 0 && flat.length === 0

  // Type-filter chip row for the DESKTOP panel — only once there's a query with
  // matches (the mobile screen renders its own always-on strip below). Null
  // otherwise. (`groups` now computes on an empty query too, so gate on `query`.)
  const typeChipRow =
    query !== '' && totalCount > 0 ? (
      <div className="srfilters">
        {typeChips.map((c) => (
          <button
            key={c.key}
            className={activeType === c.key ? 'srchip on' : 'srchip'}
            onClick={() => {
              setActiveType(c.key)
              setSel(0)
            }}
          >
            {c.label}
            <span className="srchipn">{c.count}</span>
          </button>
        ))}
      </div>
    ) : null

  const mark = (it: SearchItem) => {
    if (it.kind === 'agent')
      return (
        <span className="srsq">
          <AgentIconView icon={it.icon} runtime={it.runtime || it.model || ''} size={26} />
          {it.dot && <span className="srdot" style={{ background: it.dot }} />}
        </span>
      )
    return (
      <span className="srwell">
        <Icon name={wellIcon(it)} size={14} />
      </span>
    )
  }

  // ── mobile: full-screen search screen (design's Search push) ────────────────
  // Owns the whole screen — search bar + inline results — so it doesn't inherit the
  // desktop 340px box / ⌘K hint / floating dropdown chrome.
  if (mobile) {
    const close = () => {
      reset()
      onClose?.()
    }
    return (
      <div className="fixed inset-0 z-80 flex flex-col bg-(--surface-card)">
        <div className="flex h-16 flex-none items-center gap-1 border-b border-(--border-subtle) pr-2 pl-3">
          <div className="box-border flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-(--brand) px-3 shadow-[0_0_0_3px_var(--magenta-100)]">
            <Icon name="search" size={18} color="var(--text-tertiary)" />
            <input
              ref={inputRef}
              value={q}
              placeholder="Search agents, daemons, schedules…"
              onChange={(e) => {
                setQ(e.target.value)
                setSel(0)
              }}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[15px] font-normal leading-normal text-(--text-primary) outline-none"
            />
            {q !== '' && (
              <button
                onClick={() => {
                  setQ('')
                  setSel(0)
                  inputRef.current?.focus()
                }}
                aria-label="Clear"
                className="flex h-5 w-5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-(--text-tertiary)"
              >
                <Icon name="circle-x" size={18} />
              </button>
            )}
          </div>
          <button
            onClick={close}
            className="h-11 flex-none cursor-pointer border-0 bg-transparent px-3 font-sans text-[14px] font-semibold leading-normal text-(--text-secondary)"
          >
            Cancel
          </button>
        </div>

        {/* Type-filter chips — a fixed, horizontally-scrollable strip below the
            search bar (the mobile design's own style: equal-width chips, not the
            desktop panel's wrapping .srchip row). */}
        {totalCount > 0 && (
          <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-(--border-subtle) bg-(--surface-card) px-3 py-[10px]">
            {typeChips.map((c) => {
              const on = activeType === c.key
              return (
                <button
                  key={c.key}
                  onClick={() => {
                    setActiveType(c.key)
                    setSel(0)
                  }}
                  className={`inline-flex h-[30px] min-w-0 flex-[1_1_auto] cursor-pointer items-center justify-center gap-1 rounded-full border px-[7px] font-sans text-[11.5px] font-medium leading-normal whitespace-nowrap ${
                    on
                      ? 'border-(--brand) bg-(--brand) text-white'
                      : 'border-(--border-default) bg-(--surface-card) text-(--text-secondary)'
                  }`}
                >
                  {c.label}
                  <span
                    className={`font-mono text-[10px] font-semibold ${on ? 'text-white/80' : 'text-(--text-tertiary)'}`}
                  >
                    {c.count}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto pb-6">
          {query === '' && (
            <div className="px-4 py-6 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              Type to search agents, daemons, schedules and sessions by name, or jump to a page or setting.
            </div>
          )}
          {isEmpty && (
            <div className="px-4 py-6 text-center">
              <div className="font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                No results for “{q.trim()}”
              </div>
              <div className="mt-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                Search matches agent, daemon, schedule and session names, plus console pages and settings.
              </div>
            </div>
          )}
          {noneInType && (
            <div className="px-4 py-[18px] text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              No matches in this type.
            </div>
          )}
          {shownGroups.map((g) => (
            <div key={g.label}>
              <div className="flex items-baseline gap-[7px] px-4 pt-4 pb-[6px] font-mono text-[11px] font-semibold uppercase leading-normal tracking-[.08em] text-(--text-tertiary)">
                {g.label} <span className="font-medium text-(--text-disabled)">{g.count}</span>
              </div>
              {g.items.map((it) => (
                <button
                  key={it.key}
                  onClick={() => {
                    go(it)
                    onClose?.()
                  }}
                  className="box-border flex min-h-14 w-full cursor-pointer items-center gap-3 border-0 bg-(--surface-card) px-4 py-2 text-left"
                >
                  {it.kind === 'agent' ? (
                    <span className="relative flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
                      <span className="flex h-5 w-5">
                        <AgentIconView icon={it.icon} runtime={it.runtime || it.model || ''} size={20} />
                      </span>
                      {it.dot && (
                        <span
                          className="absolute -right-[2px] -bottom-[2px] h-[10px] w-[10px] rounded-full border-2 border-(--surface-card)"
                          style={{ background: it.dot }}
                        />
                      )}
                    </span>
                  ) : (
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken) text-(--text-secondary)">
                      <Icon name={wellIcon(it)} size={16} />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                    <span className="truncate font-sans text-[14px] font-medium leading-normal text-(--text-primary)">
                      {it.title}
                    </span>
                    <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {it.meta}
                    </span>
                  </span>
                  <span className="flex-none font-mono text-[12px] font-medium leading-normal text-(--text-tertiary)">
                    {it.aux}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    // `railsr` re-seats this same markup as a centred command dialog — the box is
    // hidden until opened, then floats with its panel (globals.css `.railsr`).
    <div className={rail ? 'searchwrap railsr' : 'searchwrap'}>
      <div className={open ? 'search focus' : 'search'}>
        <Icon name="search" size={16} color="var(--text-tertiary)" />
        <input
          ref={inputRef}
          className="srinput"
          placeholder="Search agents, daemons, schedules…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
        />
        {!open && (
          <span className="kbd inline-flex items-center gap-[2px]">
            {isMac ? <Icon name="command" size={11} strokeWidth={1.5} /> : 'Ctrl'}K
          </span>
        )}
        {open && q !== '' && (
          <button
            onClick={() => {
              setQ('')
              setSel(0)
              inputRef.current?.focus()
            }}
            title="Clear"
            className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-(--text-tertiary)"
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="srscrim" onClick={() => setOpen(false)} />
          <div className="srpanel">
            {typeChipRow}
            {isHint && (
              <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                Type to search agents, daemons, schedules and sessions by name, or jump to a page or setting.
              </div>
            )}
            {isEmpty && (
              <div className="px-4 py-5 text-center">
                <div className="font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                  No results for “{q.trim()}”
                </div>
                <div className="mt-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  Search matches agent, daemon, schedule and session names, plus console pages and settings.
                </div>
              </div>
            )}
            {noneInType && (
              <div className="px-4 py-[18px] text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                No matches in this type.
              </div>
            )}
            {hasResults && (
              <div className="srlist">
                {shownGroups.map((g) => (
                  <div key={g.label}>
                    <div className="srlbl">
                      {g.label}
                      <b>{g.count}</b>
                    </div>
                    {g.items.map((it) => {
                      const on = idxByKey.get(it.key) === selClamped
                      return (
                        <button
                          key={it.key}
                          className={on ? 'sritem on' : 'sritem'}
                          onClick={() => go(it)}
                          onMouseMove={() => {
                            const i = idxByKey.get(it.key)
                            if (i !== undefined) setSel(i)
                          }}
                        >
                          {mark(it)}
                          <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                            <span className="srtitle">{it.title}</span>
                            <span className="srmeta">{it.meta}</span>
                          </span>
                          <span className="sraux">{it.aux}</span>
                          {on && <span className="kbd">↵</span>}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            <div className="srfoot">
              <span>
                <span className="kbd">↑↓</span> navigate
              </span>
              <span>
                <span className="kbd">↵</span> open
              </span>
              <span>
                <span className="kbd">esc</span> close
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
