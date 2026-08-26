'use client'

// The blocks an infra detail page is built from. Four screens read a set of daemons — the
// managed AgentConnect Cloud, a self-hoster's own cluster (both `ClusterDetailView`), one of
// the org's own groups (`GroupDetailView`) and a single machine (`DaemonDetailView`) — and
// they answer the same two questions: what can it run, and what runs on it.
//
// So the answers live here once, as one three-up tile grid each. Every aggregate is over the
// SERVING members — one that stopped answering can no longer offer a runtime — but whether it
// UNIONS or INTERSECTS them depends on the set: a pool rolls identical Pods, so the two agree
// and the union is cheaper, while a group is machines an operator enrolled by hand and only
// what they ALL offer is something the group can promise. Hence a pair of each.

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import {
  agentLabel,
  agentModelDisplay,
  effectiveAgentStatus,
  runtimeLabel,
  status,
  type Agent,
  type DaemonRow
} from '@/lib/data'
import { AgentIconView, AgentMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { fetchUsage, fmtCost, type UsageRange } from '@/lib/api'
import { amountToNumber } from '@/lib/amount'
import { consoleKeys } from '@/lib/swr-keys'
import { SEG_FILL, bucketLabel, tickInterval } from '@/lib/spend-chart'
import { useOrgs } from '@/lib/org-context'

/** Bar colour tracks the reading — one scale across Infra, cluster, group and daemon detail. */
export function barColor(pct: number): string {
  return pct >= 80 ? 'var(--status-paused)' : pct >= 60 ? 'var(--amber-500)' : 'var(--brand)'
}

/** A runtime as a whole SET offers it, aggregated over its serving members. */
export interface FleetRuntime {
  runtime: string
  version: string
  /** Members disagree on the version, so there is no single one to quote. */
  versionsDiffer?: boolean
  models: string[]
  authRequired: boolean
}

// The runtimes a set offers, unioned over the members given (pass the serving ones). Version is
// the first non-empty one seen — a set's members roll together, so they agree — and `authRequired`
// is sticky, because one member whose probe was rejected is a real problem on that member.
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

/**
 * The runtimes every member offers — the INTERSECTION, for a set whose members are not replicas.
 *
 * A pool rolls identical Pods, so union and intersection agree there and `unionRuntimes` is the
 * cheaper read. A GROUP is machines an operator enrolled by hand, and they routinely differ: an
 * agent placed on the group lands on whichever member is serving, so a runtime one member lacks
 * is not something the group can run — advertising it promises a placement that fails on the runs
 * that land elsewhere. Models intersect for exactly the same reason.
 *
 * Empty in, empty out: nothing serving offers nothing, rather than the vacuous "everything".
 */
export function intersectRuntimes(members: readonly DaemonRow[]): FleetRuntime[] {
  const [first, ...rest] = members
  if (!first) return []
  const out: FleetRuntime[] = []
  for (const rt of first.runtimeModels) {
    const peers = rest.map((m) => m.runtimeModels.find((other) => other.runtime === rt.runtime))
    // One member without it is enough to make it unavailable to the group.
    if (peers.some((peer) => peer === undefined)) continue
    const all = [rt, ...peers.filter((peer) => peer !== undefined)]
    const versions = new Set(all.map((peer) => peer.version).filter(Boolean))
    out.push({
      runtime: rt.runtime,
      version: versions.size === 1 ? [...versions][0]! : '',
      versionsDiffer: versions.size > 1,
      models: rt.models.filter((model) => all.every((peer) => peer.models.includes(model))),
      // Sticky, as in the union: one member needing a login qualifies the set's promise, so the
      // row is MARKED. Not withdrawn — placement is deliberately independent of login readiness
      // (preset-agents.md §3.2), which is why this does not exclude the runtime.
      authRequired: all.some((peer) => peer.authRequired === true)
    })
  }
  return out
}

/** One cell of a detail page's metric column. */
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

/** Band one's metric column — two-up on mobile, one stacked column beside a card on desktop. */
// Stacked, its tiles grow and centre their content: the column is as tall as the card beside it, and tiles at
// their natural height leave that card's last stretch facing whitespace, which is the misalignment.
export function FleetStatColumn({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-[14px] desktop:flex desktop:flex-col desktop:[&>.stat]:flex desktop:[&>.stat]:flex-1 desktop:[&>.stat]:flex-col desktop:[&>.stat]:justify-center">
      {children}
    </div>
  )
}

// One utilization reading as a dial: the label above, the ring under it carrying its own figure.
// A ring rather than a bar because Resources is the NARROW column in band one — a bar there is a
// short track with its label crushed beside it — and the label sits on TOP rather than alongside
// so the ring owns the column's width instead of hugging its left edge.
const DIAL_R = 15.5
const DIAL_C = 2 * Math.PI * DIAL_R

export function ResourceDial({
  label,
  pct,
  muted = false
}: {
  label: string
  pct: number
  /** Nothing to measure (an idle fleet): the track stays empty and the figure reads '—' rather
   *  than filling to 0%, which would be a measurement. */
  muted?: boolean
}) {
  // Clamped — a daemon predating cpu-normalization reports a raw load average.
  const shown = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-[9px]">
      <span className="w-full truncate text-center font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
        {label}
      </span>
      <span className="relative flex h-20 w-20 flex-none items-center justify-center">
        <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r={DIAL_R} fill="none" stroke="var(--surface-active)" strokeWidth="3.5" />
          {!muted && (
            <circle
              cx="18"
              cy="18"
              r={DIAL_R}
              fill="none"
              stroke={barColor(shown)}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={`${(shown / 100) * DIAL_C} ${DIAL_C}`}
            />
          )}
        </svg>
        <span className="mono absolute text-[14px] font-semibold tracking-[-.02em]">{muted ? '—' : `${shown}%`}</span>
      </span>
    </div>
  )
}

