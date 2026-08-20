'use client'

// The pool's own detail page, in both of its readings (design: the Cloud / cluster detail
// screen, `cd.isCloud` and `cd.isCluster`).
//
// A pool member is a Pod: no member id survives a rollout, so opening the Infra entry must
// not land on one machine's page and call it the pool. Everything here aggregates the
// serving members.
//
// Which reading applies is not cosmetic — it is whose infrastructure this IS:
//
//   managed   → AgentConnect Cloud, a product the org buys. Node count, host names,
//               versions and CPU are the operator's business, not the reader's, so the page
//               shows what the org can act on: what runs there, what it can run, what it
//               holds, and what it costs.
//   self-host → the operator's OWN cluster. Now the topology IS theirs, so capacity and
//               utilization are the numbers worth quoting and nothing is billed here.
//
// The design's mint/rotate-token action and its log tail are deliberately absent in both:
// the console mints no pool credentials, and inventing a log stream would be
// indistinguishable from real telemetry (same call the daemon detail page made).

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { isPoolPlacementKind, poolFleetStatus, poolLabel, status, type DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchBillingAccount, fmtMicroUsd } from '@/lib/billing-api'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { NotFound } from '@/components/console/NotFound'
import {
  FleetAgentsCard,
  FleetConnectionsCard,
  FleetFact,
  FleetRuntimesCard,
  FleetStat,
  ResourceBar,
  connsHeldBy,
  unionMcpServers,
  unionRuntimes
} from '@/components/console/FleetDetail'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

export default function ClusterDetailView() {
  const { orgPath } = useOrgs()
  const router = useRouter()
  const { daemons, agents, integrations, orgSetIds, daemonsLoading } = useConsoleData()

  const showPool = featureFlagEnabled('daemon-pool')
  // Whose infrastructure the pool IS decides how the page reads — see the file header.
  const managed = featureFlagEnabled('managed')
  // Cloud's one honest action and its one honest figure both live on the Billing page, so
  // neither is offered where this deployment does not have one.
  const billingOffered = managed && featureFlagEnabled('billing')
  const members = useMemo(() => (showPool ? daemons.filter((d) => d.pool) : []), [daemons, showPool])
  const serving = useMemo(() => members.filter((m) => m.status === 'online'), [members])
  // Pool agents carry the POOL sentinel, never a member id: the Pod holding the duty is
  // ephemeral, so `agentFromDto` maps a set placement to `daemon: POOL_PLACEMENT`. Matching
  // member ids here would report an empty pool however many agents run on it.
  const hosted = useMemo(
    () => agents.filter((a) => isPoolPlacementKind(a.placementKind, a.setId, orgSetIds)),
    [agents, orgSetIds]
  )

  // A member that stopped answering can no longer serve a runtime or hold a connection, so
  // both unions are over the serving members only.
  const runtimes = useMemo(() => unionRuntimes(serving), [serving])
  const mcpServers = useMemo(() => unionMcpServers(serving), [serving])
  const conns = useMemo(() => connsHeldBy(hosted, integrations), [hosted, integrations])

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
          kind={managed ? 'CLOUD' : 'CLUSTER'}
          title={managed ? 'Cloud is not available here' : 'No cluster connected'}
          pre={
            managed
              ? 'No Cloud capacity has registered with this control plane yet. Place your agents on a daemon you connected in the meantime.'
              : 'No pool member has registered with this control plane. Install the daemon runtime on a cluster and it appears here.'
          }
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
  // The serving members roll together, so they share a release; an idle pool has no
  // version worth quoting rather than one belonging to a Pod that is gone.
  const version = online ? serving[0]!.version : '—'
  // One serving member stands in for the set when reading what it can run — the same
  // substitution Add-agent and Edit-agent make (edit-agent-daemon-choice.ts).
  const capabilitySource = serving[0]
  const models = runtimes.reduce((sum, rt) => sum + rt.models.length, 0)

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-1 desktop:p-0">
      {/* header — no credential action in either reading: pool credentials are minted where
          the pool runs, never here, so there is nothing for this page to offer. Cloud does
          get the one action it can honestly own, which is where its usage is paid for. */}
      <div className="mb-5 flex items-start gap-4">
        <span
          className={`relative flex h-13 w-13 flex-none items-center justify-center rounded-lg ${
            managed ? 'bg-(--brand-soft)' : 'border border-(--border-subtle) bg-(--surface-sunken)'
          }`}
        >
          <Icon name={managed ? 'cloud' : 'boxes'} size={26} color={online ? 'var(--brand)' : 'var(--text-tertiary)'} />
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
            {managed ? (
              <>
                <MetaItem icon="cloud" text="Managed by AgentConnect" />
                <MetaItem icon="layers" text="Runs your agents on AgentConnect's infrastructure" />
              </>
            ) : (
              <>
                <MetaItem
                  icon="server"
                  text={
                    online ? `${serving.length} node${serving.length === 1 ? '' : 's'} serving` : 'no nodes serving'
                  }
                />
                <MetaItem icon="tag" mono text={version} />
                <MetaItem icon="layers" text="Runs your agents on your own cluster" />
              </>
            )}
          </div>
        </div>
        {billingOffered && (
          <Button variant="secondary" size="sm" onClick={() => router.push(orgPath('/billing'))}>
            Manage billing
          </Button>
        )}
      </div>

      {/* metric strip */}
      <div className="mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-4">
        {managed ? (
          <>
            <FleetStat icon="bot" label="Agents on Cloud" value={String(hosted.length)} />
            <FleetStat icon="plug" label="Connections held" value={String(conns.length)} />
            <FleetStat icon="activity" label="Active sessions" value={String(sessions)} />
            <FleetStat
              icon="cpu"
              label="Runtimes available"
              value={String(runtimes.length)}
              note={`${models} model${models === 1 ? '' : 's'}`}
            />
          </>
        ) : (
          <>
            <FleetStat icon="bot" label="Agents on cluster" value={String(hosted.length)} />
            <FleetStat icon="server" label="Nodes serving" value={`${serving.length} / ${members.length}`} />
            <FleetStat icon="layers" label="Sandbox capacity" value={capacityLabel} />
            <FleetStat icon="activity" label="Active sessions" value={String(sessions)} />
          </>
        )}
      </div>

      <div
        className={`mb-[18px] grid grid-cols-1 items-start gap-[18px] ${
          managed && !billingOffered ? '' : 'desktop:grid-cols-[1.15fr_1fr]'
        }`}
      >
        {/* Cloud quotes what its usage costs; a cluster quotes the capacity its own members
            report. Neither borrows the other's figure — a plan's included usage cannot be
            derived from load telemetry, and a self-hoster is billed nothing here. */}
        {managed ? (
          billingOffered && <CloudBillingCard />
        ) : (
          <ClusterCapacityCard {...{ capacityLabel, capacityPct, unbounded, cpu, mem }} />
        )}

        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Details</span>
          </div>
          <div className="py-[6px]">
            {managed ? (
              <>
                <FleetFact label="Status" value={s.label} />
                <FleetFact label="Operated by" value="AgentConnect" />
                <FleetFact label="Placement" value="pool" />
                <FleetFact label="Runtimes" value={String(runtimes.length)} />
                <FleetFact label="MCP servers" value={String(mcpServers.length)} />
              </>
            ) : (
              <>
                <FleetFact label="Nodes" value={`${serving.length} serving of ${members.length}`} />
                <FleetFact label="Status" value={s.label} />
                <FleetFact label="Version" value={version} />
                <FleetFact label="Agent ceiling" value={unbounded ? 'unbounded' : String(capacity)} />
                <FleetFact label="Placement" value="pool" />
                <FleetFact label="MCP servers" value={String(mcpServers.length)} />
              </>
            )}
          </div>
        </div>
      </div>

      <FleetRuntimesCard
        title="Runtimes"
        runtimes={runtimes}
        agents={hosted}
        empty={
          managed
            ? 'No runtimes reported — Cloud has not advertised its runtime profiles yet.'
            : 'No runtimes reported — no node has advertised its runtime profiles yet.'
        }
      />

      <div className="grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-2">
        <FleetAgentsCard
          title={managed ? 'Agents on Cloud' : 'Agents on this cluster'}
          agents={hosted}
          capabilitySource={capabilitySource}
          onOpen={(id) => router.push(orgPath(`/agents/${id}`))}
          emptyTitle="No agents run here yet"
          emptyHint={`Place an agent on ${poolLabel()} to start handling messages.`}
        />
        <FleetConnectionsCard
          title="Connections held here"
          conns={conns}
          empty={
            managed ? 'No integration tokens are held on Cloud.' : 'No integration tokens are held on this cluster.'
          }
        />
      </div>

      {managed && (
        <p className="mt-[14px] max-w-[780px] font-sans text-[12px] font-normal leading-[1.6] text-(--text-tertiary) text-pretty">
          Cloud usage is billed to this organization&rsquo;s balance. Agents on daemons you connected yourself use the
          credentials on those machines and are never billed here.
        </p>
      )}
    </div>
  )
}

