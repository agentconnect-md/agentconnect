/**
 * Pool capacity gauges — the "alarm on vacant-duty age" the pool design leaves to the CP
 * (k8s-daemon-pool.md §12: the CP "never load-balances, never schedules, never picks; it only
 * refuses invalid claims and alarms on vacant-duty age. A human scales the Deployment.").
 *
 * The CP is the ledger, so it is the only place that can answer "is the pool big enough" without
 * a second opinion: capacity and unmet demand are both read from `duty_group` through the same
 * predicates the claim paths gate on. Two signals, deliberately paired — headroom is the leading
 * one (scale before it hurts), vacancy age the lagging one (something is already unserved).
 *
 * Every CP replica observes the same install-wide numbers, so these are fleet totals repeated per
 * pod, not per-pod shards: aggregate them with `max by (...)`, never `sum`.
 */
import { metrics, type BatchObservableResult, type ObservableGauge } from '@opentelemetry/api'
import type { PoolTelemetryRow } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'

/** The ledger read these gauges project. */
export interface PoolTelemetrySource {
  poolTelemetry(now: Date, liveMs: number, maxMembers: number): Promise<PoolTelemetryRow[]>
}

export interface PoolMetricsLog {
  warn(obj: unknown, msg?: string): void
}

export interface PoolMetricsDeps {
  repo: PoolTelemetrySource
  clock: Clock
  /** Liveness horizon — pass the duty lease's `leaseMs` so "live" means what the ledger means. */
  liveMs: number
  /** Deliverability cap — pass `DUTY_GRANT_MEMBERS_MAX` so "claimable" means what the claim means. */
  maxMembers: number
  log?: PoolMetricsLog
}

export type PoolMetricName =
  | 'members'
  | 'unbounded'
  | 'capacity'
  | 'used'
  | 'headroom'
  | 'vacantGroups'
  | 'vacantAge'
  | 'undeliverable'
  | 'capabilityBlocked'

export interface PoolObservation {
  metric: PoolMetricName
  value: number
  attrs: { set: string; scope: 'install' | 'org' }
}

/** Ledger rows → the series each gauge reports. Pure, so the alert's input is testable on its own. */
export function poolObservations(rows: readonly PoolTelemetryRow[]): PoolObservation[] {
  return rows.flatMap((row) => {
    const attrs = { set: row.setName, scope: row.installWide ? ('install' as const) : ('org' as const) }
    const at = (metric: PoolMetricName, value: number): PoolObservation => ({ metric, value, attrs })
    // `maxAgents <= 0` is the daemon's UNBOUNDED sentinel, not a ceiling of zero, so a set holding
    // such a member HAS no finite budget. Capacity and headroom are therefore not reported at all
    // rather than reported as a number: folding the sentinel into the sum would advertise a member
    // that accepts everything as contributing nothing, and the "pool is full" alarm would fire
    // permanently on a pool that can never be full — the signal inverted. Omitting the series
    // leaves that alert with no data, which it already treats as OK. `unbounded` is what makes the
    // gap legible on the dashboard instead of looking like a broken exporter.
    const bounded = row.unboundedMembers === 0
    return [
      at('members', row.liveMembers),
      at('unbounded', row.unboundedMembers),
      ...(bounded ? [at('capacity', row.capacityAgents), at('headroom', row.capacityAgents - row.dutyAgents)] : []),
      at('used', row.dutyAgents),
      at('vacantGroups', row.vacantGroups),
      at('vacantAge', row.oldestVacancySec),
      at('undeliverable', row.oversizedVacantGroups),
      at('capabilityBlocked', row.capabilityBlockedVacantGroups)
    ]
  })
}

/**
 * One collection's worth of observations, or `null` to report nothing at all.
 *
 * A collection that cannot read the ledger must skip rather than observe zeros: a zeroed headroom
 * gauge is indistinguishable from a full pool, so a database blip would fire the capacity alert.
 */
export async function readPoolObservations(deps: PoolMetricsDeps): Promise<PoolObservation[] | null> {
  try {
    const rows = await deps.repo.poolTelemetry(new Date(deps.clock.now()), deps.liveMs, deps.maxMembers)
    return poolObservations(rows)
  } catch (err) {
    deps.log?.warn({ err }, 'pool-metrics: ledger read failed, skipping this collection')
    return null
  }
}

export interface PoolMetricsHandle {
  /** Unregister the callback. MUST run before Prisma disconnects, or a collection races shutdown. */
  stop(): void
}

const meter = metrics.getMeter('@agentconnect.md/control-plane-pool', '1.0.0')

function createGauges(): Record<PoolMetricName, ObservableGauge> {
  return {
    members: meter.createObservableGauge('agentconnect.pool.members', {
      unit: '{member}',
      description: 'Pool members seen within the duty lease horizon'
    }),
    unbounded: meter.createObservableGauge('agentconnect.pool.unbounded_members', {
      unit: '{member}',
      description:
        'Live members configured with no ceiling (maxAgents <= 0). Non-zero ⇒ capacity and headroom are not reported for this set, because it has no finite budget'
    }),
    capacity: meter.createObservableGauge('agentconnect.pool.capacity.agents', {
      unit: '{agent}',
      description:
        'Duty budget the live BOUNDED members of a set can spend (sum of maxAgents). Not reported at all while any member is unbounded'
    }),
    used: meter.createObservableGauge('agentconnect.pool.duty.agents', {
      unit: '{agent}',
      description: 'Distinct agents covered by unexpired leases the set holds'
    }),
    headroom: meter.createObservableGauge('agentconnect.pool.headroom.agents', {
      unit: '{agent}',
      description: 'Unspent duty budget: capacity minus duty-covered agents. At or below zero the pool is full'
    }),
    vacantGroups: meter.createObservableGauge('agentconnect.duty.vacant.groups', {
      unit: '{group}',
      description: 'Vacant duty groups the set is eligible to claim and can deliver — unmet demand'
    }),
    vacantAge: meter.createObservableGauge('agentconnect.duty.vacant.oldest_age', {
      unit: 's',
      description: 'Age of the oldest claimable vacancy. Sustained above a beat means nothing could take it'
    }),
    undeliverable: meter.createObservableGauge('agentconnect.duty.undeliverable.groups', {
      unit: '{group}',
      description: 'Vacant groups over the wire member cap — never claimable at any pool size; needs a dedicated daemon'
    }),
    capabilityBlocked: meter.createObservableGauge('agentconnect.duty.capability_blocked.groups', {
      unit: '{group}',
      description:
        'Vacant groups needing a platform no live member of the set advertises — scaling cannot clear it; roll the image forward'
    })
  }
}

/**
 * Register the batch callback. One ledger read per collection interval feeds every gauge, so a
 * set’s series are one consistent snapshot rather than several independently-timed reads.
 */
export function registerPoolMetrics(deps: PoolMetricsDeps): PoolMetricsHandle {
  const gauges = createGauges()
  const observed = Object.values(gauges)
  let stopped = false

  const callback = async (result: BatchObservableResult): Promise<void> => {
    if (stopped) return
    const observations = await readPoolObservations(deps)
    // Re-checked after the await: a shutdown that began mid-read must not observe against a
    // provider that is going away, nor keep the ledger read alive past Prisma's disconnect.
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
