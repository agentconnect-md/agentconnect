// Per-item patrol state (assistant-mode.md §5.9): which next check was patrolled, the failure streak and its backoff, and the run in flight.
import type { StoreQueryResult } from './store-database.js'

/** After this many failed patrols in a row an item is patrolled no more until its next check changes. */
export const PATROL_MAX_FAILURES = 5

/** The wait after the `failures`-th failure in a row: min(60, 2ⁿ) minutes. */
export const patrolBackoffMs = (failures: number): number => Math.min(60, 2 ** failures) * 60_000

export interface AssistantPatrolState {
  agentId: string
  itemId: string
  /** The `nextCheck` the last finished patrol was for; that value is never patrolled again. */
  patrolledNextCheck: number | null
  /** Failed patrols in a row; a finished patrol resets it. */
  failures: number
  /** No patrol before this, after a failure. */
  retryAt: number | null
  /** Patrols stopped after {@link PATROL_MAX_FAILURES} failures, until the item's next check moves off `stoppedNextCheck`. */
  stopped: boolean
  stoppedNextCheck: number | null
  /** The patrol sub-session in flight, and the `nextCheck` it was started for. */
  runningKey: string | null
  runningNextCheck: number | null
  /** The item's observation version when that run started, so any daemon settling it can tell whether it recorded anything. */
  runningObservationVersion: number | null
  /** The report that run kept for its end, so a replay on another daemon still delivers it. */
  runningReport: string | null
  updatedAt: number
}

/** An item whose next check is due and not yet patrolled. */
export interface AssistantPatrolDue {
  itemId: string
  nextCheck: number
}

export const ASSISTANT_PATROL_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_patrol (
        agentId TEXT NOT NULL,
        itemId TEXT NOT NULL,
        patrolledNextCheck INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,
        retryAt INTEGER,
        stopped INTEGER NOT NULL DEFAULT 0,
        stoppedNextCheck INTEGER,
        runningKey TEXT,
        runningNextCheck INTEGER,
        runningObservationVersion INTEGER,
        runningReport TEXT,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, itemId)
      );
