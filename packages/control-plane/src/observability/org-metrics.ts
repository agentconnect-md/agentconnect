/**
 * Per-org footprint gauges — "how much of this install is each organization actually using".
 *
 * The CP's Postgres is the only place that can answer it: daemons, agents and sessions each carry
 * `orgId` (session_meta's is denormalized at ingest), so one pass over three tables states the
 * whole install. Sibling of `pool-metrics.ts` in shape and in discipline — one read per collection
 * feeding every gauge, and a failed read reports NOTHING rather than zeros.
 *
 * Two things to know before reading a dashboard built on these:
 *
 *  - `org.daemons` counts daemons the org OWNS. A pool member belongs to no org, so an org running
 *    entirely on the install-wide pool reads zero here no matter how much of it it occupies — its
 *    demand is in the `agentconnect.pool.*` / `agentconnect.duty.*` series instead.
 *  - `org.sessions{window="total"}` is a lifetime count over an unpruned table, so it only ever
 *    climbs. The `30d`/`24h` windows are the ones that show whether an org is still active.
 *
 * Every CP replica observes the same install-wide numbers, so these are fleet totals repeated per
 * pod, not per-pod shards: aggregate them with `max by (...)`, never `sum`. Series count is
 * (orgs × 5) per replica — cheap at this scale, and the thing to watch if org count ever explodes.
 */
import { metrics, type BatchObservableResult, type ObservableGauge } from '@opentelemetry/api'
import type { OrgTelemetryRow } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'

/** The read these gauges project. */
export interface OrgTelemetrySource {
  orgTelemetry(now: Date): Promise<OrgTelemetryRow[]>
}

export interface OrgMetricsLog {
  warn(obj: unknown, msg?: string): void
}

export interface OrgMetricsDeps {
  repo: OrgTelemetrySource
  clock: Clock
  log?: OrgMetricsLog
}

export type OrgMetricName = 'daemons' | 'agents' | 'sessions'

/** `total` is the lifetime count; the others are how many sessions STARTED in that window. */
export type SessionWindow = 'total' | '30d' | '24h'

export interface OrgObservation {
  metric: OrgMetricName
  value: number
  attrs: { org: string; window?: SessionWindow }
}

/** Rows → the series each gauge reports. Pure, so a dashboard's input is testable on its own. */
export function orgObservations(rows: readonly OrgTelemetryRow[]): OrgObservation[] {
  return rows.flatMap((row): OrgObservation[] => {
    const org = row.orgSlug
    const sessions = (window: SessionWindow, value: number): OrgObservation => ({
      metric: 'sessions',
      value,
      attrs: { org, window }
    })
    return [
      { metric: 'daemons', value: row.daemons, attrs: { org } },
      { metric: 'agents', value: row.agents, attrs: { org } },
      sessions('total', row.sessionsTotal),
      sessions('30d', row.sessions30d),
      sessions('24h', row.sessions24h)
    ]
  })
}

/**
 * One collection's worth of observations, or `null` to report nothing at all.
 *
 * A collection that cannot read the database must skip rather than observe zeros: a zeroed org
 * is indistinguishable from one that just lost every daemon it had, so a database blip would
 * read as a fleet-wide outage on the dashboard.
 */
export async function readOrgObservations(deps: OrgMetricsDeps): Promise<OrgObservation[] | null> {
  try {
    return orgObservations(await deps.repo.orgTelemetry(new Date(deps.clock.now())))
  } catch (err) {
    deps.log?.warn({ err }, 'org-metrics: org read failed, skipping this collection')
    return null
  }
}

export interface OrgMetricsHandle {
  /** Unregister the callback. MUST run before Prisma disconnects, or a collection races shutdown. */
  stop(): void
}

const meter = metrics.getMeter('@agentconnect.md/control-plane-org', '1.0.0')

function createGauges(): Record<OrgMetricName, ObservableGauge> {
  return {
    daemons: meter.createObservableGauge('agentconnect.org.daemons', {
      unit: '{daemon}',
      description:
        'Daemons registered to the org, any status. Install-wide pool members belong to no org and are counted for none — see agentconnect.pool.* for those'
    }),
    agents: meter.createObservableGauge('agentconnect.org.agents', {
      unit: '{agent}',
      description: 'Agents defined in the org, including inactive and unplaced ones'
    }),
    sessions: meter.createObservableGauge('agentconnect.org.sessions', {
      unit: '{session}',
      description:
        'Sessions the org started: window="total" is the lifetime count over an unpruned table (monotonic), window="30d"/"24h" are how many began in that window'
    })
  }
}

/**
 * Register the batch callback. One database read per collection interval feeds every gauge, so an
 * org's series are one consistent snapshot rather than three independently-timed reads.
 */
export function registerOrgMetrics(deps: OrgMetricsDeps): OrgMetricsHandle {
  const gauges = createGauges()
  const observed = Object.values(gauges)
  let stopped = false

  const callback = async (result: BatchObservableResult): Promise<void> => {
    if (stopped) return
    const observations = await readOrgObservations(deps)
    // Re-checked after the await: a shutdown that began mid-read must not observe against a
    // provider that is going away, nor keep the read alive past Prisma's disconnect.
    if (stopped || !observations) return
    for (const o of observations) result.observe(gauges[o.metric], o.value, o.attrs)
  }

  meter.addBatchObservableCallback(callback, observed)
  return {
    stop() {
      stopped = true
      meter.removeBatchObservableCallback(callback, observed)
    }
  }
}
