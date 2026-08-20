'use client'

// The blocks a FLEET detail page is built from. Three screens in the console design read a
// set of interchangeable daemons as one thing — the managed AgentConnect Cloud, a
// self-hoster's own cluster (both `ClusterDetailView`) and one of the org's own groups
// (`GroupDetailView`) — and they answer the same four questions: what does the set offer,
// what runs on it, what does it hold, and what is true of it right now.
//
// So the answers live here once. A member of any of those sets is interchangeable by
// definition, which is why every aggregate below is a union over the SERVING members: a
// member that stopped answering can no longer offer a runtime or hold a connection.

import { useState } from 'react'
import {
  agentLabel,
  agentModelDisplay,
  effectiveAgentStatus,
  platName,
  runtimeLabel,
  status,
  type Agent,
  type DaemonRow,
  type IntegrationRow,
  type McpServerInfo
} from '@/lib/data'
import { AgentIconView, AgentMark, PlatformMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'

/** Bar colour tracks the reading — one scale across Infra, cluster, group and daemon detail. */
export function barColor(pct: number): string {
  return pct >= 80 ? 'var(--status-paused)' : pct >= 60 ? 'var(--amber-500)' : 'var(--brand)'
}

/** A runtime as a whole SET offers it — the union over its serving members. */
export interface FleetRuntime {
  runtime: string
  version: string
  models: string[]
  authRequired: boolean
}

/**
 * The runtimes a set offers, unioned over the members given (pass the serving ones).
 *
 * Version is the first non-empty one seen: the members of a set roll together, so they
 * agree, and quoting nothing is worse than quoting the release they share. `authRequired`
 * is sticky — one member whose probe was rejected is a real problem on that member.
 */
export function unionRuntimes(members: readonly DaemonRow[]): FleetRuntime[] {
  const byId = new Map<string, FleetRuntime>()
  for (const m of members) {
    for (const rt of m.runtimeModels) {
      const prev = byId.get(rt.runtime)
      if (!prev) {
        byId.set(rt.runtime, {
          runtime: rt.runtime,
          version: rt.version,
          models: [...rt.models],
          authRequired: rt.authRequired === true
        })
        continue
      }
      if (!prev.version) prev.version = rt.version
      for (const model of rt.models) if (!prev.models.includes(model)) prev.models.push(model)
      prev.authRequired ||= rt.authRequired === true
    }
  }
  return [...byId.values()]
}

/** The MCP servers a set offers, deduped by name over the members given. */
export function unionMcpServers(members: readonly DaemonRow[]): McpServerInfo[] {
  const byName = new Map<string, McpServerInfo>()
  for (const m of members) for (const s of m.mcpServers) if (!byName.has(s.name)) byName.set(s.name, s)
  return [...byName.values()]
}

/** One cell of a detail page's metric strip. */
export function FleetStat({ icon, label, value, note }: { icon: string; label: string; value: string; note?: string }) {
  return (
    <div className="card stat">
      <div className="statlbl">
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className="statval">{value}</div>
      {note && <div className="mono mt-[3px] text-[11px] text-(--text-tertiary)">{note}</div>}
    </div>
  )
}

/** One label/value row of a Details or Routing card. */
export function FleetFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="row grid-cols-[1fr_auto]">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span className="mono text-[12.5px]">{value}</span>
    </div>
  )
}

/** One labelled utilization bar (design: the fleet detail's `resources` rows). */
export function ResourceBar({
  label,
  detail,
  pct,
  muted = false
}: {
  label: string
  detail: string
  pct: number
  muted?: boolean
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-baseline gap-2">
        <span className="flex-1 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
          {label}
        </span>
        <span className="mono text-[12.5px]">{detail}</span>
      </div>
      <span className="block h-[6px] overflow-hidden rounded-[3px] bg-(--surface-active)">
        {!muted && <span className="block h-full" style={{ width: `${pct}%`, background: barColor(pct) }} />}
      </span>
    </div>
  )
}

/**
 * The runtimes a set offers, each disclosing its models.
 *
 * A real button, not the design's hover target: the model list is the only place a set's
 * models are readable, and a pointer is not the only input.
 */
