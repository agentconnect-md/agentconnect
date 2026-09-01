import { systemClock, type Clock } from '@agentconnect.md/connection'
import type { LocalStore } from './local-store.js'

/**
 * The daemon store's ONE retention home (k8s-daemon-pool.md §4).
 *
 * Every table that used to carry its own prune — a private constant, a private cutoff, a
 * `DELETE … WHERE … < x` wherever its writer happened to live — is a row in
 * {@link STORE_RETENTION_RULES} instead, and one sweep loop below runs them all. Adding
 * retention to a table is a rule, not a function; changing a horizon is a number, not a
 * new cutoff to find.
 *
 * Two proofs collect a row, and a rule may earn either or both:
 *
 * - **horizon** — the row has been owed for the rule's window. This is plain retention: it
 *   is what the routines this module replaced already did, so it is always on. A rule's
 *   `clock` deliberately ages the WORK, not the attempt: it is the stamp a new obligation
 *   writes (`purgedAt`, `queuedAt`, `completedAt`, a cache's `observedAt`), never a lease
 *   a retry refreshes — a receipt no control plane will ever accept is re-claimed on every
 *   drain, so aging it on `claimedAt` would make exactly the rows retention exists for
 *   immortal.
 * - **agent gone** — the control plane no longer knows the row's agent, so no member can
 *   ever drain it. This is the new proof, it needs an existence read the sweeper only has
 *   inside `reconcile --once`, and it ships dry-run behind {@link STORE_ORPHAN_DELETE_ENV}.
 *
 * Two callers, one table. The daemon's own hourly sweep runs the rules age-only against its
 * own store — a local single-daemon install keeps working exactly as it did, because
 * retention was never about ownership there. The pool's `reconcile --once` CronJob runs them
 * with the control-plane read as well, which is the half only a shared store needs.
 */

/** Deployment-owned settings, env like the rest of the plane's; absent ⇒ the defaults below. */
export const STORE_ORPHAN_DELETE_ENV = 'AC_STORE_ORPHAN_DELETE'
export const STORE_RETENTION_SCALE_ENV = 'AC_STORE_RETENTION_SCALE'

const DAY_MS = 24 * 3_600_000
/** The default window for a per-member outbox row nobody has touched. */
export const DEFAULT_STORE_HORIZON_MS = 7 * DAY_MS
/** Per-table scan cap: a run collects a bounded batch and the next run takes the rest. */
export const STORE_RETENTION_SCAN_LIMIT = 5_000

/**
 * One table's retention, declared. `clock` and `where` are SQL fragments over `table` only —
 * the sweep composes the SELECT and the re-fenced DELETE from them, so a rule never carries a
 * statement of its own.
 */
export interface StoreRetentionRule {
  /** Stable id; also the per-rule counter in the summary line. */
  id: string
  table: string
  /** Columns identifying one row. The delete re-fences on them plus the clock. */
  key: readonly string[]
  /** Epoch-ms expression ageing the WORK — the stamp a new obligation writes, never a lease
   *  a retry refreshes, or a row nothing will ever accept would never age out. */
  clock: string
  /** Which rows this rule is about at all; absent ⇒ every row of the table. */
  where?: string
  /** Column naming the agent, where the control plane can be asked whether it still exists. */
  agentColumn?: string
  /** Column naming the writing process. A row whose owner is not the sweeper's uses `foreignHorizonMs`. */
  ownerColumn?: string
  /** How long a row survives after its clock. */
  horizonMs: number
  /** Shorter window for a row written by a process that is not this sweeper — its owner is gone. */
  foreignHorizonMs?: number
}

/** The two catalog tables age as ONE `(ownerId, runtimeId)` catalog: a phase-1 refresh
 *  re-stamps the meta row and the seed model only, so a row-by-row clock would collect the
 *  models discovery just found and leave `complete`/`modelsHash` standing. */
const catalogClock = (table: string): string =>
  `(SELECT COALESCE(MAX(seen.observedAt), 0) FROM (
      SELECT ownerId, runtimeId, observedAt FROM runtime_catalog_meta
      UNION ALL
      SELECT ownerId, runtimeId, observedAt FROM runtime_model_catalog
    ) seen WHERE seen.ownerId = ${table}.ownerId AND seen.runtimeId = ${table}.runtimeId)`

