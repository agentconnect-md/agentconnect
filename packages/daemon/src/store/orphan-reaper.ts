import { systemClock, type Clock } from '@agentconnect.md/connection'
import type { LocalStore, StoreOrphanKind, StoreOrphanRow } from './local-store.js'

/**
 * The store half of the pool's orphan reconciler: ONE sweep that collects per-member outbox
 * rows nobody will ever drain, instead of every table carrying its own retention rule
 * (k8s-daemon-pool.md §4).
 *
 * It runs inside the same `agentconnect-daemon reconcile --once` CronJob as the Kubernetes
 * half, so one schedule covers both, and only against a pool's SHARED data-plane store: a
 * local single-daemon store has one owner, its rows are its own, and no member can vanish out
 * from under them.
 *
 * A row is collected on one of two proofs, both cheap and both durable:
 *
 * - **agent gone** — the control plane no longer knows the row's agent, so no member can ever
 *   report it: an `event/session-sync` or hook report for a deleted agent is refused forever.
 * - **horizon** — nothing has written the row for {@link DEFAULT_STORE_ORPHAN_HORIZON_MS}. A
 *   live owner renews its claim on every drain attempt, so an untouched claim means its owner
 *   is gone and no peer that could take over ever did.
 *
 * Anything else is left alone, and an id the control plane cannot be asked about counts as
 * live — never guess. Like the Kubernetes half it ships dry-run and logs one summary line.
 */

/** Deployment-owned settings, env like the rest of the plane's; absent ⇒ the default below. */
export const STORE_ORPHAN_HORIZON_ENV = 'AC_STORE_ORPHAN_HORIZON_MS'
/** Deletion is opt-in, separately from the Kubernetes half: `1`/`true` collects, anything else reports. */
export const STORE_ORPHAN_DELETE_ENV = 'AC_STORE_ORPHAN_DELETE'
/** The ONE retention horizon every per-member outbox table is judged by. */
export const DEFAULT_STORE_ORPHAN_HORIZON_MS = 7 * 24 * 3_600_000
/** Per-table scan cap: a run collects a bounded batch and the next run takes the rest. */
const STORE_ORPHAN_SCAN_LIMIT = 5_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS: StoreOrphanKind[] = ['hook-report', 'session-metadata', 'session-purge', 'webchat-grant']

export interface StoreOrphanReaperSettings {
  horizonMs: number
  deleteEnabled: boolean
}

export function resolveStoreOrphanReaperSettings(env: NodeJS.ProcessEnv = process.env): StoreOrphanReaperSettings {
  const raw = env[STORE_ORPHAN_HORIZON_ENV]?.trim()
  let horizonMs = DEFAULT_STORE_ORPHAN_HORIZON_MS
  if (raw) {
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${STORE_ORPHAN_HORIZON_ENV} is not a positive integer: ${raw}`)
    horizonMs = value
  }
  const flag = env[STORE_ORPHAN_DELETE_ENV]?.trim().toLowerCase()
  return { horizonMs, deleteEnabled: flag === '1' || flag === 'true' }
}

/** One sweep's counters, also the shape of its summary log line. */
export interface StoreOrphanSweepSummary {
  candidates: number
  orphaned: number
  deleted: number
  skippedLive: number
  failed: number
  /** Why each orphan was collected, and from which table — counted whether or not deletion is on. */
  agentGone: number
  horizon: number
  byKind: Record<StoreOrphanKind, number>
}

export interface StoreOrphanReaperDeps {
  store: Pick<LocalStore, 'isShared' | 'listStoreOrphanCandidates' | 'deleteStoreOrphan'>
  /** Which of these agents the control plane still knows; a throw fails the sweep. */
  liveAgents: (agentIds: string[]) => Promise<Set<string>>
  settings: StoreOrphanReaperSettings
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void }
}

export class StoreOrphanReaper {
  private readonly clock: Clock

  constructor(private readonly deps: StoreOrphanReaperDeps) {
    this.clock = deps.clock ?? systemClock
  }

  /** One sweep. Resolves undefined when it failed — the CronJob turns that into a non-zero exit. */
  async sweep(): Promise<StoreOrphanSweepSummary | undefined> {
    try {
      return await this.runSweep()
    } catch (err) {
      this.deps.log.warn(`store orphans: sweep failed — ${(err as Error).message}`)
      return undefined
    }
  }

  private async runSweep(): Promise<StoreOrphanSweepSummary> {
    const { settings, log, store } = this.deps
    const now = this.clock.now()
    // A local single-daemon store has one owner forever; its rows are its own to drain.
    if (!store.isShared) {
      log.info('store orphans: not a shared pool store — nothing to sweep')
      return emptySummary(0)
    }
    const candidates = store.listStoreOrphanCandidates(STORE_ORPHAN_SCAN_LIMIT)
    const summary = emptySummary(candidates.length)
    const askable = [...new Set(candidates.filter((row) => UUID.test(row.agentId)).map((row) => row.agentId))]
    const live = askable.length > 0 ? await this.deps.liveAgents(askable) : new Set<string>()
    const orphans: { row: StoreOrphanRow; reason: 'agent-gone' | 'horizon' }[] = []
    for (const row of candidates) {
      // An id the control plane could not even be asked about is treated as live.
      const agentGone = UUID.test(row.agentId) && !live.has(row.agentId)
      // An unreadable clock is never past the horizon: an age nobody knows collects nothing.
      const pastHorizon = Number.isFinite(row.touchedAt) && now - row.touchedAt >= settings.horizonMs
      if (agentGone) orphans.push({ row, reason: 'agent-gone' })
      else if (pastHorizon) orphans.push({ row, reason: 'horizon' })
      else summary.skippedLive += 1
    }
    summary.orphaned = orphans.length
    for (const { row, reason } of orphans) {
      if (reason === 'agent-gone') summary.agentGone += 1
      else summary.horizon += 1
      summary.byKind[row.kind] += 1
      if (!settings.deleteEnabled) {
        log.info(`store orphans: would delete ${row.kind} ${row.id} (agent ${row.agentId}, ${reason}) — dry run`)
        continue
      }
      try {
        if (store.deleteStoreOrphan(row)) {
          summary.deleted += 1
        } else {
          log.info(`store orphans: ${row.kind} ${row.id} was claimed since it was listed — left alone`)
        }
      } catch (err) {
        summary.failed += 1
        log.warn(`store orphans: deleting ${row.kind} ${row.id} failed — ${(err as Error).message}`)
      }
    }
    log.info(
      `store orphans: swept ${summary.candidates} candidates — orphaned=${summary.orphaned} ` +
        `deleted=${summary.deleted} skipped-live=${summary.skippedLive} failed=${summary.failed} ` +
        `agent-gone=${summary.agentGone} horizon=${summary.horizon} ` +
        KINDS.map((kind) => `${kind}=${summary.byKind[kind]}`).join(' ') +
        (settings.deleteEnabled ? '' : ' (dry run)')
    )
    return summary
  }
}

function emptySummary(candidates: number): StoreOrphanSweepSummary {
  return {
    candidates,
    orphaned: 0,
    deleted: 0,
    skippedLive: 0,
    failed: 0,
    agentGone: 0,
    horizon: 0,
    byKind: { 'hook-report': 0, 'session-metadata': 0, 'session-purge': 0, 'webchat-grant': 0 }
  }
}
