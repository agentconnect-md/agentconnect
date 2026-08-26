'use client'

import Link from 'next/link'
import { useMemo, useState, type ReactNode } from 'react'
import {
  agentDaemonLabel,
  agentLabel,
  agentModelDisplay,
  agentPlacementIcon,
  effectiveAgentStatus,
  isGitWorkspace,
  runtimeLabel,
  status,
  type Agent
} from '@/lib/data'
import { creatorLabel, fmtCost, fmtCountCompact, memberDisplayName, type HookKind } from '@/lib/api'
import { primaryHookKind } from '@/lib/session-trigger'
import { amountToNumber } from '@/lib/amount'
import { useConsoleData } from '@/lib/data-context'
import { IntegrationMarks } from '@/components/console/IntegrationMarks'
import { useModal } from '@/components/console/ModalProvider'
import { AgentIconView, GithubMark, GitlabMark, LoadingState, PlatformMark } from '@/components/marks'
import { BuiltinBadge } from '@/components/console/BuiltinBadge'
import { RestrictedLock } from '@/components/console/VisibilityField'
import { Avatar, Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { useIsMobile } from '@/lib/use-is-mobile'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { AgentReachabilityOverview } from '@/components/console/AgentReachabilityOverview'
import { useOnboardingRedirect } from '@/lib/use-onboarding-redirect'

// The single mark a compact agent row shows for its inbound triggers. Total over the
// hook-kind vocabulary, so a new code host is given a mark instead of falling through
// to the generic webhook glyph the way an unmapped kind used to.
const AGENT_HOOK_MARK: Record<HookKind, ReactNode> = {
  github: <GithubMark />,
  gitlab: <GitlabMark />,
  webhook: <Icon name="webhook" size={14} color="var(--text-secondary)" />
}

// Two-letter avatar initials for a creator name — first letters of the first two
// words, or the first two chars of a single token.
function initialsOf(label: string): string {
  const s = label.replace(/^@/, '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/).filter(Boolean)
  const chars = parts.length >= 2 ? parts[0]!.charAt(0) + parts[1]!.charAt(0) : s.slice(0, 2)
  return chars.toUpperCase()
}

// Sortable desktop columns (Integrations is intentionally excluded — an icon cluster
// with no natural order).
type SortKey = 'agent' | 'status' | 'daemon' | 'creator' | 'repo' | 'sessions' | 'tokens' | 'cost'
const NUMERIC_KEYS: SortKey[] = ['sessions', 'tokens', 'cost']
// Status column sort order: live agents first, planned transitions next, then
// deliberately paused agents and finally unexpected outages.
const STATUS_RANK: Record<string, number> = { online: 0, upgrading: 1, restarting: 1, paused: 2, offline: 3 }

// Parse a compact/formatted figure ("1.2M", "128K", "$3.40") back to a number so the
// Tokens/Cost columns can sort by the mock/demo strings when live usage is absent.
function parseCompact(s: string): number {
  const m = /(-?[\d.]+)\s*([kmb])?/i.exec(s.replace(/[$,\s]/g, ''))
  if (!m) return 0
  const n = parseFloat(m[1]!)
  if (!Number.isFinite(n)) return 0
  const suf = (m[2] ?? '').toLowerCase()
  return n * (suf === 'b' ? 1e9 : suf === 'm' ? 1e6 : suf === 'k' ? 1e3 : 1)
}

export default function AgentsView() {
  const acpRegistry = useAcpRegistry()
  const { orgPath } = useOrgs()
  const { agents, daemons, integrations, members, getSessions, usage24h, agentsLoading, daemonsLoading, memberSets } =
    useConsoleData()
  const { me } = useProfile()
  const { openModal } = useModal()
  // Agent/Daemon/Repo/Integrations are flex tracks that absorb spare width; Creator is
  // fixed for its avatar-only rows. minmax() floors stop the chips and headers from
  // squeezing on narrow windows, and status / the three usage columns / chevron are
  // fixed px so they never grow past their content. The usage columns are left-aligned
  // like the rest of the table, so they get just enough px to seat "Sessions 24h" + its
  // sort caret. (Daemon and Repo are separate columns so each aligns and ellipsizes on
  // its own — a combined "daemon · repo" cell truncated the repo whenever the daemon
  // name ran long.)
  const cols =
    'grid-cols-[minmax(148px,1.6fr)_92px_minmax(80px,.85fr)_72px_minmax(90px,1.2fr)_minmax(140px,.95fr)_108px_88px_80px_28px]'
  // Prefer the Agent projection because its daemon may be outside this viewer's fleet.
  const daemonName = (agent: Agent) => agentDaemonLabel(agent, daemons, memberSets)
  // Live 24h usage (GET /usage?range=d1) keyed by agent for the Tokens 24h column.
  const usageByAgent = new Map((usage24h?.agents ?? []).map((u) => [u.agentId, u]))
  // Per-agent "Sessions 24h": the live usage rollup when the CP reports one, else the
  // fanned-out `/sessions` list (demo rows / no usage yet). Shared by the mobile and
  // desktop rows so the same-labeled number never disagrees between form factors.
  const sessions24h = (agentId: string) => {
    const u = usageByAgent.get(agentId)
    return u ? u.sessions : getSessions(agentId).length
  }
  // Numeric 24h Tokens/Cost — live usage wins, else the agent's own (mock/demo) figure
  // parsed back to a number. Same source the cells render, so the columns sort by what
  // they show.
  const tokens24h = (a: Agent) => {
    const u = usageByAgent.get(a.id)
    return u ? u.totalTokens : parseCompact(a.tokens)
  }
  // The aggregate reports an exact decimal string; sorting and formatting are the
  // only things this view does with it, so it becomes a number right here.
  const cost24h = (a: Agent) => {
    const u = usageByAgent.get(a.id)
    return u ? amountToNumber(u.costAmount) : parseCompact(a.cost)
  }
  // Creator names remain available to sorting and assistive text; rows show only avatars.
  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members])
  const creatorText = (a: Agent) => creatorLabel(a.createdBy || null, me)
  const repoText = (a: Agent) => (isGitWorkspace(a.workspace) ? a.repo : 'scratch')
  const onlineCount = agents.filter(
    (a) =>
      effectiveAgentStatus(
        a,
        daemons.find((d) => d.daemonId === a.daemon)
      ) === 'online'
  ).length
  const currency = usage24h?.totals.costCurrency ?? undefined
  const isMobile = useIsMobile()
  const [view, setView] = useState<'list' | 'topology'>('list')
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  const [seg, setSeg] = useState<'all' | 'online' | 'offline' | 'paused'>('all')
  // Column sort (desktop table only). null = the list's natural order until a header is
  // clicked; clicking the active column flips direction. Text columns default ascending,
  // numeric columns descending (highest first is the useful default).
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null)
  // Fresh-workspace onboarding lives on its own /onboarding route (shared hook —
  // Home, the default landing, runs the same redirect).
  const holdForOnboarding = useOnboardingRedirect()
  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: NUMERIC_KEYS.includes(key) ? 'desc' : 'asc' }
    )

  // Status filter shared by both form factors (desktop pillbar + mobile segmented
  // control). Metrics stay global (computed from the FULL agent set); only the LIST
  // is filtered — same `seg` state, same `filtered` result on either layout.
  const segs: { key: typeof seg; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'online', label: 'Online' },
    { key: 'offline', label: 'Offline' },
    { key: 'paused', label: 'Paused' }
  ]
  const scopes: { key: typeof scope; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'mine', label: 'Mine' }
  ]
  const views: { key: typeof view; label: string }[] = [
    { key: 'list', label: 'List' },
    { key: 'topology', label: 'Topology' }
  ]
  const filtered = agents.filter((a) => {
    if (scope === 'mine' && (!me?.userId || a.createdBy !== me.userId)) return false
    if (seg === 'all') return true
    const eff = effectiveAgentStatus(
      a,
      daemons.find((d) => d.daemonId === a.daemon)
    )
    // A lifecycle transition is a temporary processing pause, not an outage.
    // Keep it discoverable under Paused while its row names the exact operation.
    return (eff === 'upgrading' || eff === 'restarting' ? 'paused' : eff) === seg
  })
  // Desktop sort applied on top of the scope/status filter. Mobile has no sort headers,
  // so it keeps `filtered` (natural order). A stable comparator on a copy — never mutate
  // the SWR-backed array.
  const statusRank = (a: Agent) =>
    STATUS_RANK[
      effectiveAgentStatus(
        a,
        daemons.find((d) => d.daemonId === a.daemon)
      )
    ] ?? 3
  const visible = (() => {
    if (!sort) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    const by: Record<SortKey, (x: Agent, y: Agent) => number> = {
      agent: (x, y) => agentLabel(x).localeCompare(agentLabel(y)),
      status: (x, y) => statusRank(x) - statusRank(y),
      daemon: (x, y) => daemonName(x).localeCompare(daemonName(y)),
      creator: (x, y) => creatorText(x).localeCompare(creatorText(y)),
      repo: (x, y) => repoText(x).localeCompare(repoText(y)),
      sessions: (x, y) => sessions24h(x.id) - sessions24h(y.id),
      tokens: (x, y) => tokens24h(x) - tokens24h(y),
      cost: (x, y) => cost24h(x) - cost24h(y)
    }
    const cmp = by[sort.key]
    return [...filtered].sort((x, y) => cmp(x, y) * dir || agentLabel(x).localeCompare(agentLabel(y)))
  })()
  const emptyMessage =
    scope === 'mine'
      ? seg === 'all'
        ? 'No agents created by you.'
        : 'No agents created by you in this state.'
      : 'No agents in this state.'

  // A sortable desktop column header: label + a sort caret. Inactive columns show a faint
  // chevrons-up-down on hover (the affordance); the active column shows an up/down caret in
  // brand. Every column left-aligns. A plain function (not a nested component) so it
  // re-reads `sort` each render without a remount.
  const th = (label: string, key: SortKey) => {
    const active = sort?.key === key
    return (
      <button
        type="button"
        onClick={() => onSort(key)}
        title={`Sort by ${label}`}
        className={`group flex cursor-pointer items-center gap-[3px] border-0 bg-transparent p-0 font-mono text-[11px] font-semibold uppercase leading-normal tracking-[.04em] ${
          active ? 'text-(--text-primary)' : 'text-(--text-tertiary) hover:text-(--text-secondary)'
        }`}
      >
        <span>{label}</span>
        <Icon
          name={active ? (sort!.dir === 'asc' ? 'chevron-up' : 'chevron-down') : 'chevrons-up-down'}
          size={12}
          className={`flex-none transition-opacity ${active ? 'text-(--brand)' : 'opacity-0 group-hover:opacity-50'}`}
        />
      </button>
    )
  }

  // While the redirect to /onboarding is in flight, hold a spinner so the empty
  // table/metrics never flash behind it.
  if (holdForOnboarding) return <LoadingState fill />

  if (view === 'topology') {
    if (isMobile) {
      return (
        <div className="pb-24">
          <div className="mx-4 my-3 grid h-10 grid-cols-2 gap-[3px] rounded-md border border-(--border-subtle) bg-(--gray-100) p-1">
            {views.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setView(option.key)}
                className={
                  option.key === view
                    ? 'cursor-pointer rounded-sm border-0 bg-(--surface-card) font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs)'
                    : 'cursor-pointer rounded-sm border-0 bg-transparent font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <AgentReachabilityOverview agents={agents} daemons={daemons} loading={agentsLoading} compact />
        </div>
      )
    }

    return (
      <div className="wrap">
        <div className="mb-4 flex min-h-[34px] items-center gap-4">
          <div className="flex-1">
            <p className="psub mt-0">
              Directed call topology from the configured outbound and inbound visibility policies.
            </p>
          </div>
          <div className="pillbar">
            {views.map((option) => (
              <button
                key={option.key}
                type="button"
                className={option.key === view ? 'pill on' : 'pill'}
                onClick={() => setView(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={() => openModal('agent')}>
            <Icon name="plus" size={15} />
            Add agent
          </Button>
        </div>
        <AgentReachabilityOverview agents={agents} daemons={daemons} loading={agentsLoading} />
      </div>
    )
  }

  if (isMobile) {
    const showLoading = agentsLoading && agents.length === 0
    return (
      <div className="pb-24">
        <div className="mx-4 mt-3 grid h-10 grid-cols-2 gap-[3px] rounded-md border border-(--border-subtle) bg-(--gray-100) p-1">
          {views.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setView(option.key)}
              className={
                option.key === view
                  ? 'cursor-pointer rounded-sm border-0 bg-(--surface-card) font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs)'
                  : 'cursor-pointer rounded-sm border-0 bg-transparent font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {/* Metric strip: one bordered 4-up grid card with inner right-dividers. */}
        <div className="mx-4 my-3 grid grid-cols-4 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          {[
            {
              label: 'Online',
              value: String(onlineCount),
              dim: ` / ${agents.length}`
            },
            {
              label: 'Sessions 24h',
              value: (usage24h?.totals.sessions ?? 0).toLocaleString('en-US'),
              dim: ''
            },
            {
              label: 'Tokens 24h',
              value: fmtCountCompact(usage24h?.totals.totalTokens ?? 0),
              dim: ''
            },
            {
              label: 'Spend 24h',
              value: fmtCost(amountToNumber(usage24h?.totals.costAmount ?? '0'), currency),
              dim: ''
            }
          ].map((m, i, arr) => (
            <div
              key={m.label}
              className={`flex min-h-13 flex-col justify-between px-[9px] py-[10px] ${
                i === arr.length - 1 ? '' : 'border-r border-(--border-subtle)'
              }`}
            >
              <div className="font-sans text-[10px] font-medium leading-[1.3] text-(--text-tertiary)">{m.label}</div>
              <div className="font-mono text-[16px] font-semibold leading-normal tracking-[-.02em] tabular-nums">
                {m.value}
                {m.dim ? <span className="text-(--text-tertiary)">{m.dim}</span> : null}
              </div>
            </div>
          ))}
        </div>

        {/* Scope + status filters (desktop uses pillbars). */}
        <div className="mx-4 grid h-11 grid-cols-[repeat(2,minmax(0,1fr))_1px_repeat(4,minmax(0,1fr))] gap-[3px] rounded-md border border-(--border-subtle) bg-(--gray-100) p-1">
          {scopes.map((sg) => {
            const on = sg.key === scope
            return (
              <button
                key={sg.key}
                type="button"
                onClick={() => setScope(sg.key)}
                className={`cursor-pointer whitespace-nowrap rounded-sm border-0 font-sans text-[12px] leading-normal ${
                  on
                    ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-(--shadow-xs)'
                    : 'bg-transparent font-medium text-(--text-secondary)'
                }`}
              >
                {sg.label}
              </button>
            )
          })}
          <span className="my-1 w-px bg-(--border-subtle)" />
          {segs.map((sg) => {
            const on = sg.key === seg
            return (
              <button
                key={sg.key}
                type="button"
                onClick={() => setSeg(sg.key)}
                className={`cursor-pointer whitespace-nowrap rounded-sm border-0 font-sans text-[12px] leading-normal ${
                  on
                    ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-(--shadow-xs)'
                    : 'bg-transparent font-medium text-(--text-secondary)'
                }`}
              >
                {sg.label}
              </button>
            )
          })}
        </div>

        {showLoading ? (
          <LoadingState fill />
        ) : filtered.length > 0 ? (
          <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
            {/* Column header. */}
            <div className="flex items-center justify-between border-b border-(--border-subtle) bg-(--surface-app) px-4 py-[10px]">
              {['Agent', 'Sessions 24h'].map((h) => (
                <span
                  key={h}
                  className="font-mono text-[11px] font-semibold uppercase leading-normal tracking-[.08em] text-(--text-tertiary)"
                >
                  {h}
                </span>
              ))}
            </div>
            {filtered.map((a, i) => {
              const owning = daemons.find((d) => d.daemonId === a.daemon)
              const runtimeMeta = acpRuntime(acpRegistry, a.runtime)
              const s = status(effectiveAgentStatus(a, owning))
              const agentInts = integrations.filter((int) => int.agentId === a.id)
              const first = agentInts[0]
              const primaryKind = primaryHookKind(a.hookKinds ?? [])
              const n24 = sessions24h(a.id)
              return (
                <Link
                  key={a.id}
                  href={orgPath(`/agents/${a.id}`)}
                  className={`flex min-h-18 w-full items-center gap-3 bg-(--surface-card) px-4 py-3 text-left no-underline ${
                    i === 0 ? '' : 'border-t border-(--border-subtle)'
                  }`}
                >
                  {/* Avatar tile with status dot. */}
                  <span className="av relative h-10 w-10 flex-none">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={40} />
                    <span
                      className="absolute -bottom-[3px] -right-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card)"
                      style={{ background: s.dot }}
                    />
                  </span>
                  {/* Name + meta column — carries the description, matching desktop. */}
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]" title={a.desc}>
                    <span className="flex min-w-0 items-center gap-[6px]">
                      <span className="truncate font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                        {agentLabel(a)}
                      </span>
                      <BuiltinBadge show={!!a.builtin} />
                      <RestrictedLock
                        show={a.visibility === 'restricted'}
                        title="Selected — only shared members can see this agent"
                      />
                    </span>
                    <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {runtimeLabel(a.runtime, runtimeMeta?.name)} · {agentModelDisplay(owning, a.runtime, a.model)}
                    </span>
                  </span>
                  {/* Trailing cluster. */}
                  {s.label === 'offline' ? (
                    <Icon name="triangle-alert" size={16} color="var(--amber-500)" className="flex-none" />
                  ) : null}
                  {first ? (
                    <span className="flex h-4 w-4 flex-none items-center justify-center">
                      <PlatformMark platform={first.platform} fillPct={100} />
                    </span>
                  ) : primaryKind ? (
                    <span className="flex h-4 w-4 flex-none items-center justify-center">
                      {AGENT_HOOK_MARK[primaryKind]}
                    </span>
                  ) : null}
                  <span className="flex-none font-mono text-[14px] font-medium leading-normal text-(--text-primary) tabular-nums">
                    {n24.toLocaleString('en-US')}
                  </span>
                  <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="flex-none" />
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="mx-4 mt-3 rounded-lg border border-(--border-subtle) bg-(--surface-card) px-4 py-7 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {emptyMessage}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <div className="flex-1">
          <p className="psub mt-0">AI agents running across your daemons. Click one to inspect its sessions.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="pillbar">
            {views.map((option) => (
              <button
                key={option.key}
                type="button"
                className={option.key === view ? 'pill on' : 'pill'}
                onClick={() => setView(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="pillbar">
            {scopes.map((sg) => (
              <button
                key={sg.key}
                type="button"
                className={sg.key === scope ? 'pill on' : 'pill'}
                onClick={() => setScope(sg.key)}
              >
                {sg.label}
              </button>
            ))}
          </div>
          <div className="pillbar">
            {segs.map((sg) => (
              <button
                key={sg.key}
                type="button"
                className={sg.key === seg ? 'pill on' : 'pill'}
                onClick={() => setSeg(sg.key)}
              >
                {sg.label}
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" onClick={() => openModal('agent')}>
          <Icon name="plus" size={15} />
          Add agent
        </Button>
      </div>
      <div className="mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-4">
        <div className="card stat">
          <div className="statlbl">Online agents</div>
          <div className="statval">
            {onlineCount} <span className="text-[14px] font-medium text-(--text-tertiary)">/ {agents.length}</span>
          </div>
        </div>
        <div className="card stat">
          <div className="statlbl">Sessions (24h)</div>
          <div className="statval">{(usage24h?.totals.sessions ?? 0).toLocaleString('en-US')}</div>
        </div>
        <div className="card stat">
          <div className="statlbl">Tokens (24h)</div>
          <div className="statval">{fmtCountCompact(usage24h?.totals.totalTokens ?? 0)}</div>
        </div>
        <div className="card stat">
          <div className="statlbl">Spend (24h)</div>
          <div className="statval">{fmtCost(amountToNumber(usage24h?.totals.costAmount ?? '0'), currency)}</div>
        </div>
      </div>
      <div className="card">
        <div className={`row h ${cols}`}>
          {th('Agent', 'agent')}
          {th('Status', 'status')}
          {th('Runs on', 'daemon')}
          {th('Creator', 'creator')}
          {th('Repo', 'repo')}
          <span>Integrations</span>
          {th('Sessions 24h', 'sessions')}
          {th('Tokens 24h', 'tokens')}
          {th('Cost 24h', 'cost')}
          <span />
        </div>
        {agentsLoading && agents.length === 0 ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <div className="px-4 py-7 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {emptyMessage}
          </div>
        ) : (
          visible.map((a) => {
            const owning = daemons.find((d) => d.daemonId === a.daemon)
            const runtimeMeta = acpRuntime(acpRegistry, a.runtime)
            const s = status(effectiveAgentStatus(a, owning))
            const sessionCount = sessions24h(a.id)
            // Keep the resolved name for sorting, assistive text, and the avatar's hint.
            const creatorName = creatorText(a)
            const creatorMember = a.createdBy ? memberById.get(a.createdBy) : undefined
            // Live integrations owned by this agent (demo rows carry no agentId),
            // plus inbound triggers (github repo subscriptions / webhooks) — the
            // cell shows a mark per source, not just bot integrations.
            const agentInts = integrations.filter((i) => i.agentId === a.id)
            const hookKinds = a.hookKinds ?? []
            const totalIntegrations = agentInts.length + hookKinds.length
            // Only a GitHub App checkout can promise privacy, so every other clone takes the neutral repo glyph.
            const repoIcon = !isGitWorkspace(a.workspace)
              ? 'folder'
              : a.workspace.mode === 'github' && a.workspace.installationId
                ? 'lock'
                : 'book-marked'
            const repoLabel = isGitWorkspace(a.workspace) ? a.repo : 'scratch'
            return (
              <Link
                key={a.id}
                href={orgPath(`/agents/${a.id}`)}
                aria-describedby={a.desc ? `agent-desc-${a.id}` : undefined}
                className={`row click ${cols}`}
              >
                {/* Static description for the focused row. `hidden` keeps it out of the
                  grid and out of the link's name-from-content, while `aria-describedby`
                  still resolves it — so this needs no runtime ARIA bookkeeping. */}
                {a.desc ? (
                  <span id={`agent-desc-${a.id}`} hidden>
                    {a.desc}
                  </span>
                ) : null}
                <div className="flex min-w-0 items-center gap-[11px]">
                  <span className="av h-[34px] w-[34px]">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={34} />
                    <span
                      className="dot absolute -bottom-[3px] -right-[3px] h-[11px] w-[11px] border-2 border-(--surface-card)"
                      style={{ background: s.dot }}
                    />
                  </span>
                  {/* The description hangs off the NAME, not the row: a tooltip centers on
                    its anchor, so on a full-width row it opened halfway across the table,
                    nowhere near the pointer — and it fired from every cell. The row keeps
                    its accessible description via the hidden node below, so moving the
                    hover anchor costs assistive tech nothing. */}
                  <div className="min-w-0" title={a.desc}>
                    <div className="flex min-w-0 items-center gap-[6px]">
                      <span className="truncate font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
                        {agentLabel(a)}
                      </span>
                      <BuiltinBadge show={!!a.builtin} />
                      <RestrictedLock
                        show={a.visibility === 'restricted'}
                        title="Selected — only shared members can see this agent"
                      />
                    </div>
                    <div className="flex min-w-0 items-center gap-[6px] text-[11px] text-(--text-tertiary)">
                      <span className="whitespace-nowrap font-sans text-[11px] font-medium leading-normal text-(--text-secondary)">
                        {runtimeLabel(a.runtime, runtimeMeta?.name)}
                      </span>
                      <span className="text-(--border-strong)">·</span>
                      <span className="mono truncate">{agentModelDisplay(owning, a.runtime, a.model)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-[7px] overflow-hidden">
                  <span className="dot" style={{ background: s.dot }} />
                  <span
                    className="truncate font-sans text-[12.5px] font-medium leading-normal"
                    style={{ color: s.text }}
                  >
                    {s.label}
                  </span>
                </div>
                {/* Daemon and repo are the two cells that routinely truncate, so they keep
                  a hint — it carries the full value, which the row does not show. An
                  UNPLACED agent (the preset before placement) gets an Add CTA instead of
                  the dash — same affordance as the Integrations cell (preset-agents.md
                  §3.4): with no daemon in the org yet it launches the join-command
                  dialog; otherwise the edit modal carries the daemon picker. */}
                {daemonName(a) === '—' ? (
                  <div className="min-w-0 pr-3">
                    <span
                      className="addchip"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (daemons.length === 0) openModal('daemon', a)
                        else openModal('editAgent', a)
                      }}
                    >
                      <Icon name="plus" size={13} />
                      Add
                    </span>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-[6px] pr-3" title={daemonName(a)}>
                    <Icon
                      name={agentPlacementIcon(a, memberSets)}
                      size={13}
                      color="var(--text-tertiary)"
                      className="flex-none"
                    />
                    <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)">{daemonName(a)}</span>
                  </div>
                )}
                {a.createdBy ? (
                  <div className="flex items-center pr-3" title={creatorName}>
                    <Avatar
                      src={creatorMember?.picture}
                      initials={initialsOf(creatorMember ? memberDisplayName(creatorMember) : creatorName)}
                      size={20}
                      fontSize={8.5}
                      bg="var(--surface-sunken)"
                      fg="var(--text-secondary)"
                      style={{ border: '1px solid var(--border-subtle)' }}
                    />
                    <span className="sr-only">Creator: {creatorName}</span>
                  </div>
                ) : (
                  <div className="mono min-w-0 truncate pr-3 text-[12px] text-(--text-tertiary)">—</div>
                )}
                <div className="flex min-w-0 items-center gap-[6px] pr-3" title={repoLabel}>
                  {repoIcon ? (
                    <Icon name={repoIcon} size={13} color="var(--text-tertiary)" className="flex-none" />
                  ) : null}
                  <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{repoLabel}</span>
                </div>
                <div className="min-w-0 pr-3">
                  {totalIntegrations > 0 ? (
                    <IntegrationMarks integrations={agentInts} hookKinds={hookKinds} />
                  ) : (
                    <span
                      className="addchip"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openModal('integration', a)
                      }}
                    >
                      <Icon name="plus" size={13} />
                      Add
                    </span>
                  )}
                </div>
                <span className="mono text-[13px] text-(--text-primary)">{sessionCount.toLocaleString('en-US')}</span>
                {/* Live 24h rollup when the CP has usage for this agent; else the
                  agent's own values (demo figures for mock rows, '—' for live ones). */}
                {(() => {
                  const u = usageByAgent.get(a.id)
                  const cell = 'text-[13px] text-(--text-primary)'
                  return (
                    <>
                      <span className={`mono ${cell}`}>{u ? fmtCountCompact(u.totalTokens) : a.tokens}</span>
                      <span className={`mono ${cell}`}>
                        {u ? fmtCost(amountToNumber(u.costAmount), currency) : a.cost}
                      </span>
                    </>
                  )
                })()}
                <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="justify-self-end" />
              </Link>
            )
          })
        )}
      </div>
    </div>
  )
}