export const STORE_RETENTION_RULES: readonly StoreRetentionRule[] = [
  // ── per-member outboxes: an ownerId/claimedAt lease, drained by whoever holds it ──
  {
    id: 'hook-report',
    table: 'inbox',
    key: ['id'],
    clock: 'completedAt',
    where: 'terminalReport IS NOT NULL',
    agentColumn: 'agentId',
    ownerColumn: 'reportOwnerId',
    horizonMs: DEFAULT_STORE_HORIZON_MS
  },
  {
    // A born-completed inbox row is a DEDUP RECEIPT, not work: it records that a delivery was
    // already served, so a provider redelivery arriving long after the turn settled is dropped
    // instead of re-run (linear-integration.md §4.5). Nothing drains it — the only other prune
    // is a bounded backstop that fires when a hook report is acknowledged, which a daemon
    // serving no hooks never reaches — so retention is what keeps it from growing forever. The
    // default window comfortably outlives Linear's 1 min / 1 h / 6 h redelivery ladder.
    id: 'delivery-receipt',
    table: 'inbox',
    key: ['id'],
    clock: 'completedAt',
    where: 'completedAt IS NOT NULL AND terminalReport IS NULL',
    agentColumn: 'agentId',
    horizonMs: DEFAULT_STORE_HORIZON_MS
  },
  {
    // An outward id minted before its session row exists (§1.1). The turn's insert adopts it and
    // `deleteSession` drops it, so what ages out here is a slot whose turn never dispatched, or an
    // `internal:*` key — dream / memory / commit work that never becomes a session at all. Aging
    // one out is safe: the session, if it exists, answers with its own column first.
    id: 'outward-id',
    table: 'session_outward_ids',
    key: ['key'],
    clock: 'mintedAt',
    agentColumn: 'agentId',
    horizonMs: DEFAULT_STORE_HORIZON_MS
  },
  {
    id: 'session-metadata',
    table: 'session_metadata_outbox',
    key: ['agentId', 'sessionId'],
    clock: 'queuedAt',
    agentColumn: 'agentId',
    ownerColumn: 'ownerId',
    horizonMs: DEFAULT_STORE_HORIZON_MS
  },
  {
    // 30 days, unchanged from the ad-hoc prune this replaced: a receipt is the only record
    // that a transcript was deleted, so it outlives the other outboxes on purpose.
    id: 'session-purge',
    table: 'session_purges',
    key: ['agentId', 'sessionId'],
    clock: 'purgedAt',
    agentColumn: 'agentId',
    ownerColumn: 'ownerId',
    horizonMs: 30 * DAY_MS
  },
  {
    // `updatedAt` moves on every failed revocation attempt, and here that is right: giving up
    // on revoking a LIVE agent's authority would leave it standing. A gone agent's row is the
    // agent-gone proof's, and the CP row cascades with the agent anyway.
    id: 'webchat-grant',
    table: 'webchat_mcp_grant_ledger',
    key: ['conversationId'],
    clock: 'updatedAt',
    agentColumn: 'agentId',
    ownerColumn: 'ownerId',
    horizonMs: DEFAULT_STORE_HORIZON_MS
  },
  // ── bounded history: rows that reached a terminal state and are pure history afterwards ──
  {
    // The `expire` transition that redacts a live capture stays with the outbox loop — it is a
    // state change with a metric, not retention. Dropping the terminal row is this rule's.
    id: 'memory-capture',
    table: 'memory_capture_outbox',
    key: ['operationId'],
    clock: 'updatedAt',
    where: "state IN ('completed', 'failed', 'ambiguous')",
    agentColumn: 'agentId',
    horizonMs: DAY_MS
  },
  {
    id: 'activation',
    table: 'activation_rendezvous',
    key: ['activationKey'],
    clock: 'expiresAt',
    where: "state <> 'pending'",
    horizonMs: DAY_MS
  },
  // ── model-catalog cache: reclaimed by age, and sooner when its writer is gone ──
  {
    id: 'catalog-meta',
    table: 'runtime_catalog_meta',
    key: ['ownerId', 'runtimeId'],
    clock: catalogClock('runtime_catalog_meta'),
    ownerColumn: 'ownerId',
    horizonMs: 30 * DAY_MS,
    foreignHorizonMs: 7 * DAY_MS
  },
  {
    id: 'catalog-models',
    table: 'runtime_model_catalog',
    key: ['ownerId', 'runtimeId', 'modelId'],
    clock: catalogClock('runtime_model_catalog'),
    ownerColumn: 'ownerId',
    horizonMs: 30 * DAY_MS,
    foreignHorizonMs: 7 * DAY_MS
  }
]