export function FleetRuntimesCard({
  title,
  runtimes,
  agents,
  empty
}: {
  title: string
  runtimes: readonly FleetRuntime[]
  /** Agents placed on the set — a runtime's row says how many of them use it. */
  agents: readonly Agent[]
  empty: string
}) {
  const acpRegistry = useAcpRegistry()
  // Independent disclosures — more than one runtime's models can be open at once, matching
  // the daemon detail page's tap expansion.
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (rid: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(rid)) next.delete(rid)
      else next.add(rid)
      return next
    })

  return (
    <div className="card mb-[18px]">
      <div className="cardhead">
        <span className="cardtitle">{title}</span>
        <span className="ml-auto font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          Open a runtime for its models
        </span>
      </div>
      {runtimes.length > 0 ? (
        runtimes.map((rt) => {
          const meta = acpRuntime(acpRegistry, rt.runtime)
          const label = runtimeLabel(rt.runtime, meta?.name)
          // Id namespaces differ across daemon generations ('claude' vs 'claude-acp'),
          // so agents match on the display family rather than the raw id.
          const users = agents.filter((a) => a.runtime === rt.runtime || runtimeLabel(a.runtime) === label)
          const hasModels = rt.models.length > 0
          const shown = open.has(rt.runtime) && hasModels
          return (
            <div key={rt.runtime}>
              <button
                type="button"
                aria-expanded={shown}
                disabled={!hasModels}
                onClick={() => toggle(rt.runtime)}
                className="row grid w-full grid-cols-[1.4fr_.7fr_.9fr_.9fr_auto] gap-[14px] border-0 bg-transparent text-left enabled:cursor-pointer enabled:hover:bg-(--surface-hover)"
              >
                <span className="inline-flex min-w-0 items-center gap-[9px]">
                  <span className="imark h-[22px] w-[22px]">
                    <AgentMark model={rt.runtime} />
                  </span>
                  <span className="truncate font-sans text-[13px] font-semibold leading-normal">{label}</span>
                  {rt.authRequired && (
                    <span
                      className="flex flex-none"
                      title="A member's probe was rejected with 'authentication required' — sign in to the runtime on that machine."
                    >
                      <Icon name="triangle-alert" size={13} color="var(--amber-500)" />
                    </span>
                  )}
                </span>
                <span className="mono text-[12px] text-(--text-secondary)">
                  {rt.version ? `v${rt.version.replace(/^v/, '')}` : '—'}
                </span>
                <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                  {users.length > 0 ? `${users.length} agent${users.length === 1 ? '' : 's'}` : 'no agents'}
                </span>
                <span className="mono text-[12px] text-(--text-tertiary)">
                  {rt.models.length} model{rt.models.length === 1 ? '' : 's'}
                </span>
                <Icon
                  name={shown ? 'chevron-up' : 'chevron-down'}
                  size={15}
                  color="var(--text-tertiary)"
                  className={hasModels ? '' : 'invisible'}
                />
              </button>
              {shown && (
                <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-[10px]">
                  <div className="pb-1 font-sans text-[10px] font-semibold leading-normal tracking-[.05em] uppercase text-(--text-tertiary)">
                    Models
                  </div>
                  {rt.models.map((m) => (
                    <div key={m} className="mono truncate py-[3px] text-[11.5px]">
                      {m}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })
      ) : (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {empty}
        </div>
      )}
    </div>
  )
}

/**
 * The agents placed on a set.
 *
 * No member stands in for one of them: whichever member holds a duty is interchangeable, so
 * status comes from the placement (`effectiveAgentStatus` reads the set branch first) and the
 * models a serving member reports name what the set can run.
 */
export function FleetAgentsCard({
  title,
  agents,
  capabilitySource,
  onOpen,
  emptyTitle,
  emptyHint
}: {
  title: string
  agents: readonly Agent[]
  /** One serving member, standing in for the set when reading what it can run. */
  capabilitySource: DaemonRow | undefined
  onOpen: (agentId: string) => void
  emptyTitle: string
  emptyHint: string
}) {
  return (
    <div className="card">
      <div className="cardhead">
        <span className="cardtitle">{title}</span>
      </div>
      {agents.length > 0 ? (
        agents.map((a) => {
          const as = status(effectiveAgentStatus(a, undefined))
          return (
            <div key={a.id} className="row click grid-cols-[auto_1.6fr_1fr_auto] gap-3" onClick={() => onOpen(a.id)}>
              <span className="av h-7 w-7 rounded-[7px]">
                <AgentIconView icon={a.icon} runtime={a.runtime} size={28} />
              </span>
              <span className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal">
                {agentLabel(a)}
              </span>
              <span className="min-w-0 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                {agentModelDisplay(capabilitySource, a.runtime, a.model)}
              </span>
              <span className="badge" style={{ background: as.bg, color: as.text }}>
                <span className="dot h-[6px] w-[6px]" style={{ background: as.dot }} />
                {as.label}
              </span>
            </div>
          )
        })
      ) : (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">{emptyTitle}</div>
          <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {emptyHint}
          </div>
        </div>
      )}
    </div>
  )
}

/** The platform connections a set holds — an integration is held wherever its agent runs. */
export function FleetConnectionsCard({
  title,
  conns,
  empty
}: {
  title: string
  conns: readonly IntegrationRow[]
  empty: string
}) {
  return (
    <div className="card">
      <div className="cardhead">
        <span className="cardtitle">{title}</span>
      </div>
      {conns.length > 0 ? (
        conns.map((c) => {
          const cs = status(c.status)
          return (
            <div key={c.id ?? c.name} className="row grid-cols-[auto_1.6fr_1fr_auto] gap-3">
              <span className="imark h-6 w-6">
                <PlatformMark platform={c.platform} fillPct={100} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-sans text-[13px] font-semibold leading-normal">{c.name}</span>
                <span className="mono block truncate text-[11px] text-(--text-tertiary)">
                  {c.workspace || platName(c.platform)}
                </span>
              </span>
              <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">
                {c.channels.length} channel{c.channels.length === 1 ? '' : 's'}
              </span>
              <span className="badge" style={{ background: cs.bg, color: cs.text }}>
                <span className="dot h-[6px] w-[6px]" style={{ background: cs.dot }} />
                {cs.label}
              </span>
            </div>
          )
        })
      ) : (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {empty}
        </div>
      )}
    </div>
  )
}

/** The connections a set holds: an integration is held wherever its owning agent runs. */
export function connsHeldBy(agents: readonly Agent[], integrations: readonly IntegrationRow[]): IntegrationRow[] {
  const ids = new Set(agents.map((a) => a.id))
  return integrations.filter((i) => i.agentId !== undefined && ids.has(i.agentId))
}