function MetaItem({ icon, text, mono = false }: { icon: string; text: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
      <Icon name={icon} size={14} color="var(--text-tertiary)" />
      {mono ? <span className="mono text-[12px]">{text}</span> : text}
    </span>
  )
}

/**
 * What Cloud costs, on the one figure the billing service will actually stand behind.
 *
 * NOT the design's "included usage" bar: this deployment sells prepaid credit, so there is no
 * plan quota to fill a track with, and drawing one from load telemetry would read as a real
 * ceiling. The balance is a settled fact, so it is what shows — and it shares SWR's cache key
 * with the Billing page, so opening this page costs no extra request there.
 */
function CloudBillingCard() {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id ?? null
  const account = useSWR(orgId ? consoleKeys.billingAccount(orgId) : null, () => fetchBillingAccount(orgId!))

  return (
    <div className="card">
      <div className="cardhead">
        <span className="cardtitle">Billing</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">prepaid balance</span>
      </div>
      <div className="px-4 py-[15px]">
        {account.error ? (
          <div className="flex items-start gap-2 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            <Icon name="triangle-alert" size={15} color="var(--status-error)" />
            Could not reach the billing service.
          </div>
        ) : account.data ? (
          <>
            <div className="mono text-[22px] leading-none font-semibold">{fmtMicroUsd(account.data.balanceMicro)}</div>
            <p className="mt-[10px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
              Sessions that run on Cloud draw down this balance. Top it up on the Billing page.
            </p>
          </>
        ) : (
          <div className="mono text-[22px] leading-none font-semibold text-(--text-tertiary)">—</div>
        )}
      </div>
    </div>
  )
}

/** The capacity a self-hoster's own members report — the numbers only they can act on. */
function ClusterCapacityCard({
  capacityLabel,
  capacityPct,
  unbounded,
  cpu,
  mem
}: {
  capacityLabel: string
  capacityPct: number
  unbounded: boolean
  cpu: number
  mem: number
}) {
  return (
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
  )
}