/** The dials of one Resources card, stacked — one reading per row, each filling the column. */
export function ResourceDials({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-[18px] px-4 py-[18px]">{children}</div>
}

/**
 * What running here has COST, over the same window and from the same aggregate the Analytics
 * page charts — `GET /usage`, which the console already reads. Nothing new is metered for it.
 *
 * The aggregate has no infrastructure dimension at all, so the only scope it can answer is the
 * spend of the AGENTS placed here. That is a current-state reading — an agent moved here brings
 * the 30 days it spent elsewhere along — so the header says "agents placed here" rather than
 * claiming the machine or the cluster spent it.
 *
 * Metering INGRESS is not a substitute, tempting as it looks: a daemon reports its own usage by
 * default (`usageReporting.enabled`), pool members included, and `gateway` is written only where
 * a deployment runs an upstream collector and turns that off. So `source=gateway` would read
 * empty on an ordinary self-hosted cluster, and `source=daemon` would sweep in every other
 * machine the org connected. Neither isolates a fleet; the agent split does.
 */
const USAGE_RANGE: UsageRange = 'd30'

export function FleetUsageCard({ agentIds, note }: { agentIds: readonly string[]; note: string }) {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id ?? null
  // The SAME key the Analytics page uses for this window, so the two reads share one entry
  // rather than fetching the org's aggregate twice.
  const usage = useSWR(consoleKeys.usage(orgId, USAGE_RANGE), () => fetchUsage(USAGE_RANGE, orgId!))

  const series = usage.data?.series
  const points = series?.points ?? []
  const bucket = series?.bucket ?? 'day'
  // The split is what makes the scope possible, and an older CP sends none — say so instead of
  // summing an absent breakdown to zero and drawing "no usage".
  const hasSplit = points.some((p) => p.byAgent)
  const data = points.map((p) => ({
    label: bucketLabel(p.start, bucket),
    spend: agentIds.reduce((sum, id) => sum + amountToNumber(p.byAgent?.[id] ?? '0'), 0)
  }))
  const total = data.reduce((sum, d) => sum + d.spend, 0)
  const currency = usage.data?.totals.costCurrency ?? 'USD'

  type TipRow = { payload: (typeof data)[number] }
  const Tip = ({ active, payload }: { active?: boolean; payload?: TipRow[] }) => {
    const row = active ? payload?.[0]?.payload : undefined
    if (!row) return null
    return (
      <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) px-2.5 py-2 shadow-(--shadow-md)">
        <div className="mono text-[11px] font-semibold text-(--text-primary)">{row.label}</div>
        <div className="mono mt-1 text-[11px] leading-normal text-(--text-secondary)">
          {fmtCost(row.spend, currency)}
        </div>
      </div>
    )
  }

  const message =
    usage.error && !usage.data
      ? { icon: true, text: 'unavailable', title: (usage.error as Error).message }
      : points.length > 0 && !hasSplit
        ? { icon: true, text: 'This control plane reports no per-agent split.', title: undefined }
        : total === 0
          ? { icon: false, text: 'No usage in this window.', title: undefined }
          : null

  return (
    // `min-w-0`: recharts measures this box, and a grid item's auto min-width would otherwise
    // let the plot widen its own column.
    <div className="card flex min-w-0 flex-col">
      <div className="cardhead">
        <span className="cardtitle">Usage</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">{note}</span>
      </div>
      {usage.isLoading ? (
        <UsageSkeleton />
      ) : message ? (
        <div
          className="flex flex-1 items-center justify-center gap-[6px] px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
          title={message.title}
        >
          {message.icon && <Icon name="triangle-alert" size={14} color="var(--status-error)" className="flex-none" />}
          {message.text}
        </div>
      ) : (
        <div className={`min-h-[150px] flex-1 px-[6px] pb-[6px] text-(--text-tertiary) ${SEG_FILL}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 8 }} barCategoryGap="14%">
              <XAxis
                dataKey="label"
                interval={tickInterval(data.length)}
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                tick={{ fill: 'currentColor', fontSize: 10.5 }}
                className="mono"
              />
              <Tooltip content={<Tip />} cursor={{ fill: 'var(--surface-hover)' }} />
              {/* `seg-flat` is the shared brand hue; a day with nothing draws nothing. */}
              <Bar dataKey="spend" name="spend" className="seg-flat" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/** First-load stand-in, on the chart's own footprint so the series landing shifts nothing.
 *  Heights are a fixed pattern, never random — a random walk redraws on every render. */
function UsageSkeleton() {
  return (
    <div className="flex min-h-[150px] flex-1 animate-pulse items-end gap-[3px] px-[14px] pt-3 pb-[26px]">
      {Array.from({ length: 30 }, (_, i) => (
        <span
          key={i}
          className="min-w-0 max-w-[28px] flex-1 rounded-t-[3px] bg-(--surface-active)"
          style={{ height: `${24 + ((i * 23 + 13) % 60)}%` }}
        />
      ))}
    </div>
  )
}

/** The three-up tile grid both band-two cards lay their tiles out on. */
function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 items-start gap-3 px-4 py-[14px] desktop:grid-cols-3">{children}</div>
}

function EmptyTile({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-7 text-center">
      <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">{title}</div>
      {hint && (
        <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">{hint}</div>
      )}
    </div>
  )
}

// The runtimes a set offers, each disclosing its models. A real button, not the design's hover
// target: the model list is the only place a set's models are readable, and a pointer is not the
// only input.
export function FleetRuntimesCard({
  title,
  runtimes,
  agents,
  empty,
  note
}: {
  title: string
  runtimes: readonly FleetRuntime[]
  /** Agents placed on the set — a runtime's tile says how many of them use it. */
  agents: readonly Agent[]
  empty: string
  /** What the header says the list means — a group's is narrower than a pool's. */
  note?: string
}) {
  const acpRegistry = useAcpRegistry()
  // Independent disclosures — more than one runtime's models can be open at once.
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
        {note && (
          <span className="ml-auto font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {note}
          </span>
        )}
      </div>
      {runtimes.length > 0 ? (
        <TileGrid>
          {runtimes.map((rt) => {
            const meta = acpRuntime(acpRegistry, rt.runtime)
            const label = runtimeLabel(rt.runtime, meta?.name)
            // Id namespaces differ across daemon generations ('claude' vs 'claude-acp'),
            // so agents match on the display family rather than the raw id.
            const users = agents.filter((a) => a.runtime === rt.runtime || runtimeLabel(a.runtime) === label)
            const usage = users.length > 0 ? `${users.length} agent${users.length === 1 ? '' : 's'}` : 'no agents'
            const version = rt.versionsDiffer ? 'mixed' : rt.version ? `v${rt.version.replace(/^v/, '')}` : null
            const hasModels = rt.models.length > 0
            const shown = open.has(rt.runtime) && hasModels
            return (
              <div key={rt.runtime} className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
                <button
                  type="button"
                  aria-expanded={shown}
                  disabled={!hasModels}
                  onClick={() => toggle(rt.runtime)}
                  className="flex w-full items-center gap-[11px] border-0 bg-transparent px-[13px] py-3 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-(--surface-hover)"
                >
                  <span className="imark h-[30px] w-[30px]">
                    <AgentMark model={rt.runtime} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-[13px] font-semibold leading-normal">{label}</span>
                    <span className="mono block truncate text-[11px] text-(--text-tertiary)">
                      {version ? `${version} · ${usage}` : usage}
                    </span>
                  </span>
                  <span className="badge flex-none bg-(--surface-active) text-(--text-secondary)">
                    {rt.models.length} model{rt.models.length === 1 ? '' : 's'}
                  </span>
                  <Icon
                    name={shown ? 'chevron-up' : 'chevron-down'}
                    size={15}
                    color="var(--text-tertiary)"
                    className={hasModels ? 'flex-none' : 'invisible flex-none'}
                  />
                </button>
                {rt.authRequired && (
                  <div
                    title="The runtime rejected a probe with 'authentication required' — sign in to it on the daemon host. The warning clears on the next probe."
                    className="flex items-center gap-[6px] bg-(--status-paused-soft) px-[13px] py-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--amber-500)"
                  >
                    <Icon name="triangle-alert" size={12} className="flex-none" />
                    <span className="min-w-0 truncate">Login required — sign in on the daemon host</span>
                  </div>
                )}
                {shown && (
                  <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-[13px] py-[10px]">
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
          })}
        </TileGrid>
      ) : (
        <EmptyTile title={empty} />
      )}
    </div>
  )
}

/**
 * The agents placed on a set.
 *
 * No member stands in for one of them: whichever member holds a duty is interchangeable, so
 * status comes from the placement (`effectiveAgentStatus` reads the set branch first) and the
 * models a serving member reports name what the set can run. One MACHINE is the exception —
 * its own status gates its agents', so the daemon page passes itself as `statusHost`.
 */
export function FleetAgentsCard({
  title,
  agents,
  capabilitySource,
  statusHost,
  onOpen,
  emptyTitle,
  emptyHint
}: {
  title: string
  agents: readonly Agent[]
  /** One serving member, standing in for the set when reading what it can run. */
  capabilitySource: DaemonRow | undefined
  /** The machine whose status gates these agents' — set only where there IS one. */
  statusHost?: DaemonRow
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
        <TileGrid>
          {agents.map((a) => {
            const as = status(effectiveAgentStatus(a, statusHost))
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onOpen(a.id)}
                className="flex w-full cursor-pointer items-center gap-[11px] rounded-[9px] border border-(--border-subtle) bg-transparent px-[13px] py-3 text-left transition-colors hover:bg-(--surface-hover)"
              >
                <span className="av h-8 w-8 rounded-[7px]">
                  <AgentIconView icon={a.icon} runtime={a.runtime} size={32} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-[13px] font-semibold leading-normal">
                    {agentLabel(a)}
                  </span>
                  <span className="mono block truncate text-[11.5px] text-(--text-tertiary)">
                    {agentModelDisplay(capabilitySource, a.runtime, a.model)}
                  </span>
                </span>
                <span className="badge flex-none" style={{ background: as.bg, color: as.text }}>
                  <span className="dot h-[6px] w-[6px]" style={{ background: as.dot }} />
                  {as.label}
                </span>
              </button>
            )
          })}
        </TileGrid>
      ) : (
        <EmptyTile title={emptyTitle} hint={emptyHint} />
      )}
    </div>
  )
}
