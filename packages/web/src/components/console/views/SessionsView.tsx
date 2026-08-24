'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AGENTS,
  MOCK_MODE,
  PLAYGROUND_CHANNEL_FILTER,
  agentLabel,
  canonicalSessionId,
  enrichSessionWithAgent,
  isMergedConversationRow,
  mergeCanonicalSessions,
  platName,
  sessionChannelDisplay,
  sessionChannelFilterValue,
  sessionPlatform,
  status,
  type Agent,
  type Session
} from '@/lib/data'
import { fmtDate, memberDisplayName, type HookKind, type MemberDto, type SessionListFilters } from '@/lib/api'
import {
  githubRepoIdFromSessionTriggerFilter,
  sessionSenderLabel,
  sessionTriggerFilterValue,
  sessionTriggerKind,
  HOOK_KIND_GROUP_LABEL,
  HOOK_TRIGGER_KINDS,
  type SessionTriggerKind
} from '@/lib/session-trigger'
import { useConsoleData } from '@/lib/data-context'
import { useSessionFacets } from '@/lib/use-session-facets'
import { useSessionList } from '@/lib/use-session-list'
import { isFlatSessionView, sessionListSearchParams } from '@/lib/session-list-view'
import { useProfile } from '@/lib/profile'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { useMobileFilterSlot } from '@/components/console/Shell'
import { AgentIconView, GithubMark, GitlabMark, LoadingState, PlatformMark } from '@/components/marks'
import { RestrictedLock } from '@/components/console/VisibilityField'
import { Avatar, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

type FilterKey = 'agent' | 'integration' | 'channel' | 'trigger'
const DEMO_AGENT_IDS = new Set(AGENTS.map((agent) => agent.id))

// Avatar initials for a person trigger — strip a leading @, then first letters of
// the first two words (or the first two chars of a single token).
function initialsOf(label: string): string {
  const s = label.replace(/^@/, '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/).filter(Boolean)
  const chars = parts.length >= 2 ? parts[0]!.charAt(0) + parts[1]!.charAt(0) : s.slice(0, 2)
  return chars.toUpperCase()
}

// A person's AgentConnect avatar chip — use the profile photo when the sender is a
// console member, else fall back to initials. External IM senders use their platform mark.
function AvatarFace({ label, member }: { label: string; member?: MemberDto }) {
  if (member) return <Avatar src={member.picture} initials={initialsOf(label)} size={20} fontSize={8.5} />
  return (
    <span className="flex h-full w-full items-center justify-center rounded-full bg-(--surface-active) font-sans text-[8.5px] font-semibold leading-none text-(--text-secondary)">
      {initialsOf(label)}
    </span>
  )
}

/** Retention GC (#485): the owning daemon deleted this session's transcript (and
 *  any workspace it had), so the row still lists but can never be replayed. Marked
 *  in the list rather than hidden — the metadata is deliberately kept. */
function PurgedMark({ session }: { session: Session }) {
  if (!session.contentPurgedAt) return null
  const when = fmtDate(session.contentPurgedAt)
  return (
    <span
      title={
        session.contentPurgedPartial
          ? `Part of this conversation's history was deleted from ${when} by the session retention policy`
          : `Transcript deleted ${when} by the session retention policy — only metadata remains`
      }
      className="inline-flex flex-none"
    >
      <Icon name="trash-2" size={12} color="var(--text-tertiary)" />
    </span>
  )
}

function activityMs(s: Session): number {
  if (!s.lastActivityAt) return Number.NEGATIVE_INFINITY
  const ms = Date.parse(s.lastActivityAt)
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

export default function SessionsView() {
  const { activeOrg, orgPath } = useOrgs()
  const { agents, allSessions, sessionFacets: baseSessionFacets, crons, members } = useConsoleData()
  const { pgSessionList } = usePlayground()
  const { me } = useProfile()
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const agentNameById = useMemo(() => new Map(agents.map((a) => [a.id, agentLabel(a)])), [agents])
  const params = useSearchParams()
  const router = useRouter()

  // Resolve a session's `cron:<id>` trigger to its schedule (name + deep-link).
  const cronById = useMemo(() => new Map(crons.map((c) => [c.id, c])), [crons])
  const memberNameByIdentity = useMemo(() => {
    const names = new Map<string, string>()
    for (const m of members) {
      const label = memberDisplayName(m)
      names.set(m.userId, label)
      if (m.email) names.set(m.email, label)
    }
    return names
  }, [members])
  const memberByIdentity = useMemo(() => {
    const byIdentity = new Map<string, MemberDto>()
    for (const m of members) {
      byIdentity.set(m.userId, m)
      if (m.email) byIdentity.set(m.email, m)
    }
    return byIdentity
  }, [members])
  const triggerLabel = useCallback(
    (s: Session) => {
      return sessionSenderLabel(s.triggeredBy, s.user, agentNameById, memberNameByIdentity, me)
    },
    [agentNameById, me, memberNameByIdentity]
  )

  const fAgent = params.get('agent') ?? 'all'
  const fInt = params.get('integration') ?? 'all'
  const fChannel = params.get('channel') ?? 'all'
  const fTrigger = params.get('trigger') ?? 'all'
  const flatView = isFlatSessionView(params)
  const fGithubRepoId = githubRepoIdFromSessionTriggerFilter(fTrigger)
  const sessionFilters = {
    ...(fAgent !== 'all' ? { agentId: fAgent } : {}),
    ...(fInt !== 'all' ? { integration: fInt } : {}),
    ...(fChannel === PLAYGROUND_CHANNEL_FILTER
      ? { platform: 'webchat' }
      : fChannel !== 'all'
        ? { channel: fChannel }
        : {}),
    ...(fGithubRepoId ? { githubRepoId: fGithubRepoId } : fTrigger !== 'all' ? { triggeredBy: fTrigger } : {})
  } satisfies SessionListFilters
  const sessionList = useSessionList(activeOrg?.id, sessionFilters, { grouped: !flatView })
  const { data: sessionFacets = baseSessionFacets } = useSessionFacets(activeOrg?.id, sessionFilters, baseSessionFacets)
  const demoSessions = useMemo(
    () => (MOCK_MODE ? allSessions.filter((session) => DEMO_AGENT_IDS.has(session.agentId ?? '')) : []),
    [allSessions]
  )
  const matchesLocalFilters = useCallback(
    (session: Session, excluded?: FilterKey) =>
      (excluded === 'agent' || fAgent === 'all' || session.agentId === fAgent) &&
      (excluded === 'integration' || fInt === 'all' || sessionPlatform(session) === fInt) &&
      (excluded === 'channel' || fChannel === 'all' || sessionChannelFilterValue(session) === fChannel) &&
      (excluded === 'trigger' || fTrigger === 'all' || session.triggeredBy === fTrigger),
    [fAgent, fChannel, fInt, fTrigger]
  )
  const localSourceSessions = useMemo(() => [...pgSessionList, ...demoSessions], [demoSessions, pgSessionList])
  const localSessions = useMemo(
    () => localSourceSessions.filter((session) => matchesLocalFilters(session)),
    [localSourceSessions, matchesLocalFilters]
  )
  const localFacetSessions = useMemo(
    () => ({
      agents: localSourceSessions.filter((session) => matchesLocalFilters(session, 'agent')),
      integrations: localSourceSessions.filter((session) => matchesLocalFilters(session, 'integration')),
      channels: localSourceSessions.filter((session) => matchesLocalFilters(session, 'channel')),
      triggers: localSourceSessions.filter((session) => matchesLocalFilters(session, 'trigger'))
    }),
    [localSourceSessions, matchesLocalFilters]
  )
  const filteredServerSessions = useMemo(
    () =>
      sessionList.sessions.map((session) =>
        enrichSessionWithAgent(session, session.agentId ? agentById.get(session.agentId) : undefined)
      ),
    [agentById, sessionList.sessions]
  )
  // Live playground sessions, the filtered CP page chain, and demo rows share
  // one timeline. A real ACP id replaces its temporary playground row.
  const sessions = useMemo<Session[]>(() => {
    return mergeCanonicalSessions([...filteredServerSessions, ...localSessions])
      .map((s, index) => ({ s, index }))
      .sort((a, b) => {
        const at = activityMs(a.s)
        const bt = activityMs(b.s)
        return bt === at ? a.index - b.index : bt - at
      })
      .map(({ s }) => s)
  }, [filteredServerSessions, localSessions])
  const filterQuery = useMemo(() => {
    return sessionListSearchParams(params).toString()
  }, [params])
  const sessionHref = useCallback(
    (session: Session) => {
      // A multi-participant conversation row links to the merged page — the only
      // default view for it (merged-conversation-view.md §5.3). The explicit flat
      // list keeps the member session addressable instead.
      if (!flatView && isMergedConversationRow(session)) {
        return orgPath(`/conversations/${encodeURIComponent(session.conversationKey!)}`)
      }
      const id = canonicalSessionId(session)
      const query = new URLSearchParams(filterQuery)
      const provider = sessionPlatform(session)
      if (provider === 'slack' || provider === 'github') query.set('source', provider)
      const suffix = query.size ? `?${query.toString()}` : ''
      return orgPath(`/sessions/${id}${suffix}`)
    },
    [filterQuery, flatView, orgPath]
  )

  const setFilter = useCallback(
    (key: FilterKey, val: string) => {
      const next = new URLSearchParams(params.toString())
      if (val === 'all') next.delete(key)
      else next.set(key, val)
      const qs = next.toString()
      router.replace(orgPath(qs ? `/sessions?${qs}` : '/sessions'))
    },
    [params, router, orgPath]
  )

  const cols = 'grid-cols-[2.3fr_1.1fr_1.4fr_.9fr_.8fr_28px] gap-3'

  // ── Filter options — each carries a `face` (the design puts a per-option visual
  //    in both the dropdown button and its menu rows): agent marks, platform marks,
  //    people avatars, schedule clocks. The "all" row's face is the category icon. ──
  const intSet = new Map(sessionFacets.integrations.map((platform) => [platform, platName(platform)]))
  const chMap = new Map(
    sessionFacets.channels.map((channel) => [
      sessionChannelFilterValue({
        platform: channel.platform,
        channel: channel.label,
        channelId: channel.value
      }),
      // Headless-schedule channels keep their raw `cron:<id>` filter value but
      // render as the schedule's name under the schedule mark.
      sessionChannelDisplay({ platform: channel.platform, channel: channel.label }, (id) => cronById.get(id)?.name)
    ])
  )
  const triggerSources = new Map(
    sessionFacets.triggers.map((trigger) => [
      trigger.value,
      {
        name: trigger.name,
        platform: trigger.platform,
        hookKind: trigger.hookKind,
        filterValue: sessionTriggerFilterValue(trigger)
      }
    ])
  )
  const facetAgentIds = new Set(sessionFacets.agentIds)
  const facetAgentNames = new Map(Object.entries(sessionFacets.agentNames))
  for (const session of localFacetSessions.agents) {
    if (!session.agentId) continue
    facetAgentIds.add(session.agentId)
    if (session.agentName?.trim()) facetAgentNames.set(session.agentId, session.agentName.trim())
  }
  // Playground and demo sessions are not part of the CP index. Merge each
  // facet from local rows that already satisfy the other three active filters.
  for (const session of localFacetSessions.integrations) {
    const platform = sessionPlatform(session)
    intSet.set(platform, platName(platform))
  }
  for (const session of localFacetSessions.channels) {
    const platform = sessionPlatform(session)
    const channel = sessionChannelFilterValue(session)
    if (!chMap.has(channel)) chMap.set(channel, { label: session.channel, platform })
  }
  for (const session of localFacetSessions.triggers) {
    const platform = sessionPlatform(session)
    if (session.triggeredBy && !triggerSources.has(session.triggeredBy)) {
      triggerSources.set(session.triggeredBy, {
        name: session.user,
        platform,
        hookKind: session.hookKind,
        filterValue: session.triggeredBy
      })
    }
  }
  // Triggerers are keyed by raw triggeredBy id so same-named entries stay distinct.
  // Agent ids resolve only through the caller-visible agent roster; hook sessions use
  // their CP-enriched source kind to keep each code host distinct from generic webhooks.
  const triggerAgentSet = new Map<string, Agent>()
  const peopleSet = new Map<string, { label: string; platform: string; member?: MemberDto }>()
  // One bucket per hook kind, keyed by the shared vocabulary rather than by hand — a
  // hook trigger can no longer land in a bucket nobody collects, which is how GitLab
  // sessions used to disappear from this menu instead of getting their own group.
  const hookSets = new Map<HookKind, Map<string, string>>(HOOK_TRIGGER_KINDS.map((kind) => [kind, new Map()]))
  const cronSet = new Map<string, string>()
  for (const [triggeredBy, source] of triggerSources) {
    const label = sessionSenderLabel(triggeredBy, source.name, agentNameById, memberNameByIdentity, me)
    const kind = sessionTriggerKind({ triggeredBy, hookKind: source.hookKind }, agentById)
    switch (kind) {
      case null:
        break
      case 'schedule': {
        const id = triggeredBy.slice(5)
        cronSet.set(triggeredBy, cronById.get(id)?.name?.trim() || `Schedule ${id.slice(0, 8)}`)
        break
      }
      case 'agent': {
        const agent = agentById.get(triggeredBy)
        if (agent) triggerAgentSet.set(triggeredBy, agent)
        break
      }
      case 'person':
        peopleSet.set(triggeredBy, {
          label,
          platform: source.platform,
          member: memberByIdentity.get(triggeredBy)
        })
        break
      // Everything left is a hook kind — the arms above narrow it, so a new NON-hook
      // trigger kind fails to compile here rather than being silently dropped.
      default: {
        // GitHub subscriptions collapse per repository through `filterValue`; every
        // other kind, GitLab included, filters by its own raw trigger value.
        const bucket = hookSets.get(kind)!
        if (!bucket.has(source.filterValue)) bucket.set(source.filterValue, label)
      }
    }
  }
  const catFace = (name: string) => <Icon name={name} size={15} color="var(--text-tertiary)" />
  const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label)
  const agentAvatar = (agentId: string | undefined, fallbackRuntime: string | undefined, size: number) => {
    const agent = agentId ? agentById.get(agentId) : undefined
    return (
      <AgentIconView icon={agent?.icon} runtime={agent?.runtime || fallbackRuntime || agent?.model || ''} size={size} />
    )
  }
  // Multi-participant conversation rows (merged-conversation-view.md §5.2):
  // stacked participant icons replace the single agent face; each icon names
  // its agent on hover, while the compact label carries only the total.
  const agentCell = (s: Session, av: string, size: number, label: string) => {
    const roster = s.participants ?? []
    if (roster.length <= 1) {
      return (
        <>
          <span className={`av flex-none ${av}`}>{agentAvatar(s.agentId, s.model, size)}</span>
          <span className={`truncate ${label}`}>{s.agentName}</span>
        </>
      )
    }
    const participantName = (participant: (typeof roster)[number]) => {
      const agent = agentById.get(participant.agentId)
      if (agent) return agentLabel(agent)
      const fallback = participant.name.trim()
      return fallback && fallback !== participant.agentId && fallback !== participant.agentId.slice(0, 8)
        ? fallback
        : 'Agent'
    }
    const rosterNames = roster.map(participantName)
    return (
      <>
        <span className="flex flex-none items-center -space-x-[5px]" data-tooltip-focus-text={rosterNames.join('\n')}>
          {roster.slice(0, 4).map((p) => (
            <span key={p.agentId} className={`av flex-none ${av}`} title={participantName(p)}>
              {agentAvatar(p.agentId, undefined, size)}
            </span>
          ))}
        </span>
        <span className={`truncate ${label}`}>
          <span aria-hidden="true">+{roster.length}</span>
          <span className="sr-only">
            {roster.length} agents: {rosterNames.join(', ')}
          </span>
        </span>
      </>
    )
  }

  const agentOpts: FilterOption[] = [
    { v: 'all', label: 'All agents', face: catFace('bot') },
    ...agents
      .filter((agent) => facetAgentIds.has(agent.id))
      .map((a) => ({
        v: a.id,
        label: agentLabel(a),
        face: <AgentIconView icon={a.icon} runtime={a.runtime} size={18} />
      })),
    // A Session facet may name an Agent outside the caller-visible Agent
    // roster. It remains a plain Session filter with no Agent navigation.
    ...[...facetAgentIds]
      .filter((agentId) => !agentById.has(agentId) && facetAgentNames.has(agentId))
      .map((agentId) => ({
        v: agentId,
        label: facetAgentNames.get(agentId)!,
        face: catFace('bot')
      }))
  ]
  const integrationOpts: FilterOption[] = [
    { v: 'all', label: 'All integrations', face: catFace('plug') },
    ...[...intSet].map(([v, label]) => ({ v, label, face: <PlatformMark platform={v} fillPct={100} /> }))
  ]
  // Channels lead with the `#` category glyph; the source platform sits on the right.
  const channelOpts: FilterOption[] = [
    { v: 'all', label: 'All channels', face: catFace('hash') },
    ...[...chMap].map(([value, channel]) => ({
      v: value,
      label: channel.label,
      face: catFace('hash'),
      rightFace: <PlatformMark platform={channel.platform} fillPct={100} />,
      pillFace: <PlatformMark platform={channel.platform} fillPct={100} />
    }))
  ]
  const triggerAll: FilterOption = { v: 'all', label: 'All triggers', face: catFace('zap') }
  const triggerAgents: FilterOption[] = [...triggerAgentSet]
    .map(([v, agent]) => ({
      v,
      label: agentLabel(agent),
      kind: 'agent' as const,
      face: <AgentIconView icon={agent.icon} runtime={agent.runtime} size={18} />
    }))
    .sort(byLabel)
  // People lead with their avatar; their source platform sits on the right.
  const triggerPeople: FilterOption[] = [...peopleSet]
    .map(([v, p]) => ({
      v,
      label: p.label,
      kind: 'person' as const,
      face: <AvatarFace label={p.label} member={p.member} />,
      rightFace: <PlatformMark platform={p.platform} fillPct={100} />
    }))
    .sort(byLabel)
  // Total over the hook-kind vocabulary: a new code host has to be given a face here.
  const hookTriggerFace: Record<HookKind, ReactNode> = {
    github: (
      <span className="flex h-[15px] w-[15px] items-center justify-center">
        <GithubMark color="var(--text-tertiary)" />
      </span>
    ),
    gitlab: (
      <span className="flex h-[15px] w-[15px] items-center justify-center">
        <GitlabMark />
      </span>
    ),
    webhook: catFace('webhook')
  }
  // One group per hook kind in display order, code hosts before generic webhooks.
  const hookTriggerGroups: FilterGroup[] = HOOK_TRIGGER_KINDS.map((kind) => ({
    label: HOOK_KIND_GROUP_LABEL[kind],
    options: [...hookSets.get(kind)!]
      .map(([v, label]) => ({ v, label, kind, face: hookTriggerFace[kind] }))
      .sort(byLabel)
  }))
  const triggerScheds: FilterOption[] = [...cronSet]
    .map(([v, label]) => ({ v, label, kind: 'schedule' as const, face: catFace('timer') }))
    .sort(byLabel)
  const triggerGroups: FilterGroup[] = [
    { label: 'Agents', options: triggerAgents },
    { label: 'People', options: triggerPeople },
    ...hookTriggerGroups,
    { label: 'Schedules', options: triggerScheds }
  ]
  const triggerFlat: FilterOption[] = [
    triggerAll,
    ...triggerAgents,
    ...triggerPeople,
    ...hookTriggerGroups.flatMap((group) => group.options),
    ...triggerScheds
  ]

  const filtered = sessions
  const loadedServerIds = new Set(sessionList.sessions.map((session) => session.id))
  const localOnlyCount = localSessions.filter((session) => !loadedServerIds.has(canonicalSessionId(session))).length
  const totalCount = sessionList.total + localOnlyCount
  const filtActive = !(fAgent === 'all' && fInt === 'all' && fChannel === 'all' && fTrigger === 'all')
  const initialLoading = sessionList.isLoading && sessions.length === 0
  const showEmpty = totalCount === 0 && filtered.length === 0 && !initialLoading
  const countLabel = `${totalCount} ${totalCount === 1 ? 'session' : 'sessions'}`

  // Active-filter chips (mobile, sheet closed) — label + one-tap clear per filter.
  const labelOf = (opts: FilterOption[], v: string) => opts.find((o) => o.v === v)?.label ?? v
  const activeChips = [
    fAgent !== 'all' && { key: 'agent' as const, label: labelOf(agentOpts, fAgent) },
    fInt !== 'all' && { key: 'integration' as const, label: platName(fInt) },
    fChannel !== 'all' && { key: 'channel' as const, label: labelOf(channelOpts, fChannel) },
    fTrigger !== 'all' && { key: 'trigger' as const, label: labelOf(triggerFlat, fTrigger) }
  ].filter((c): c is { key: FilterKey; label: string } => Boolean(c))

  // ── Mobile filter ─────────────────────────────────────────────────────────
  // Mobile matches the design's own filter: a bottom SHEET with pill chips per
  // section (Agent / Integration / Channel / Trigger) + a "Show N sessions" button
  // — NOT the desktop dropdown bar. The app-bar filter button (Shell) opens it; we
  // register the toggle + active flag into its slot while this view is mounted.
  const { register } = useMobileFilterSlot()
  const [sheetOpen, setSheetOpen] = useState(false)
  const openSheet = useCallback(() => setSheetOpen(true), [])
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  useEffect(() => {
    register({ active: filtActive, open: openSheet })
    return () => register(null)
  }, [register, filtActive, openSheet])
  // Close the sheet on Escape (parity with the desktop dropdowns).
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheetOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  // A scheduled fire is `triggeredBy: cron:<id>`. Show the schedule's name and
  // deep-link it. The row is itself a <Link> to the session, so this nested
  // clickable swallows the click (a real <a> here would be anchor-in-anchor).
  const renderTrigger = (s: Session) => {
    const cronId = s.triggeredBy?.startsWith('cron:') ? s.triggeredBy.slice(5) : null
    if (!cronId) return <>{triggerLabel(s)}</>
    const openCron = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault()
      e.stopPropagation()
      router.push(orgPath(`/crons/${cronId}`))
    }
    return (
      <span
        role="link"
        tabIndex={0}
        title="Open schedule"
        onClick={openCron}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openCron(e)
        }}
        className="cursor-pointer text-(--brand)"
      >
        {cronById.get(cronId)?.name?.trim() || 'Schedule'}
      </span>
    )
  }

  // Empty-state badge, shared by the two CSS-gated empty cards below.
  const emptyIcon = (
    <span className="flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
      <Icon name="funnel-x" size={21} color="var(--text-tertiary)" />
    </span>
  )

  // One responsive tree. ≥769px: the classic filter bar + 6-column table.
  // ≤768px: Shell owns the app bar (logo · "Sessions" · filter · search) and bottom
  // nav; only the scroll body renders — an optional active-filter chip row, then a
  // "Today · N" grouped rounded card of stacked 2-line rows. The filter itself is a
  // bottom sheet rendered at the end of the tree.
  return (
    <div className="wrap max-desktop:pb-24">
      {/* No description row (design v2): the filter bar states what this page is
          better than a sentence does, and the list starts at the top of the page. */}
      {/* Desktop filter bar — four custom dropdowns, each showing the selected face. */}
      <div className="mb-4 hidden flex-wrap items-center gap-[10px] desktop:flex">
        <span className="eyebrow mr-[2px]">Filter</span>
        <FilterSelect value={fAgent} onChange={(v) => setFilter('agent', v)} options={agentOpts} noun="agents" />
        <FilterSelect
          value={fInt}
          onChange={(v) => setFilter('integration', v)}
          options={integrationOpts}
          noun="integrations"
        />
        <FilterSelect
          value={fChannel}
          onChange={(v) => setFilter('channel', v)}
          options={channelOpts}
          mono
          noun="channels"
        />
        <FilterSelect
          value={fTrigger}
          onChange={(v) => setFilter('trigger', v)}
          options={[triggerAll]}
          groups={triggerGroups}
          noun="triggers"
        />
        <span className="mono ml-auto text-[12px] text-(--text-tertiary)">{countLabel}</span>
        {filtActive && (
          <button className="lnk text-(--text-tertiary)" onClick={() => router.replace(orgPath('/sessions'))}>
            <Icon name="x" size={13} />
            Clear
          </button>
        )}
      </div>
      {/* Mobile active-filter chips (only when a filter is set) — tap × to drop one. */}
      {filtActive && (
        <div className="-mt-2 mb-2 flex items-center gap-2 overflow-x-auto border-b border-(--border-subtle) bg-(--surface-app) px-4 py-[10px] max-desktop:mx-0 desktop:hidden [scrollbar-width:none]">
          {activeChips.map((c) => (
            <span
              key={c.key}
              className="inline-flex h-8 flex-none items-center gap-1 whitespace-nowrap rounded-full border border-(--border-default) bg-(--surface-active) pl-[11px] pr-[5px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)"
            >
              {c.label}
              <span
                role="button"
                tabIndex={0}
                aria-label={`Clear ${c.key} filter`}
                onClick={() => setFilter(c.key, 'all')}
                className="inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center text-(--text-tertiary)"
              >
                <Icon name="x" size={11} />
              </span>
            </span>
          ))}
          <span className="min-w-[8px] flex-1" />
          <span className="flex-none whitespace-nowrap font-mono text-[12px] leading-normal text-(--text-tertiary)">
            {countLabel}
          </span>
        </div>
      )}
      {initialLoading && (
        <div className="desktop:hidden">
          <LoadingState fill />
        </div>
      )}
      {filtered.length > 0 && (
        <div className="px-4 pt-4 pb-1 font-mono text-[11px] font-semibold uppercase leading-normal tracking-[.08em] text-(--text-tertiary) desktop:hidden">
          Today · {totalCount}
        </div>
      )}
      {/* The list card: desktop `.card` chrome; on mobile the same card gains the
          design's edge insets + 12px radius, and disappears entirely when there are
          no rows (the mobile empty/loading states render bare, outside any card). */}
      <div
        className={`card max-desktop:mx-4 max-desktop:mt-2 max-desktop:overflow-hidden max-desktop:rounded-lg ${
          filtered.length === 0 ? 'max-desktop:hidden' : ''
        }`}
      >
        <div className={`row h ${cols} hidden desktop:grid`}>
          <span>Session</span>
          <span>Agent</span>
          <span>Integration</span>
          <span>Status</span>
          <span className="text-right">Tokens</span>
          <span />
        </div>
        {initialLoading && (
          <div className="hidden desktop:block">
            <LoadingState />
          </div>
        )}
        {filtered.map((s, i) => {
          const ss = status(s.status)
          const ch = sessionChannelDisplay(s, (id) => cronById.get(id)?.name)
          return (
            <Link
              key={s.id}
              href={sessionHref(s)}
              className={`row click ${cols} items-center text-left no-underline max-desktop:grid max-desktop:min-h-18 max-desktop:w-full max-desktop:grid-cols-[minmax(0,1fr)_auto] max-desktop:gap-x-3 max-desktop:gap-y-[5px] max-desktop:border-b-0 max-desktop:bg-(--surface-card) ${
                i > 0 ? 'max-desktop:border-t max-desktop:border-(--border-subtle)' : ''
              }`}
            >
              {/* ── mobile arrangement (≤768px) ─────────────────────────────────
                  Title + status and time form the first row; agent + channel share
                  the full-width second row. The session title stays the visual lead. */}
              <span className="flex min-w-0 items-center gap-2 desktop:hidden">
                <span className="min-w-0 truncate font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                  {s.title}
                </span>
                <RestrictedLock show={s.visibility === 'private'} title="Private session — visible only to its owner" />
                <PurgedMark session={s} />
                {/* Status as a compact pill — the design's badge, driven by the real
                    status (soft bg + saturated text from STATUS_MAP). */}
                <span
                  className="inline-flex flex-none items-center whitespace-nowrap rounded-full px-2 py-[1px] font-sans text-[12px] font-semibold leading-normal"
                  style={{ background: ss.bg, color: ss.text }}
                >
                  {s.statusLabel || ss.label}
                </span>
              </span>
              <span className="justify-self-end whitespace-nowrap font-mono text-[12px] font-medium leading-normal text-(--text-tertiary) desktop:hidden">
                {s.time}
              </span>
              {/* Keep the variable-width channel off the title row. Both identities now
                  share the full second line, so long repository names no longer squeeze
                  the session title down to only a few characters. */}
              <span className="col-span-2 flex min-w-0 items-center gap-3 desktop:hidden">
                <span className="inline-flex min-w-0 max-w-[45%] items-center gap-[6px]">
                  {agentCell(
                    s,
                    'h-4 w-4 rounded-xs',
                    16,
                    'font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)'
                  )}
                </span>
                <span className="ml-auto inline-flex min-w-0 flex-1 items-center justify-end gap-[5px]">
                  <span className="inline-flex h-[14px] w-[14px] flex-none items-center justify-center">
                    <PlatformMark platform={ch.platform} fillPct={100} />
                  </span>
                  <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    {ch.label}
                  </span>
                </span>
              </span>
              {/* ── desktop arrangement (≥769px): the 6 grid cells ────────────── */}
              <div className="hidden min-w-0 desktop:block">
                <div className="flex min-w-0 items-center gap-[6px]">
                  <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                    {s.title}
                  </span>
                  <RestrictedLock
                    show={s.visibility === 'private'}
                    title="Private session — visible only to its owner"
                  />
                  <PurgedMark session={s} />
                </div>
                <div className="mono text-[11px] text-(--text-tertiary)">
                  {s.time} · {renderTrigger(s)}
                </div>
              </div>
              <div className="hidden min-w-0 items-center gap-2 desktop:flex">
                {agentCell(s, 'h-6 w-6 rounded-sm', 24, 'mono text-[12px] text-(--text-secondary)')}
              </div>
              <div className="hidden min-w-0 items-center gap-2 desktop:flex">
                <span className="imark h-5 w-5 rounded-[5px]">
                  <PlatformMark platform={ch.platform} />
                </span>
                <span className="mono truncate text-[12px] text-(--text-secondary)">{ch.label}</span>
              </div>
              <div className="hidden items-center gap-[7px] desktop:flex">
                <span className="dot" style={{ background: ss.dot }} />
                <span className="font-sans text-[12px] font-medium leading-normal" style={{ color: ss.text }}>
                  {s.statusLabel || ss.label}
                </span>
              </div>
              <span className="mono hidden text-right text-[12.5px] text-(--text-primary) desktop:block">
                {s.tokens}
              </span>
              <Icon
                name="chevron-right"
                size={16}
                color="var(--text-tertiary)"
                className="hidden justify-self-end desktop:block"
              />
            </Link>
          )
        })}
        {showEmpty && (
          <div className="hidden flex-col items-center gap-[6px] px-6 py-[44px] text-center desktop:flex">
            {emptyIcon}
            <div className="mt-[6px] font-sans text-[14px] font-semibold leading-normal">No sessions match</div>
            <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              Try clearing a filter to see more runs.
            </div>
          </div>
        )}
      </div>
      {sessionList.nextCursor && !initialLoading && (
        <div className="mt-3 flex justify-center max-desktop:px-4">
          <button className="lnk text-[12px]" onClick={sessionList.loadMore} disabled={sessionList.loadingMore}>
            {sessionList.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
      {showEmpty && (
        <div className="mx-6 my-[44px] flex flex-col items-center gap-[6px] text-center desktop:hidden">
          {emptyIcon}
          <div className="mt-[6px] font-sans text-[14px] font-semibold leading-normal">
            {filtActive ? 'No sessions match' : 'No sessions yet'}
          </div>
          <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {filtActive ? 'Try loosening the filters.' : 'Runs will appear here as your agents work.'}
          </div>
        </div>
      )}
      {/* ── Mobile filter sheet ──────────────────────────────────────────────── */}
      {sheetOpen && (
        <div className="msheet-scrim desktop:hidden" onClick={closeSheet}>
          <div
            className="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-(--surface-card) px-4 pt-2 pb-3 shadow-(--shadow-xl)"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="msheet-handle" />
            <div className="flex items-center px-0 pb-1 pt-[2px]">
              <span className="flex-1 font-sans text-[15px] font-semibold leading-normal">Filter sessions</span>
              {filtActive && (
                <button
                  className="h-8 border-0 bg-transparent px-[10px] font-sans text-[13px] font-semibold leading-normal text-(--brand)"
                  onClick={() => router.replace(orgPath('/sessions'))}
                >
                  Clear all
                </button>
              )}
            </div>
            <PillSection first label="Agent" options={agentOpts} value={fAgent} onPick={(v) => setFilter('agent', v)} />
            <PillSection
              label="Integration"
              options={integrationOpts}
              value={fInt}
              onPick={(v) => setFilter('integration', v)}
            />
            <PillSection
              label="Channel"
              options={channelOpts}
              value={fChannel}
              onPick={(v) => setFilter('channel', v)}
              mono
            />
            <PillSection
              label="Trigger"
              options={triggerFlat}
              value={fTrigger}
              onPick={(v) => setFilter('trigger', v)}
            />
            <button
              className="mt-[18px] flex h-[46px] w-full items-center justify-center rounded-[10px] border-0 bg-(--brand) font-sans text-[14px] font-semibold leading-normal text-white"
              onClick={closeSheet}
            >
              Show {countLabel}
            </button>
            <div className="msheet-home">
              <span className="home-pill dark" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type FilterOption = {
  v: string
  label: string
  face?: ReactNode
  // Optional trailing mark, right-aligned before the check — used to show a
  // channel/person's source platform (Slack/Discord/Telegram) while the leading
  // `face` carries the category glyph (# / avatar).
  rightFace?: ReactNode
  // Leading mark for the mobile filter pill, which shows a single mark (no split
  // left/right). Defaults to `face`; channels override it to the platform mark
  // (their desktop `face` is the `#` glyph, but the pill wants the platform).
  pillFace?: ReactNode
  /** The trigger category this option came from — one vocabulary with `sessionTriggerKind`. */
  kind?: SessionTriggerKind
}
type FilterGroup = { label: string; options: FilterOption[] }

// One option row in the custom filter menu — leading face, label, then an optional
// right-aligned platform mark, and a check on the selected one.
function FilterOpt({
  option,
  selected,
  mono,
  onPick
}: {
  option: FilterOption
  selected: boolean
  mono?: boolean
  onPick: () => void
}) {
  return (
    <button type="button" role="option" aria-selected={selected} className="fopt" onClick={onPick}>
      <span className="flex h-5 w-5 flex-none items-center justify-center">{option.face}</span>
      <span className={`min-w-0 flex-1 truncate ${mono ? 'font-mono' : ''}`}>{option.label}</span>
      {option.rightFace && (
        <span className="flex h-4 w-4 flex-none items-center justify-center opacity-85">{option.rightFace}</span>
      )}
      {selected && <Icon name="check" size={14} color="var(--brand)" className="flex-none" />}
    </button>
  )
}

// Desktop filter control — a custom button + floating menu (replaces the old native
// <select> overlay). The button shows the current selection's face + label, sized to
// its own label so the bar doesn't reflow as async options load in; the menu lists
// the options with a check on the active one, plus optional grouped sections (the
// Triggered-by control splits its senders by actor/source kind.
function FilterSelect({
  value,
  onChange,
  options,
  groups,
  mono,
  noun
}: {
  value: string
  onChange: (v: string) => void
  options: FilterOption[]
  groups?: FilterGroup[]
  mono?: boolean
  // Plural category name for the search placeholder — "Filter {noun}…".
  noun: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const all = groups ? [...options, ...groups.flatMap((g) => g.options)] : options
  const selected = all.find((o) => o.v === value) ?? all[0]
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }
  // Type-to-filter over option labels (case-insensitive substring), applied to the
  // flat options and each group; a group with no matches drops its header too.
  const q = query.trim().toLowerCase()
  const matches = (o: FilterOption) => o.label.toLowerCase().includes(q)
  const shownOptions = options.filter(matches)
  const shownGroups = (groups ?? [])
    .map((g) => ({ label: g.label, options: g.options.filter(matches) }))
    .filter((g) => g.options.length > 0)
  const noHit = shownOptions.length === 0 && shownGroups.length === 0
  // Close on Escape (outside clicks are caught by the .fscrim below).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  // Reset the query whenever the menu closes so it reopens fresh.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  return (
    <div className="relative">
      <button type="button" className={open ? 'selbtn on' : 'selbtn'} onClick={() => setOpen((v) => !v)}>
        <span className="flex h-[18px] w-[18px] flex-none items-center justify-center">{selected?.face}</span>
        <span className={`lbl ${mono ? 'font-mono' : ''}`}>{selected?.label}</span>
      </button>
      {open && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          <div className="fmenu" role="listbox">
            <input
              className="fsearch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${noun}…`}
              autoFocus
              aria-label={`Filter ${noun}`}
            />
            {shownOptions.map((o) => (
              <FilterOpt key={o.v} option={o} selected={o.v === value} mono={mono} onPick={() => pick(o.v)} />
            ))}
            {shownGroups.map((g) => (
              <div key={g.label}>
                <div className="fhdr">{g.label}</div>
                {g.options.map((o) => (
                  <FilterOpt key={o.v} option={o} selected={o.v === value} mono={mono} onPick={() => pick(o.v)} />
                ))}
              </div>
            ))}
            {noHit && <div className="fnohit">No matches</div>}
          </div>
        </>
      )}
    </div>
  )
}

// One section of the mobile filter sheet — an uppercase label over a horizontally
// scrollable row of pill chips (selected = brand fill). Every non-"All" pill leads
// with its mark: agent mark, platform mark (integration/channel), a round initials
// avatar (person), or a timer glyph (schedule). Channel pills are mono.
function PillSection({
  label,
  options,
  value,
  onPick,
  mono,
  first
}: {
  label: string
  options: FilterOption[]
  value: string
  onPick: (v: string) => void
  mono?: boolean
  first?: boolean
}) {
  return (
    <>
      <div
        className={`${first ? 'mt-3' : 'mt-4'} mb-[7px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[.08em] text-(--text-tertiary)`}
      >
        {label}
      </div>
      <div className="-mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4 pb-[2px] [scrollbar-width:none]">
        {options.map((o) => {
          const on = o.v === value
          const mark = o.v !== 'all' ? (o.pillFace ?? o.face) : null
          // The round person avatar sits tighter to the pill's leading edge.
          const tightLeft = o.kind === 'person'
          return (
            <button
              key={o.v}
              type="button"
              onClick={() => onPick(o.v)}
              className={`inline-flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-full border text-[13px] leading-none ${
                tightLeft ? 'pl-[5px] pr-[14px]' : 'px-[14px]'
              } ${mono ? 'font-mono' : 'font-sans'} ${
                on
                  ? 'border-(--brand) bg-(--brand) font-semibold text-white'
                  : 'border-(--border-default) bg-(--surface-card) font-medium text-(--text-secondary)'
              }`}
            >
              {mark && <span className="flex h-5 w-5 flex-none items-center justify-center">{mark}</span>}
              {o.v === 'all' ? 'All' : o.label}
            </button>
          )
        })}
      </div>
    </>
  )
}
