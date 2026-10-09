// The persistent parent–child index of assistant-mode sub-sessions (assistant-mode.md §5.6), partitioned by agent.
import { AsyncMutex } from './async-mutex.js'
import type { StoreQueryResult, StoreTx } from './store-database.js'

/** `open` from the delegation on; `done` once it reported back, `failed` once it ended without reporting. */
export type AssistantSubsessionState = 'open' | 'done' | 'failed'

export interface AssistantSubsession {
  agentId: string
  /** The child's logical session key, the `childSessionId` the delegation handed back. */
  childSessionKey: string
  /** The parent session's outward id, the lineage id the child's own row carries. */
  parentSessionId: string
  /** The parent session's logical key, for the main conversation's own lookups. */
  parentSessionKey: string
  state: AssistantSubsessionState
  createdAt: number
  /** A patrol the daemon started (assistant-mode.md §5.9); a delegation reads back without it. */
  kind?: 'patrol'
}

export const ASSISTANT_SUBSESSION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_subsession (
        agentId TEXT NOT NULL,
        childSessionKey TEXT NOT NULL,
        parentSessionId TEXT NOT NULL,
        parentSessionKey TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'delegation',
        PRIMARY KEY (agentId, childSessionKey)
      );
      CREATE INDEX IF NOT EXISTS assistant_subsession_by_parent
        ON assistant_subsession (agentId, parentSessionId, createdAt);
