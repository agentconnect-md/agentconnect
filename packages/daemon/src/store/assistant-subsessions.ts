// The persistent parent–child index of assistant-mode sub-sessions (assistant-mode.md §5.6), partitioned by agent.
import { AsyncMutex } from './async-mutex.js'
import type { StoreQueryResult } from './store-database.js'

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
}

export const ASSISTANT_SUBSESSION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_subsession (
        agentId TEXT NOT NULL,
        childSessionKey TEXT NOT NULL,
        parentSessionId TEXT NOT NULL,
        parentSessionKey TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, childSessionKey)
      );
      CREATE INDEX IF NOT EXISTS assistant_subsession_by_parent
        ON assistant_subsession (agentId, parentSessionId, createdAt);
`

/** What the index needs from the store. */
export interface AssistantSubsessionDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

type OpenInput = Omit<AssistantSubsession, 'state' | 'createdAt'> & { now?: number }

function subsessionOf(row: Row): AssistantSubsession {
  return {
    agentId: String(row.agentId),
    childSessionKey: String(row.childSessionKey),
    parentSessionId: String(row.parentSessionId),
    parentSessionKey: String(row.parentSessionKey),
    state: String(row.state) as AssistantSubsessionState,
    createdAt: Number(row.createdAt)
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
    return await this.opening.run(async () => {
      const { changes } = await this.db.query(
        `INSERT OR IGNORE INTO assistant_subsession
           (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), 'open', CAST(? AS INTEGER)
          WHERE (SELECT COUNT(*) FROM assistant_subsession a
                  WHERE a.agentId = ? AND a.state = 'open'
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
    })
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

  async deleteForAgent(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_subsession WHERE agentId = ?', [agentId])).changes
  }
}
