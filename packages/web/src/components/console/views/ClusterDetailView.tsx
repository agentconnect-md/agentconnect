'use client'

// Cluster detail — the self-hosted pool read as ONE thing (design: the Cloud/cluster
// detail screen, `cd.isCluster`). A pool member is a Pod: no member id survives a
// rollout, so opening the Infra card must not land on one machine's page and call it
// the cluster. Everything here aggregates the serving members.
//
// The design's mint/rotate-token action and its log tail are deliberately absent: the
// console mints no cluster credentials, and inventing a log stream would be
// indistinguishable from real telemetry (same call the daemon detail page made).

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  agentLabel,
  agentModelDisplay,
  effectiveAgentStatus,
  platName,
  poolFleetStatus,
  poolLabel,
  runtimeLabel,
  status,
  type DaemonRow,
  type McpServerInfo
} from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { NotFound } from '@/components/console/NotFound'
import { AgentIconView, AgentMark, LoadingState, PlatformMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'

// Bar colour tracks the reading, matching the Infra list and the daemon detail page.
function barColor(pct: number): string {
  return pct >= 80 ? 'var(--status-paused)' : pct >= 60 ? 'var(--amber-500)' : 'var(--brand)'
}

/** A runtime as the whole cluster offers it — the union over its serving members. */
interface ClusterRuntime {
  runtime: string
  version: string
  models: string[]
  authRequired: boolean
}

export default function ClusterDetailView() {
  const acpRegistry = useAcpRegistry()
  const { orgPath } = useOrgs()
  const router = useRouter()
  const { daemons, agents, integrations, daemonsLoading } = useConsoleData()
  const [openRuntime, setOpenRuntime] = useState<string | null>(null)

  const showPool = featureFlagEnabled('daemon-pool')
  const members = useMemo(() => (showPool ? daemons.filter((d) => d.pool) : []), [daemons, showPool])
  const serving = useMemo(() => members.filter((m) => m.status === 'online'), [members])
  const memberIds = useMemo(() => new Set(members.map((m) => m.daemonId)), [members])
  const hosted = useMemo(() => agents.filter((a) => memberIds.has(a.daemon)), [agents, memberIds])

  // The runtimes the cluster offers: a member that stopped answering can no longer serve
  // one, so the union is over the serving members only.
  const runtimes = useMemo<ClusterRuntime[]>(() => {
    const byId = new Map<string, ClusterRuntime>()
    for (const m of serving) {
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
  }, [serving])

  const mcpServers = useMemo<McpServerInfo[]>(() => {
    const byName = new Map<string, McpServerInfo>()
    for (const m of serving) for (const s of m.mcpServers) if (!byName.has(s.name)) byName.set(s.name, s)
    return [...byName.values()]
  }, [serving])

  // The connections the cluster holds: an integration is held wherever its agent runs.
  const conns = useMemo(() => {
    const hostedIds = new Set(hosted.map((a) => a.id))
    return integrations.filter((i) => i.agentId !== undefined && hostedIds.has(i.agentId))
  }, [hosted, integrations])

  if (members.length === 0) {
    if (daemonsLoading)
      return (
        <div className="wrap max-w-[1240px]">
          <LoadingState fill />
        </div>
      )
    return (
      <div className="wrap max-w-[1240px]">
        <NotFound
          icon="server-off"
          kind="CLUSTER"
          title="No cluster connected"
          pre="No pool member has registered with this control plane. Install the daemon runtime on a cluster and it appears here."
          actionLabel="Back to daemons"
          actionHref={orgPath('/daemons')}
          searchLabel="Search daemons"
        />
      </div>
    )
  }

  const s = status(poolFleetStatus(members))
  const online = serving.length > 0

  // `maxAgents <= 0` is the daemon's UNBOUNDED sentinel, not a ceiling of zero — a cluster
  // holding one has no finite budget, so it reads ∞ rather than a total that says "full".
  const caps = serving.map((m) => Number(m.conns))
  const unbounded = caps.some((c) => !Number.isFinite(c) || c <= 0)
  const capacity = unbounded ? 0 : caps.reduce((sum, c) => sum + c, 0)
  const used = serving.reduce((sum, m) => sum + m.loadAgents, 0)
  const capacityPct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
  const capacityLabel = `${used} / ${unbounded ? '∞' : capacity}`
  const avg = (pick: (m: DaemonRow) => number) =>
    serving.length > 0 ? Math.round(serving.reduce((sum, m) => sum + pick(m), 0) / serving.length) : 0
  const cpu = avg((m) => m.cpu)
  const mem = avg((m) => m.mem)
  const sessions = serving.reduce((sum, m) => sum + Number(m.activeSessions ?? 0), 0)
  // The serving members roll together, so they share a release; an idle cluster has no
  // version worth quoting rather than one belonging to a Pod that is gone.
  const version = online ? serving[0]!.version : '—'

  const labeled = (label: string, value: string) => (
    <div className="row grid-cols-[1fr_auto]">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span className="mono text-[12.5px]">{value}</span>
    </div>
  )

  const stat = (icon: string, label: string, value: string) => (
    <div className="card stat">
      <div className="statlbl">
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className="statval">{value}</div>
    </div>
  )

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-1 desktop:p-0">
      {/* header — no action button: a self-hoster's cluster credentials are minted on the
          cluster, never here, so there is nothing for this page to offer. */}
      <div className="mb-5 flex items-start gap-4">
        <span className="relative flex h-13 w-13 flex-none items-center justify-center rounded-lg border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="boxes" size={26} color={online ? 'var(--brand)' : 'var(--text-tertiary)'} />
          <span
            className="dot absolute -right-1 -bottom-1 h-[14px] w-[14px] border-[2.5px] border-(--surface-app)"
            style={{ background: s.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h1 className="ptitle">{poolLabel()}</h1>
            <span className="badge" style={{ background: s.bg, color: s.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: s.dot }} />
              {s.label}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="server" size={14} color="var(--text-tertiary)" />
              {online ? `${serving.length} node${serving.length === 1 ? '' : 's'} serving` : 'no nodes serving'}
            </span>
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="tag" size={14} color="var(--text-tertiary)" />
              <span className="mono text-[12px]">{version}</span>
            </span>
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="layers" size={14} color="var(--text-tertiary)" />
              Runs your agents on your own cluster
            </span>
          </div>
        </div>
      </div>

      {/* metric strip */}
      <div className="mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-4">
        {stat('bot', 'Agents on cluster', String(hosted.length))}
        {stat('server', 'Nodes serving', `${serving.length} / ${members.length}`)}
        {stat('layers', 'Sandbox capacity', capacityLabel)}
        {stat('activity', 'Active sessions', String(sessions))}
      </div>

      <div className="mb-[18px] grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-[1.15fr_1fr]">
        {/* capacity + utilization, the numbers the cluster's own members report */}
        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Capacity</span>
            <span className="mono ml-auto text-[11px] text-(--text-tertiary)">across serving nodes</span>
          </div>
          <div className="flex flex-col gap-[14px] px-4 py-[15px]">
            <ResourceBar
              label="Sandbox capacity in use"
              detail={capacityLabel}
              pct={capacityPct}
              // An unbounded cluster has no fraction to fill: the track stays empty rather
              // than drawing a 0% that reads as a measurement.
              muted={unbounded}
            />
            <ResourceBar label="CPU" detail={`${cpu}%`} pct={cpu} />
            <ResourceBar label="Memory" detail={`${mem}%`} pct={mem} />
          </div>
        </div>

        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Details</span>
          </div>
          <div className="py-[6px]">
            {labeled('Nodes', `${serving.length} serving of ${members.length}`)}
            {labeled('Status', s.label)}
            {labeled('Version', version)}
            {labeled('Agent ceiling', unbounded ? 'unbounded' : String(capacity))}
            {labeled('Placement', 'pool')}
            {labeled('MCP servers', String(mcpServers.length))}
          </div>
        </div>
      </div>

      {/* runtimes the cluster offers */}
      <div className="card mb-[18px]">
        <div className="cardhead">
          <span className="cardtitle">Runtimes</span>
          <span className="ml-auto font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            Hover a runtime for its models
          </span>
        </div>
        {runtimes.length > 0 ? (
          runtimes.map((rt) => {
            const meta = acpRuntime(acpRegistry, rt.runtime)
            const label = runtimeLabel(rt.runtime, meta?.name)
            // Id namespaces differ across daemon generations ('claude' vs 'claude-acp'),
            // so agents match on the display family rather than the raw id.
            const users = hosted.filter((a) => a.runtime === rt.runtime || runtimeLabel(a.runtime) === label)
            const open = openRuntime === rt.runtime && rt.models.length > 0
            return (
              <div
                key={rt.runtime}
                onMouseEnter={() => setOpenRuntime(rt.runtime)}
                onMouseLeave={() => setOpenRuntime(null)}
                className="row relative grid-cols-[1.4fr_.7fr_.9fr_.9fr] gap-[14px]"
              >
                <span className="inline-flex min-w-0 items-center gap-[9px]">
                  <span className="imark h-[22px] w-[22px]">
                    <AgentMark model={rt.runtime} />
                  </span>
                  <span className="truncate font-sans text-[13px] font-semibold leading-normal">{label}</span>
                  {rt.authRequired && (
                    <span
                      className="flex flex-none"
                      title="A node's probe was rejected with 'authentication required' — sign in to the runtime on that node."
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
                {open && (
                  <div className="absolute top-[calc(100%_-_4px)] left-4 z-40 w-[420px] max-w-[calc(100%_-_32px)] overflow-hidden rounded-[9px] border border-(--border-default) bg-(--surface-card) py-1 shadow-(--shadow-lg)">
                    <div className="px-[13px] pt-[7px] pb-1 font-sans text-[10px] font-semibold tracking-[.05em] uppercase leading-normal text-(--text-tertiary)">
                      Models
                    </div>
                    {rt.models.map((m) => (
                      <div key={m} className="mono truncate px-[13px] py-[5px] text-[11.5px]">
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
            No runtimes reported — no node has advertised its runtime profiles yet.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-2">
        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Agents on this cluster</span>
          </div>
          {hosted.length > 0 ? (
            hosted.map((a) => {
              // A pool agent runs on the member holding its duty; its status is that
              // member's, which is why the daemon row is looked up rather than assumed.
              const home = members.find((m) => m.daemonId === a.daemon)
              const as = status(effectiveAgentStatus(a, home))
              return (
                <div
                  key={a.id}
                  className="row click grid-cols-[auto_1.6fr_1fr_auto] gap-3"
                  onClick={() => router.push(orgPath(`/agents/${a.id}`))}
                >
                  <span className="av h-7 w-7 rounded-[7px]">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={28} />
                  </span>
                  <span className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal">
                    {agentLabel(a)}
                  </span>
                  <span className="min-w-0 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                    {agentModelDisplay(home, a.runtime, a.model)}
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
              <div className="font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
                No agents run here yet
              </div>
              <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                Place an agent on {poolLabel()} to start handling messages.
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Connections held here</span>
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
              No integration tokens are held on this cluster.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** One labelled utilization bar (design: the cluster detail's `cd.resources` rows). */
function ResourceBar({
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