/** One row a rule matched, as the sweep reads it. */
export interface StoreRetentionCandidate {
  /** The rule's key columns, exactly as read — the delete binds them back. */
  key: Record<string, string | number>
  agentId?: string
  ownerId?: string
  /** Epoch ms of the last write anyone made to the row. */
  touchedAt: number
}

/** What the sweep needs from the store, and nothing more. */
export interface RetentionStore {
  listRetentionCandidates(rule: StoreRetentionRule, limit: number): Promise<StoreRetentionCandidate[]>
  deleteRetentionRow(rule: StoreRetentionRule, candidate: StoreRetentionCandidate): Promise<boolean>
}

export interface StoreRetentionSettings {
  /** Multiplies every rule's horizon, so a deployment tunes the whole table at once. */
  scale: number
  /** Whether the agent-gone proof may delete. The horizon proof always may — it is retention. */
  deleteOrphans: boolean
}

export function resolveStoreRetentionSettings(env: NodeJS.ProcessEnv = process.env): StoreRetentionSettings {
  const raw = env[STORE_RETENTION_SCALE_ENV]?.trim()
  let scale = 1
  if (raw) {
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${STORE_RETENTION_SCALE_ENV} is not a positive number: ${raw}`)
    scale = value
  }
  const flag = env[STORE_ORPHAN_DELETE_ENV]?.trim().toLowerCase()
  return { scale, deleteOrphans: flag === '1' || flag === 'true' }
}

/** One sweep's counters, also the shape of its summary log line. */
export interface StoreRetentionSummary {
  candidates: number
  collected: number
  deleted: number
  kept: number
  failed: number
  /** Why each collected row was collected. */
  agentGone: number
  horizon: number
  /** Collected rows per rule, counted whether or not the delete was allowed to run. */
  byRule: Record<string, number>
}

export interface StoreRetentionSweeperDeps {
  store: RetentionStore
  settings: StoreRetentionSettings
  /** Present only where the control plane can be asked; absent ⇒ an age-only sweep. */
  liveAgents?: (agentIds: string[]) => Promise<Set<string>>
  /** This sweeper's own owner id. Absent ⇒ it owns nothing and every row keeps the long horizon. */
  ownerId?: string
  rules?: readonly StoreRetentionRule[]
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const describe = (row: StoreRetentionCandidate): string => Object.values(row.key).join('/')

export class StoreRetentionSweeper {
  private readonly clock: Clock
  private readonly rules: readonly StoreRetentionRule[]

  constructor(private readonly deps: StoreRetentionSweeperDeps) {
    this.clock = deps.clock ?? systemClock
    this.rules = deps.rules ?? STORE_RETENTION_RULES
  }

  /**
   * One sweep, age only. It asks the control plane nothing, which is what lets startup run it
   * before the model-catalog cache is hydrated, where a stale catalog must already be gone
   * before anything reads it.
   */
  async sweepAgeOnly(): Promise<StoreRetentionSummary | undefined> {
    try {
      return await this.collect(await this.read(), undefined)
    } catch (err) {
      this.deps.log.warn(`store retention: sweep failed — ${(err as Error).message}`)
      return undefined
    }
  }

  /** One sweep including the agent-existence proof. Resolves undefined when it failed —
   *  the CronJob turns that into a non-zero exit. */
  async sweep(): Promise<StoreRetentionSummary | undefined> {
    try {
      const found = await this.read()
      return await this.collect(found, await this.askLive(found))
    } catch (err) {
      this.deps.log.warn(`store retention: sweep failed — ${(err as Error).message}`)
      return undefined
    }
  }

  private async read(): Promise<{ rule: StoreRetentionRule; rows: StoreRetentionCandidate[] }[]> {
    const found: { rule: StoreRetentionRule; rows: StoreRetentionCandidate[] }[] = []
    for (const rule of this.rules)
      found.push({ rule, rows: await this.deps.store.listRetentionCandidates(rule, STORE_RETENTION_SCAN_LIMIT) })
    return found
  }

  /** ONE existence read for the whole sweep, over every rule that names an agent. */
  private async askLive(
    found: { rule: StoreRetentionRule; rows: StoreRetentionCandidate[] }[]
  ): Promise<Set<string> | undefined> {
    const askable = [
      ...new Set(
        found.flatMap(({ rule, rows }) =>
          rule.agentColumn ? rows.map((row) => row.agentId).filter((id): id is string => !!id && UUID.test(id)) : []
        )
      )
    ]
    return this.deps.liveAgents && askable.length > 0 ? await this.deps.liveAgents(askable) : undefined
  }

  private async collect(
    found: { rule: StoreRetentionRule; rows: StoreRetentionCandidate[] }[],
    live: Set<string> | undefined
  ): Promise<StoreRetentionSummary> {
    const { settings, log, store } = this.deps
    const now = this.clock.now()
    const summary = emptySummary(this.rules)
    for (const { rows } of found) summary.candidates += rows.length
    for (const { rule, rows } of found) {
      for (const row of rows) {
        const reason = this.classify(rule, row, now, live)
        if (!reason) {
          summary.kept += 1
          continue
        }
        summary.collected += 1
        summary.byRule[rule.id] = (summary.byRule[rule.id] ?? 0) + 1
        if (reason === 'agent-gone') summary.agentGone += 1
        else summary.horizon += 1
        // The horizon proof IS the retention these rules replaced, so it always deletes. The
        // agent-gone proof is the new one and only reports until the deployment turns it on.
        if (reason === 'agent-gone' && !settings.deleteOrphans) {
          log.info(`store retention: would delete ${rule.id} ${describe(row)} (agent gone) — dry run`)
          continue
        }
        try {
          if (await store.deleteRetentionRow(rule, row)) summary.deleted += 1
          else log.info(`store retention: ${rule.id} ${describe(row)} was written since it was listed — left alone`)
        } catch (err) {
          summary.failed += 1
          log.warn(`store retention: deleting ${rule.id} ${describe(row)} failed — ${(err as Error).message}`)
        }
      }
    }
    log.info(
      `store retention: swept ${summary.candidates} candidates — collected=${summary.collected} ` +
        `deleted=${summary.deleted} kept=${summary.kept} failed=${summary.failed} ` +
        `agent-gone=${summary.agentGone} horizon=${summary.horizon} ` +
        this.rules.map((rule) => `${rule.id}=${summary.byRule[rule.id] ?? 0}`).join(' ') +
        (settings.deleteOrphans ? '' : ' (orphan dry run)')
    )
    return summary
  }

  /** Why this row is collectable, or undefined to keep it. Never guesses: an id the control
   *  plane was not asked about counts as live, and an unreadable clock is never past a horizon. */
  private classify(
    rule: StoreRetentionRule,
    row: StoreRetentionCandidate,
    now: number,
    live: Set<string> | undefined
  ): 'agent-gone' | 'horizon' | undefined {
    if (live && rule.agentColumn && row.agentId && UUID.test(row.agentId) && !live.has(row.agentId)) return 'agent-gone'
    // A row this sweeper did not write has a departed owner; that is the shorter window.
    const foreign = this.deps.ownerId !== undefined && row.ownerId !== this.deps.ownerId
    const horizon = (foreign ? (rule.foreignHorizonMs ?? rule.horizonMs) : rule.horizonMs) * this.deps.settings.scale
    return Number.isFinite(row.touchedAt) && now - row.touchedAt >= horizon ? 'horizon' : undefined
  }
}

function emptySummary(rules: readonly StoreRetentionRule[]): StoreRetentionSummary {
  return {
    candidates: 0,
    collected: 0,
    deleted: 0,
    kept: 0,
    failed: 0,
    agentGone: 0,
    horizon: 0,
    byRule: Object.fromEntries(rules.map((rule) => [rule.id, 0]))
  }
}

/** The store surface the sweeper drives, so a caller can pass a `LocalStore` straight in. */
export type RetentionCapableStore = Pick<LocalStore, 'listRetentionCandidates' | 'deleteRetentionRow'>
