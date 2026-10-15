// The persistent parent–child index of assistant-mode sub-sessions (assistant-mode.md §5.6), partitioned by agent.
import { SUBSESSION_COORDINATE_PREFIX } from '../session/subsession-coordinate.js'
import { AsyncMutex } from './async-mutex.js'
import type { StoreQueryResult, StoreTx } from './store-database.js'

/** `open` while a work round runs and holds a slot; `reporting` while the daemon's round-end report awaits admission; then `done` or `failed` until another round opens. */
export type AssistantSubsessionState = 'open' | 'reporting' | 'done' | 'failed'

export interface AssistantSubsession {
  agentId: string
  /** The child's logical session key, the `taskId` `startTask` handed back. */
  childSessionKey: string
  /** The parent session's outward id, the lineage id the child's own row carries. */
  parentSessionId: string
  /** The parent session's logical key, for the main conversation's own lookups. */
  parentSessionKey: string
  state: AssistantSubsessionState
  createdAt: number
  /** A patrol the daemon started (assistant-mode.md §5.9); a delegation reads back without it. */
  kind?: 'patrol'
  /** The failure report the daemon owes the parent (assistant-mode.md §5.7), once it claimed one. */
  endReport?: string
  /** How many times that report's admission was refused. */
  reportAttempts?: number
  /** The current work round (send-message-guide.md §8.4); read back only past the first. */
  round?: number
}

/** One parent message admitted into a sub-session, by its submission id, with the receipt a replay of it gets. */
export interface AssistantSubsessionInput {
  agentId: string
  submissionId: string
  childSessionKey: string
  round: number
  receipt?: string
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
        endReport TEXT,
        reportAttempts INTEGER NOT NULL DEFAULT 0,
        round INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (agentId, childSessionKey)
      );
      CREATE INDEX IF NOT EXISTS assistant_subsession_by_parent
        ON assistant_subsession (agentId, parentSessionId, createdAt);
      CREATE TABLE IF NOT EXISTS assistant_subsession_input (
        agentId TEXT NOT NULL,
        submissionId TEXT NOT NULL,
        childSessionKey TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        receipt TEXT,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, submissionId)
      );
      CREATE INDEX IF NOT EXISTS assistant_subsession_input_by_child
        ON assistant_subsession_input (agentId, childSessionKey);