`

/** What the index needs from the store; a capped open that claims something else at once needs its transaction. */
export interface AssistantSubsessionDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction?<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

/** Thrown inside the claim's transaction to roll its index row back. */
class ClaimRefused extends Error {}

type Row = Record<string, unknown>

type OpenInput = Omit<AssistantSubsession, 'state' | 'createdAt' | 'kind'> & { now?: number }

function subsessionOf(row: Row): AssistantSubsession {
  return {
    agentId: String(row.agentId),
    childSessionKey: String(row.childSessionKey),
    parentSessionId: String(row.parentSessionId),
    parentSessionKey: String(row.parentSessionKey),
    state: String(row.state) as AssistantSubsessionState,
    createdAt: Number(row.createdAt),
    ...(row.kind === 'patrol' ? { kind: 'patrol' as const } : {})
  }
}

export class AssistantSubsessionIndex {
  // An agent delegates only on its duty holder, so serializing this process's capped opens makes each a check-and-claim.
  private readonly opening = new AsyncMutex()

  constructor(private readonly db: AssistantSubsessionDatabase) {}

  /** Record a delegation; true when the row is new, false when the child was already indexed. */
  async open(input: OpenInput): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_subsession
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [input.agentId, input.childSessionKey, input.parentSessionId, input.parentSessionKey, input.now ?? Date.now()]
    )
    return changes > 0
  }

  /** Record a delegation only below `limit` running ones; an `open` row whose session never appeared stops counting at `startedSince`. */
  async openWithinLimit(input: OpenInput, cap: { limit: number; startedSince: number }): Promise<boolean> {
    return await this.opening.run(async () => await this.insertWithinLimit(this.db, input, cap))
  }

  /** {@link openWithinLimit} and `claim` in one transaction: both happen or neither does. */
  async openWithinLimitClaiming(
    input: OpenInput,
    cap: { limit: number; startedSince: number },
    claim: (tx: StoreTx) => Promise<boolean>
  ): Promise<'opened' | 'limit' | 'refused'> {
    const db = this.db
    if (!db.transaction) throw new Error('the sub-session index has no transaction to claim in')
    return await this.opening.run(async () => {
      try {
        return await db.transaction!<'opened' | 'limit'>(async (tx) => {
          if (!(await this.insertWithinLimit(tx, input, cap))) return 'limit'
          if (!(await claim(tx))) throw new ClaimRefused()
          return 'opened'
        })
      } catch (err) {
        if (err instanceof ClaimRefused) return 'refused'
        throw err
      }
    })
  }

  private async insertWithinLimit(
    db: Pick<AssistantSubsessionDatabase, 'query'>,
    input: OpenInput,
    cap: { limit: number; startedSince: number }
  ): Promise<boolean> {
    const { changes } = await db.query(
      `INSERT OR IGNORE INTO assistant_subsession
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
       SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), 'open', CAST(? AS INTEGER)
        WHERE (SELECT COUNT(*) FROM assistant_subsession a
                WHERE a.agentId = ? AND a.state = 'open' AND a.kind = 'delegation'
                  AND (a.createdAt >= ? OR EXISTS (SELECT 1 FROM sessions s WHERE s.key = a.childSessionKey))) < ?`,
      [
        input.agentId,
        input.childSessionKey,
        input.parentSessionId,
        input.parentSessionKey,
        input.now ?? Date.now(),
        input.agentId,
        cap.startedSince,
        cap.limit
      ]
    )
    return changes > 0
  }

  /** Record a patrol only while none of the agent's is running; a patrol older than `staleBefore` no longer counts. */
  async openPatrol(input: OpenInput, cap: { startedSince: number; staleBefore: number }): Promise<boolean> {
    return await this.opening.run(async () => {
      const { changes } = await this.db.query(
        `INSERT OR IGNORE INTO assistant_subsession
           (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, kind)
         SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), 'open', CAST(? AS INTEGER), 'patrol'
          WHERE NOT EXISTS (SELECT 1 FROM assistant_subsession a
                  WHERE a.agentId = ? AND a.state = 'open' AND a.kind = 'patrol' AND a.createdAt >= ?
                    AND (a.createdAt >= ? OR EXISTS (SELECT 1 FROM sessions s WHERE s.key = a.childSessionKey)))`,
        [
          input.agentId,
          input.childSessionKey,
          input.parentSessionId,
          input.parentSessionKey,
          input.now ?? Date.now(),
          input.agentId,
          cap.staleBefore,
          cap.startedSince
        ]
      )
      return changes > 0
    })
  }

  /** How many patrols the agent started since `since`, for its daily budget. */
  async countPatrolsSince(agentId: string, since: number): Promise<number> {
    const row = (
      await this.db.query(
        `SELECT COUNT(*) AS n FROM assistant_subsession WHERE agentId = ? AND kind = 'patrol' AND createdAt >= ?`,
        [agentId, since]
      )
    ).rows[0] as Row | undefined
    return Number(row?.n ?? 0)
  }

  /** Settle an `open` row; false when it was already settled or is not indexed. */
  async finish(
    agentId: string,
    childSessionKey: string,
    state: Exclude<AssistantSubsessionState, 'open'>
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = ? WHERE agentId = ? AND childSessionKey = ? AND state = 'open'`,
      [state, agentId, childSessionKey]
    )
    return changes > 0
  }

  async get(agentId: string, childSessionKey: string): Promise<AssistantSubsession | undefined> {
    const row = (
      await this.db.query('SELECT * FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ?', [
        agentId,
        childSessionKey
      ])
    ).rows[0] as Row | undefined
    return row ? subsessionOf(row) : undefined
  }

  /** The agent's sub-sessions: open ones first, then the newest. */
  async list(agentId: string, limit: number): Promise<AssistantSubsession[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE agentId = ?
         ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, createdAt DESC, childSessionKey LIMIT ?`,
        [agentId, limit]
      )
    ).rows as Row[]
    return rows.map(subsessionOf)
  }

  /** The sub-sessions one conversation opened, newest first, from just past `after` when it names a row. */
  async listForParent(
    agentId: string,
    parentSessionId: string,
    page: { limit: number; after?: { createdAt: number; childSessionKey: string } }
  ): Promise<AssistantSubsession[]> {
    const after = page.after
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE agentId = ? AND parentSessionId = ?${
          after ? ' AND (createdAt < ? OR (createdAt = ? AND childSessionKey > ?))' : ''
        } ORDER BY createdAt DESC, childSessionKey LIMIT ?`,
        [
          agentId,
          parentSessionId,
          ...(after ? [after.createdAt, after.createdAt, after.childSessionKey] : []),
          page.limit
        ]
      )
    ).rows as Row[]
    return rows.map(subsessionOf)
  }

  async deleteForAgent(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_subsession WHERE agentId = ?', [agentId])).changes
  }
}