`

/** What the patrol state needs from the store. */
export interface AssistantPatrolDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

function stateOf(row: Row): AssistantPatrolState {
  return {
    agentId: String(row.agentId),
    itemId: String(row.itemId),
    patrolledNextCheck: num(row.patrolledNextCheck),
    failures: Number(row.failures),
    retryAt: num(row.retryAt),
    stopped: Number(row.stopped) === 1,
    stoppedNextCheck: num(row.stoppedNextCheck),
    runningKey: str(row.runningKey),
    runningNextCheck: num(row.runningNextCheck),
    runningObservationVersion: num(row.runningObservationVersion),
    runningReport: str(row.runningReport),
    updatedAt: Number(row.updatedAt)
  }
}

export class AssistantPatrolLedger {
  constructor(private readonly db: AssistantPatrolDatabase) {}

  /** Open items whose next check is due, never patrolled for that value, past any backoff and not stopped; earliest first. */
  async due(agentId: string, now: number, limit: number): Promise<AssistantPatrolDue[]> {
    const rows = (
      await this.db.query(
        `SELECT i.id AS itemId, i.nextCheck FROM assistant_item i
           LEFT JOIN assistant_patrol p ON p.agentId = i.agentId AND p.itemId = i.id
          WHERE i.agentId = ? AND i.status IN ('active', 'waiting') AND i.nextCheck IS NOT NULL AND i.nextCheck <= ?
            AND (p.itemId IS NULL OR (
              (p.patrolledNextCheck IS NULL OR p.patrolledNextCheck <> i.nextCheck)
              AND (p.retryAt IS NULL OR p.retryAt <= ?)
              AND (p.stopped = 0 OR p.stoppedNextCheck IS NULL OR p.stoppedNextCheck <> i.nextCheck)))
          ORDER BY i.nextCheck, i.id LIMIT ?`,
        [agentId, now, now, limit]
      )
    ).rows as Row[]
    return rows.map((row) => ({ itemId: String(row.itemId), nextCheck: Number(row.nextCheck) }))
  }

  async get(agentId: string, itemId: string): Promise<AssistantPatrolState | undefined> {
    const row = (
      await this.db.query('SELECT * FROM assistant_patrol WHERE agentId = ? AND itemId = ?', [agentId, itemId])
    ).rows[0] as Row | undefined
    return row ? stateOf(row) : undefined
  }

  /** The item a patrol sub-session is checking, while it runs. */
  async byRunningKey(agentId: string, runningKey: string): Promise<AssistantPatrolState | undefined> {
    const row = (
      await this.db.query('SELECT * FROM assistant_patrol WHERE agentId = ? AND runningKey = ?', [agentId, runningKey])
    ).rows[0] as Row | undefined
    return row ? stateOf(row) : undefined
  }

  /** A patrol starts; a stopped item that is due again had its next check moved, so its streak starts over. */
  async begin(
    agentId: string,
    itemId: string,
    run: { key: string; nextCheck: number; observationVersion: number; now: number }
  ): Promise<void> {
    await this.ensure(agentId, itemId, run.now)
    await this.db.query(
      `UPDATE assistant_patrol SET runningKey = ?, runningNextCheck = ?, runningObservationVersion = ?,
         runningReport = NULL, updatedAt = ?,
         failures = CASE WHEN stopped = 1 THEN 0 ELSE failures END, stopped = 0, stoppedNextCheck = NULL
       WHERE agentId = ? AND itemId = ?`,
      [run.key, run.nextCheck, run.observationVersion, run.now, agentId, itemId]
    )
  }

  /** Keep the running patrol's report for its end; false when that run is no longer the item's. */
  async keepReport(agentId: string, itemId: string, key: string, text: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      'UPDATE assistant_patrol SET runningReport = ?, updatedAt = ? WHERE agentId = ? AND itemId = ? AND runningKey = ?',
      [text, now, agentId, itemId, key]
    )
    return changes > 0
  }

  /** The patrol finished: its next check is done with and the streak is over. False when another run took the item since. */
  async succeed(agentId: string, itemId: string, key: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_patrol SET patrolledNextCheck = runningNextCheck, failures = 0, retryAt = NULL,
         runningKey = NULL, runningNextCheck = NULL, runningObservationVersion = NULL, runningReport = NULL, updatedAt = ?
       WHERE agentId = ? AND itemId = ? AND runningKey = ?`,
      [now, agentId, itemId, key]
    )
    return changes > 0
  }

  /** The patrol failed: back off, and stop at {@link PATROL_MAX_FAILURES}; undefined when another run took the item since. */
  async fail(
    agentId: string,
    itemId: string,
    key: string,
    now: number,
    currentNextCheck: number | null
  ): Promise<{ failures: number; stopped: boolean } | undefined> {
    const state = await this.get(agentId, itemId)
    if (state?.runningKey !== key) return undefined
    const failures = state.failures + 1
    const stopped = failures >= PATROL_MAX_FAILURES
    const { changes } = await this.db.query(
      `UPDATE assistant_patrol SET failures = ?, retryAt = ?, stopped = ?, stoppedNextCheck = ?,
         runningKey = NULL, runningNextCheck = NULL, runningObservationVersion = NULL, runningReport = NULL, updatedAt = ?
       WHERE agentId = ? AND itemId = ? AND runningKey = ?`,
      [
        failures,
        now + patrolBackoffMs(failures),
        stopped ? 1 : 0,
        stopped ? currentNextCheck : null,
        now,
        agentId,
        itemId,
        key
      ]
    )
    return changes > 0 ? { failures, stopped } : undefined
  }

  /** The run ended without counting either way (a pause, a shutdown): the same next check stays due. */
  async release(agentId: string, itemId: string, key: string, now: number): Promise<void> {
    await this.db.query(
      `UPDATE assistant_patrol SET runningKey = NULL, runningNextCheck = NULL, runningObservationVersion = NULL, runningReport = NULL, updatedAt = ?
       WHERE agentId = ? AND itemId = ? AND runningKey = ?`,
      [now, agentId, itemId, key]
    )
  }

  /** This next check is passed over without a patrol, and is not tried again. */
  async skip(agentId: string, itemId: string, nextCheck: number, now: number): Promise<void> {
    await this.ensure(agentId, itemId, now)
    await this.db.query(
      'UPDATE assistant_patrol SET patrolledNextCheck = ?, updatedAt = ? WHERE agentId = ? AND itemId = ?',
      [nextCheck, now, agentId, itemId]
    )
  }

  private async ensure(agentId: string, itemId: string, now: number): Promise<void> {
    await this.db.query(
      'INSERT OR IGNORE INTO assistant_patrol (agentId, itemId, failures, stopped, updatedAt) VALUES (?, ?, 0, 0, ?)',
      [agentId, itemId, now]
    )
  }
}