`

/** What the index needs from the store; a capped open that claims something else at once needs its transaction. */
export interface AssistantSubsessionDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction?<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

/** Thrown inside the claim's transaction to roll its index row back. */
class ClaimRefused extends Error {}

type Row = Record<string, unknown>

// A listing's filter that leaves patrols out (assistant-mode.md §5.9).
const DELEGATIONS = " AND kind = 'delegation'"

type OpenInput = Omit<
  AssistantSubsession,
  'state' | 'createdAt' | 'kind' | 'endReport' | 'reportAttempts' | 'round'
> & {
  now?: number
}

function subsessionOf(row: Row): AssistantSubsession {
  return {
    agentId: String(row.agentId),
    childSessionKey: String(row.childSessionKey),
    parentSessionId: String(row.parentSessionId),
    parentSessionKey: String(row.parentSessionKey),
    state: String(row.state) as AssistantSubsessionState,
    createdAt: Number(row.createdAt),
    ...(row.kind === 'patrol' ? { kind: 'patrol' as const } : {}),
    ...(row.endReport != null ? { endReport: String(row.endReport) } : {}),
    ...(Number(row.reportAttempts ?? 0) > 0 ? { reportAttempts: Number(row.reportAttempts) } : {}),
    ...(Number(row.round ?? 1) > 1 ? { round: Number(row.round) } : {})
  }
}

// A guard on one round, when the caller names it.
const inRound = (round: number | undefined) => (round === undefined ? '' : ' AND round = ?')
const roundParam = (round: number | undefined) => (round === undefined ? [] : [round])

// The agent's running delegations, the count a capped open or a reopened round is checked against.
const RUNNING_DELEGATIONS = `(SELECT COUNT(*) FROM assistant_subsession a
                WHERE a.agentId = ? AND a.state = 'open' AND a.kind = 'delegation'
                  AND (a.createdAt >= ? OR EXISTS (SELECT 1 FROM sessions s WHERE s.key = a.childSessionKey)))`

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
        WHERE ${RUNNING_DELEGATIONS} < ?`,
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

  /** Open the next work round of a settled delegation in `round` only below `limit` running ones (send-message-guide.md §8.4). */
  async reopenWithinLimit(
    agentId: string,
    childSessionKey: string,
    round: number,
    cap: { limit: number; startedSince: number }
  ): Promise<'opened' | 'limit' | 'changed'> {
    return await this.opening.run(async () => {
      const { changes } = await this.db.query(
        `UPDATE assistant_subsession SET state = 'open', round = round + 1, endReport = NULL, reportAttempts = 0
          WHERE agentId = ? AND childSessionKey = ? AND round = ? AND state IN ('done', 'failed')
            AND ${RUNNING_DELEGATIONS} < ?`,
        [agentId, childSessionKey, round, agentId, cap.startedSince, cap.limit]
      )
      if (changes > 0) return 'opened'
      const row = await this.get(agentId, childSessionKey)
      return row && (row.round ?? 1) === round && (row.state === 'done' || row.state === 'failed') ? 'limit' : 'changed'
    })
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

  /** Settle an `open` row `failed` (`cut`) or read how it already ended, and run `claim` with that in one transaction; a refused claim changes nothing. */
  async finishClaiming(
    agentId: string,
    childSessionKey: string,
    claim: (tx: StoreTx, ended: 'cut' | 'done' | 'failed' | 'missing') => Promise<boolean>
  ): Promise<'cut' | 'done' | 'failed' | 'missing' | undefined> {
    const db = this.db
    if (!db.transaction) throw new Error('the sub-session index has no transaction to claim in')
    try {
      return await db.transaction!<'cut' | 'done' | 'failed' | 'missing'>(async (tx) => {
        const { changes } = await tx.query(
          `UPDATE assistant_subsession SET state = 'failed' WHERE agentId = ? AND childSessionKey = ? AND state = 'open'`,
          [agentId, childSessionKey]
        )
        const row =
          changes > 0
            ? undefined
            : ((
                await tx.query('SELECT state FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ?', [
                  agentId,
                  childSessionKey
                ])
              ).rows[0] as Row | undefined)
        const ended = changes > 0 ? 'cut' : row === undefined ? 'missing' : row.state === 'done' ? 'done' : 'failed'
        if (!(await claim(tx, ended))) throw new ClaimRefused()
        return ended
      })
    } catch (err) {
      if (err instanceof ClaimRefused) return undefined
      throw err
    }
  }

  /** Settle an `open` row, in `round` when named; false when it was already settled or is not indexed. */
  async finish(
    agentId: string,
    childSessionKey: string,
    state: Exclude<AssistantSubsessionState, 'open' | 'reporting'>,
    round?: number
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = ? WHERE agentId = ? AND childSessionKey = ? AND state = 'open'${inRound(round)}`,
      [state, agentId, childSessionKey, ...roundParam(round)]
    )
    return changes > 0
  }

  /** Move an `open` row, in `round` when named, to `reporting` with the report it owes; false when it was already settled. */
  async claimReport(agentId: string, childSessionKey: string, report: string, round?: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = 'reporting', endReport = ?, reportAttempts = 0
        WHERE agentId = ? AND childSessionKey = ? AND state = 'open'${inRound(round)}`,
      [report, agentId, childSessionKey, ...roundParam(round)]
    )
    return changes > 0
  }

  /** Count one refused attempt of a `reporting` row's report: the new count, or undefined when it is not reporting. */
  async countReportAttempt(agentId: string, childSessionKey: string): Promise<number | undefined> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET reportAttempts = reportAttempts + 1
        WHERE agentId = ? AND childSessionKey = ? AND state = 'reporting'`,
      [agentId, childSessionKey]
    )
    return changes > 0 ? ((await this.get(agentId, childSessionKey))?.reportAttempts ?? 0) : undefined
  }

  /** Settle a `reporting` row, `failed` unless its admitted report was a completion; false when it was not reporting. */
  async settleReport(
    agentId: string,
    childSessionKey: string,
    state: Exclude<AssistantSubsessionState, 'open' | 'reporting'> = 'failed'
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = ? WHERE agentId = ? AND childSessionKey = ? AND state = 'reporting'`,
      [state, agentId, childSessionKey]
    )
    return changes > 0
  }

  /** Claim one submission of a parent message; false when the same submission was claimed before. */
  async claimInput(agentId: string, submissionId: string, childSessionKey: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_subsession_input (agentId, submissionId, childSessionKey, createdAt)
       VALUES (?, ?, ?, ?)`,
      [agentId, submissionId, childSessionKey, now]
    )
    return changes > 0
  }

  /** Record a claimed submission's round and the receipt a replay of it gets. */
  async settleInput(agentId: string, submissionId: string, round: number, receipt: string): Promise<void> {
    await this.db.query(
      'UPDATE assistant_subsession_input SET round = ?, receipt = ? WHERE agentId = ? AND submissionId = ?',
      [round, receipt, agentId, submissionId]
    )
  }

  async getInput(agentId: string, submissionId: string): Promise<AssistantSubsessionInput | undefined> {
    const row = (
      await this.db.query('SELECT * FROM assistant_subsession_input WHERE agentId = ? AND submissionId = ?', [
        agentId,
        submissionId
      ])
    ).rows[0] as Row | undefined
    if (!row) return undefined
    return {
      agentId: String(row.agentId),
      submissionId: String(row.submissionId),
      childSessionKey: String(row.childSessionKey),
      round: Number(row.round ?? 0),
      ...(row.receipt != null ? { receipt: String(row.receipt) } : {})
    }
  }

  /** The agent's `open` delegations with no delivery of theirs left in the inbox, oldest first. */
  async listOpenWithoutInbox(agentId: string): Promise<AssistantSubsession[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession a WHERE a.agentId = ? AND a.state = 'open' AND a.kind = 'delegation'
            AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.sessionKey = a.childSessionKey AND i.completedAt IS NULL)
          ORDER BY a.createdAt, a.childSessionKey`,
        [agentId]
      )
    ).rows as Row[]
    return rows.map(subsessionOf)
  }

  /** The agent's rows whose failure report still awaits admission, oldest first. */
  async listReporting(agentId: string): Promise<AssistantSubsession[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE agentId = ? AND state = 'reporting' ORDER BY createdAt, childSessionKey`,
        [agentId]
      )
    ).rows as Row[]
    return rows.map(subsessionOf)
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

  /** The agent's sub-sessions: open ones first, then the newest; `delegationsOnly` leaves patrols out. */
  async list(agentId: string, limit: number, opts: { delegationsOnly?: boolean } = {}): Promise<AssistantSubsession[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE agentId = ?${opts.delegationsOnly ? DELEGATIONS : ''}
         ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, createdAt DESC, childSessionKey LIMIT ?`,
        [agentId, limit]
      )
    ).rows as Row[]
    return rows.map(subsessionOf)
  }

  /** The sub-sessions one conversation opened, newest first, from just past `after` when it names a row; `delegationsOnly` leaves patrols out. */
  async listForParent(
    agentId: string,
    parentSessionId: string,
    page: { limit: number; after?: { createdAt: number; childSessionKey: string }; delegationsOnly?: boolean }
  ): Promise<AssistantSubsession[]> {
    const after = page.after
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE agentId = ? AND parentSessionId = ?${
          page.delegationsOnly ? DELEGATIONS : ''
        }${after ? ' AND (createdAt < ? OR (createdAt = ? AND childSessionKey > ?))' : ''} ORDER BY createdAt DESC, childSessionKey LIMIT ?`,
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

  /** One owning session's still `open` tasks, never its patrols or approved proposals, newest first, at most `limit`, with how many there are in all. */
  async listOpenForParent(
    agentId: string,
    parent: { sessionId: string; key: string },
    limit: number
  ): Promise<{ rows: AssistantSubsession[]; total: number }> {
    const where =
      `WHERE agentId = ? AND parentSessionId = ? AND parentSessionKey = ? AND state = 'open'` +
      `${DELEGATIONS} AND childSessionKey NOT LIKE ?`
    const params = [agentId, parent.sessionId, parent.key, `%:${SUBSESSION_COORDINATE_PREFIX}task-%`]
    const count = (await this.db.query(`SELECT COUNT(*) AS n FROM assistant_subsession ${where}`, params)).rows[0] as
      Row | undefined
    const total = Number(count?.n ?? 0)
    if (total === 0) return { rows: [], total }
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession ${where} ORDER BY createdAt DESC, childSessionKey LIMIT ?`,
        [...params, limit]
      )
    ).rows as Row[]
    return { rows: rows.map(subsessionOf), total }
  }

  async deleteForAgent(agentId: string): Promise<number> {
    await this.db.query('DELETE FROM assistant_subsession_input WHERE agentId = ?', [agentId])
    return (await this.db.query('DELETE FROM assistant_subsession WHERE agentId = ?', [agentId])).changes
  }
}
