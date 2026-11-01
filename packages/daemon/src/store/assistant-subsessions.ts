// The persistent parent–child index of assistant-mode sub-sessions (assistant-mode.md §5.6), partitioned by agent.
import { APPEND_COORDINATE_PREFIX } from '../session/append-coordinate.js'
import {
  APPROVED_TASK_COORDINATE_PREFIX,
  CHECK_COORDINATE_PREFIX,
  RESEARCH_COORDINATE_PREFIX
} from '@agentconnect.md/protocol'
import { RESEARCH_SESSION_KEY_PATTERN, SUBSESSION_COORDINATE_PREFIX } from '../session/subsession-coordinate.js'
import { AsyncMutex } from './async-mutex.js'
import type { StoreQueryResult, StoreTx } from './store-database.js'

/** `open` while a work round runs and holds a slot; `reporting` while the daemon's round-end report awaits admission; then `done` or `failed` until another round opens. */
export type AssistantSubsessionState = 'open' | 'reporting' | 'done' | 'failed'

export interface AssistantSubsession {
  agentId: string
  /** The child's logical session key, the `taskId` `delegateTask` handed back. */
  childSessionKey: string
  /** The parent session's outward id, the lineage id the child's own row carries. */
  parentSessionId: string
  /** The parent session's logical key, for the main conversation's own lookups. */
  parentSessionKey: string
  state: AssistantSubsessionState
  createdAt: number
  /** A follow-up (assistant-mode.md §5.12), `open` while one of its checks runs; a delegation reads back without it. */
  kind?: 'follow-up'
  /** The failure report the daemon owes the parent (assistant-mode.md §5.7), once it claimed one. */
  endReport?: string
  /** How many times that report's admission was refused. */
  reportAttempts?: number
  /** The current work round (send-message-guide.md §8.4); read back only past the first. */
  round?: number
  /** The platform thread of the turn that last asked it for work, where its round's report replies. */
  replyThread?: string
  /** Its name in the console and in `listTasks` (auto-session-mode.md §5.1). */
  title?: string
  /** The start of the message it was opened with, which `listTasks` shows until it writes a summary (§6.7). */
  background?: string
  /** The task's own account of its scope, status and next step (auto-session-mode.md §6.7). */
  summary?: string
  summaryUpdatedAt?: number
  /** Turns it ran since it last wrote its summary; read back only when nonzero. */
  turnsSinceSummary?: number
  /** When a round last started or settled or its title changed, the work board's order (assistant-mode.md §5.18). */
  changedAt?: number
}

/** An indexed row with what the work board reads beside it (assistant-mode.md §5.18 ②). */
export interface PlacedSubsession extends AssistantSubsession {
  /** The conversation of the session that owns it; undefined once that session's row is gone. */
  owner?: { platform: string; channel: string; transportScope?: string; conversationKind?: string }
  /** Its own session's outward id and title, once it has a session. */
  sessionId?: string
  sessionTitle?: string
  /** The outward ids of the sessions on the platform threads it holds, its own excepted. */
  threadSessions: string[]
}

/** One platform thread attached to a task (auto-session-mode.md §6.1): people there talk to the task directly. */
export interface AssistantSubsessionThread {
  agentId: string
  childSessionKey: string
  platform: string
  channel: string
  transportScope?: string
  thread: string
  /** The first work round that no longer reports to the parent (§6.2). */
  sinceRound: number
  attachedAt: number
}

/** One parent message admitted into a sub-session, by its submission id, with the receipt a replay of it gets. */
export interface AssistantSubsessionInput {
  agentId: string
  submissionId: string
  childSessionKey: string
  round: number
  receipt?: string
}

// The platform threads attached to tasks (auto-session-mode.md §6.1): a thread belongs to one task at most.
export const ASSISTANT_SUBSESSION_THREAD_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_subsession_thread (
        agentId TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        transportScope TEXT NOT NULL DEFAULT '',
        thread TEXT NOT NULL,
        childSessionKey TEXT NOT NULL,
        sinceRound INTEGER NOT NULL DEFAULT 1,
        attachedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, platform, channel, transportScope, thread)
      );
      CREATE INDEX IF NOT EXISTS assistant_subsession_thread_by_child
        ON assistant_subsession_thread (agentId, childSessionKey);
`

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
        replyThread TEXT,
        title TEXT,
        background TEXT,
        summary TEXT,
        summaryUpdatedAt INTEGER,
        turnsSinceSummary INTEGER NOT NULL DEFAULT 0,
        changedAt INTEGER,
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
      ${ASSISTANT_SUBSESSION_THREAD_SCHEMA}
`

/** What the index needs from the store; a capped open that claims something else at once needs its transaction. */
export interface AssistantSubsessionDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction?<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

/** Thrown inside the claim's transaction to roll its index row back. */
class ClaimRefused extends Error {}

type Row = Record<string, unknown>

// A listing's filter that leaves follow-ups out (assistant-mode.md §5.12).
const DELEGATIONS = " AND kind = 'delegation'"

// A row a delegation opened, as isDelegatedTaskKey reads its key: a background coordinate other than a check's, an approved proposal's or research's.
const NOT_DELEGATED_TASKS =
  " AND NOT (kind = 'delegation' AND childSessionKey LIKE ? AND childSessionKey NOT LIKE ? AND childSessionKey NOT LIKE ?" +
  ' AND childSessionKey NOT LIKE ?)'
const NOT_DELEGATED_TASK_PARAMS = [
  `%:${SUBSESSION_COORDINATE_PREFIX}%`,
  `%:${CHECK_COORDINATE_PREFIX}%`,
  `%:${APPROVED_TASK_COORDINATE_PREFIX}%`,
  `%:${RESEARCH_COORDINATE_PREFIX}%`
]

type OpenInput = Omit<
  AssistantSubsession,
  | 'state'
  | 'createdAt'
  | 'kind'
  | 'endReport'
  | 'reportAttempts'
  | 'round'
  | 'summary'
  | 'summaryUpdatedAt'
  | 'turnsSinceSummary'
  | 'changedAt'
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
    ...(row.kind === 'follow-up' ? { kind: 'follow-up' as const } : {}),
    ...(row.endReport != null ? { endReport: String(row.endReport) } : {}),
    ...(Number(row.reportAttempts ?? 0) > 0 ? { reportAttempts: Number(row.reportAttempts) } : {}),
    ...(Number(row.round ?? 1) > 1 ? { round: Number(row.round) } : {}),
    ...(row.replyThread != null ? { replyThread: String(row.replyThread) } : {}),
    ...(row.title != null ? { title: String(row.title) } : {}),
    ...(row.background != null ? { background: String(row.background) } : {}),
    ...(row.summary != null ? { summary: String(row.summary) } : {}),
    ...(row.summaryUpdatedAt != null ? { summaryUpdatedAt: Number(row.summaryUpdatedAt) } : {}),
    ...(Number(row.turnsSinceSummary ?? 0) > 0 ? { turnsSinceSummary: Number(row.turnsSinceSummary) } : {}),
    changedAt: Number(row.changedAt ?? row.createdAt)
  }
}

function threadOf(row: Row): AssistantSubsessionThread {
  return {
    agentId: String(row.agentId),
    childSessionKey: String(row.childSessionKey),
    platform: String(row.platform),
    channel: String(row.channel),
    ...(row.transportScope != null && row.transportScope !== '' ? { transportScope: String(row.transportScope) } : {}),
    thread: String(row.thread),
    sinceRound: Number(row.sinceRound ?? 1),
    attachedAt: Number(row.attachedAt)
  }
}

/** A task's summary is at most this long (auto-session-mode.md §6.7). */
export const TASK_SUMMARY_MAX_CHARS = 500

// The opening message's start, cut to a summary's length, since it stands in for one until the task writes its own.
const backgroundOf = (text: string | undefined): string | null => {
  const chars = [...(text ?? '').trim()]
  if (chars.length === 0) return null
  return chars.length > TASK_SUMMARY_MAX_CHARS
    ? `${chars.slice(0, TASK_SUMMARY_MAX_CHARS - 1).join('')}…`
    : chars.join('')
}

// A guard on one round, when the caller names it.
const inRound = (round: number | undefined) => (round === undefined ? '' : ' AND round = ?')
const roundParam = (round: number | undefined) => (round === undefined ? [] : [round])

// Whether a task row has a thread attached, which keeps it out of the cap and its reports (auto-session-mode.md §6.2).
const THREADED = (alias: string) =>
  `EXISTS (SELECT 1 FROM assistant_subsession_thread t WHERE t.agentId = ${alias}.agentId AND t.childSessionKey = ${alias}.childSessionKey)`

// When a task last did anything: its session's last change, else its opening (auto-session-mode.md §5.2).
const LAST_ACTIVE = (alias: string) =>
  `COALESCE((SELECT s.updatedAt FROM sessions s WHERE s.key = ${alias}.childSessionKey), ${alias}.createdAt)`

// The agent's running background delegations, the count a capped open or a reopened round is checked against.
const RUNNING_DELEGATIONS = `(SELECT COUNT(*) FROM assistant_subsession a
                WHERE a.agentId = ? AND a.state = 'open' AND a.kind = 'delegation' AND NOT ${THREADED('a')}
                  AND (a.createdAt >= ? OR EXISTS (SELECT 1 FROM sessions s WHERE s.key = a.childSessionKey)))`

export class AssistantSubsessionIndex {
  // An agent delegates only on its duty holder, so serializing this process's capped opens makes each a check-and-claim.
  private readonly opening = new AsyncMutex()

  constructor(private readonly db: AssistantSubsessionDatabase) {}

  /** Record a delegation; true when the row is new, false when the child was already indexed. */
  async open(input: OpenInput): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_subsession
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, replyThread, title, background,
          changedAt)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [
        input.agentId,
        input.childSessionKey,
        input.parentSessionId,
        input.parentSessionKey,
        input.now ?? Date.now(),
        input.replyThread ?? null,
        input.title ?? null,
        backgroundOf(input.background),
        input.now ?? Date.now()
      ]
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
    if (!db.transaction) throw new Error('the task index has no transaction to claim in')
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
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, replyThread, title, background,
          changedAt)
       SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), 'open', CAST(? AS INTEGER), CAST(? AS TEXT),
              CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS INTEGER)
        WHERE ${RUNNING_DELEGATIONS} < ?`,
      [
        input.agentId,
        input.childSessionKey,
        input.parentSessionId,
        input.parentSessionKey,
        input.now ?? Date.now(),
        input.replyThread ?? null,
        input.title ?? null,
        backgroundOf(input.background),
        input.now ?? Date.now(),
        input.agentId,
        cap.startedSince,
        cap.limit
      ]
    )
    return changes > 0
  }

  /** Open the next work round of a settled delegation in `round`, below `limit` running ones unless a thread is attached (send-message-guide.md §8.4). */
  async reopenWithinLimit(
    agentId: string,
    childSessionKey: string,
    round: number,
    cap: { limit: number; startedSince: number },
    now = Date.now()
  ): Promise<'opened' | 'limit' | 'changed'> {
    return await this.opening.run(async () => {
      const { changes } = await this.db.query(
        `UPDATE assistant_subsession SET state = 'open', round = round + 1, endReport = NULL, reportAttempts = 0,
            changedAt = ?
          WHERE agentId = ? AND childSessionKey = ? AND round = ? AND state IN ('done', 'failed')
            AND (${THREADED('assistant_subsession')} OR ${RUNNING_DELEGATIONS} < ?)`,
        [now, agentId, childSessionKey, round, agentId, cap.startedSince, cap.limit]
      )
      if (changes > 0) return 'opened'
      const row = await this.get(agentId, childSessionKey)
      return row && (row.round ?? 1) === round && (row.state === 'done' || row.state === 'failed') ? 'limit' : 'changed'
    })
  }

  /** Record the thread of the turn that asked for this round's work; null when no turn's thread is known. */
  async setReplyThread(agentId: string, childSessionKey: string, replyThread: string | null): Promise<void> {
    await this.db.query(
      `UPDATE assistant_subsession SET replyThread = ? WHERE agentId = ? AND childSessionKey = ? AND kind = 'delegation'`,
      [replyThread, agentId, childSessionKey]
    )
  }

  /** Index a follow-up under the session that owns it, idle until its first check; false when it was already indexed. */
  async openFollowUp(input: OpenInput): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_subsession
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, kind, changedAt)
       VALUES (?, ?, ?, ?, 'done', ?, 'follow-up', ?)`,
      [
        input.agentId,
        input.childSessionKey,
        input.parentSessionId,
        input.parentSessionKey,
        input.now ?? Date.now(),
        input.now ?? Date.now()
      ]
    )
    return changes > 0
  }

  /** A follow-up's check runs: its row is `open` until the check settles. */
  async checking(agentId: string, childSessionKey: string, now = Date.now()): Promise<void> {
    await this.db.query(
      `UPDATE assistant_subsession SET state = 'open', changedAt = CASE WHEN state = 'open' THEN changedAt ELSE ? END
        WHERE agentId = ? AND childSessionKey = ? AND kind = 'follow-up'`,
      [now, agentId, childSessionKey]
    )
  }

  /** A place's follow-ups belong to its current long session (assistant-mode.md §5.12): their rows name it as their owner. */
  async adoptFollowUps(
    agentId: string,
    place: { platform: string; channel: string; transportScope?: string | null },
    owner: { sessionId: string; key: string }
  ): Promise<void> {
    await this.db.query(
      `UPDATE assistant_subsession SET parentSessionId = ?, parentSessionKey = ?
        WHERE agentId = ? AND kind = 'follow-up' AND (parentSessionId <> ? OR parentSessionKey <> ?)
          AND childSessionKey IN (SELECT i.taskKey FROM assistant_item i WHERE i.agentId = ? AND i.originPlatform = ?
            AND i.originChannel = ? AND i.originTransportScope = ?)`,
      [
        owner.sessionId,
        owner.key,
        agentId,
        owner.sessionId,
        owner.key,
        agentId,
        place.platform,
        place.channel,
        place.transportScope ?? ''
      ]
    )
  }

  /** Settle an `open` row `failed` (`cut`) or read how it already ended, and run `claim` with that in one transaction; a refused claim changes nothing. */
  async finishClaiming(
    agentId: string,
    childSessionKey: string,
    claim: (tx: StoreTx, ended: 'cut' | 'done' | 'failed' | 'missing') => Promise<boolean>,
    now = Date.now()
  ): Promise<'cut' | 'done' | 'failed' | 'missing' | undefined> {
    const db = this.db
    if (!db.transaction) throw new Error('the task index has no transaction to claim in')
    try {
      return await db.transaction!<'cut' | 'done' | 'failed' | 'missing'>(async (tx) => {
        const { changes } = await tx.query(
          `UPDATE assistant_subsession SET state = 'failed', changedAt = ?
            WHERE agentId = ? AND childSessionKey = ? AND state = 'open'`,
          [now, agentId, childSessionKey]
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
    round?: number,
    now = Date.now()
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = ?, changedAt = ?
        WHERE agentId = ? AND childSessionKey = ? AND state = 'open'${inRound(round)}`,
      [state, now, agentId, childSessionKey, ...roundParam(round)]
    )
    return changes > 0
  }

  /** Move an `open` row, in `round` when named, to `reporting` with the report it owes; false when it was already settled. */
  async claimReport(
    agentId: string,
    childSessionKey: string,
    report: string,
    round?: number,
    now = Date.now()
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = 'reporting', endReport = ?, reportAttempts = 0, changedAt = ?
        WHERE agentId = ? AND childSessionKey = ? AND state = 'open'${inRound(round)}`,
      [report, now, agentId, childSessionKey, ...roundParam(round)]
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

  /** When the round of the agent's organization research that is running now began (assistant-mode.md §5.15); undefined when none runs. */
  async researchRunningSince(agentId: string): Promise<number | undefined> {
    const row = (
      await this.db.query(
        `SELECT childSessionKey, createdAt, round FROM assistant_subsession
          WHERE agentId = ? AND kind = 'delegation' AND state = 'open' AND childSessionKey LIKE ?
          ORDER BY createdAt DESC LIMIT 1`,
        [agentId, RESEARCH_SESSION_KEY_PATTERN]
      )
    ).rows[0] as Row | undefined
    if (!row) return undefined
    const round = Number(row.round ?? 1)
    if (round <= 1) return Number(row.createdAt)
    // A later round began with the message that opened it.
    const opened = (
      await this.db.query(
        'SELECT MIN(createdAt) AS at FROM assistant_subsession_input WHERE agentId = ? AND childSessionKey = ? AND round = ?',
        [agentId, String(row.childSessionKey), round]
      )
    ).rows[0] as Row | undefined
    return opened?.at !== null && opened?.at !== undefined ? Number(opened.at) : Number(row.createdAt)
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

  /** The agent's sub-sessions: open ones first, then the newest; `delegationsOnly` leaves follow-ups out. */
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

  /** The sub-sessions one conversation opened, newest first, from just past `after` when it names a row; `delegationsOnly` leaves follow-ups out. */
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

  /** One owning session's still `open` tasks, never its follow-ups or approved proposals, newest first, at most `limit`, with how many there are in all. */
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

  /** Every row one owning session's reports go to — its tasks, follow-ups and approved proposals — running first, then the most recently active, at most `limit`, with the total. */
  async listForOwner(
    agentId: string,
    parent: { sessionId: string; key: string },
    limit: number,
    opts: { followUps?: boolean; delegatedTasks?: boolean } = {}
  ): Promise<{ rows: AssistantSubsession[]; total: number }> {
    const where =
      'WHERE agentId = ? AND parentSessionId = ? AND parentSessionKey = ?' +
      (opts.followUps === false ? DELEGATIONS : '') +
      (opts.delegatedTasks === false ? NOT_DELEGATED_TASKS : '')
    const params = [
      agentId,
      parent.sessionId,
      parent.key,
      ...(opts.delegatedTasks === false ? NOT_DELEGATED_TASK_PARAMS : [])
    ]
    const count = (await this.db.query(`SELECT COUNT(*) AS n FROM assistant_subsession ${where}`, params)).rows[0] as
      Row | undefined
    const total = Number(count?.n ?? 0)
    if (total === 0) return { rows: [], total }
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession ${where}
          ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, ${LAST_ACTIVE('assistant_subsession')} DESC, childSessionKey
          LIMIT ?`,
        [...params, limit]
      )
    ).rows as Row[]
    return { rows: rows.map(subsessionOf), total }
  }

  /** Every row of the agent with its owner's conversation and its own sessions, as the work board reads them (assistant-mode.md §5.18 ②). */
  async listPlaced(agentId: string): Promise<PlacedSubsession[]> {
    const rows = (
      await this.db.query(
        `SELECT a.*, p.platform AS ownerPlatform, p.channel AS ownerChannel, p.transportScope AS ownerTransportScope,
                p.conversationKind AS ownerConversationKind, c.sessionId AS taskSessionId, c.title AS taskTitle
           FROM assistant_subsession a
           LEFT JOIN sessions p ON p.key = a.parentSessionKey
           LEFT JOIN sessions c ON c.key = a.childSessionKey
          WHERE a.agentId = ?
          ORDER BY a.childSessionKey`,
        [agentId]
      )
    ).rows as Row[]
    const held = (
      await this.db.query(
        `SELECT t.childSessionKey, s.sessionId FROM assistant_subsession_thread t
           JOIN sessions s ON s.agentId = t.agentId AND s.platform = t.platform AND s.channel = t.channel
            AND COALESCE(s.transportScope, '') = t.transportScope AND s.thread = t.thread
          WHERE t.agentId = ? AND s.sessionId IS NOT NULL AND s.key <> t.childSessionKey
          ORDER BY t.childSessionKey, s.sessionId`,
        [agentId]
      )
    ).rows as Row[]
    const threadSessions = new Map<string, string[]>()
    for (const row of held) {
      const key = String(row.childSessionKey)
      threadSessions.set(key, [...(threadSessions.get(key) ?? []), String(row.sessionId)])
    }
    return rows.map((row) => ({
      ...subsessionOf(row),
      ...(row.ownerPlatform != null && row.ownerChannel != null
        ? {
            owner: {
              platform: String(row.ownerPlatform),
              channel: String(row.ownerChannel),
              ...(row.ownerTransportScope ? { transportScope: String(row.ownerTransportScope) } : {}),
              ...(row.ownerConversationKind ? { conversationKind: String(row.ownerConversationKind) } : {})
            }
          }
        : {}),
      ...(row.taskSessionId ? { sessionId: String(row.taskSessionId) } : {}),
      ...(row.taskTitle != null ? { sessionTitle: String(row.taskTitle) } : {}),
      threadSessions: threadSessions.get(String(row.childSessionKey)) ?? []
    }))
  }

  /** Set a task's summary, and its title when given, and restart its turn count (auto-session-mode.md §6.7); false when it is not indexed. */
  async setSummary(
    agentId: string,
    childSessionKey: string,
    update: { summary: string; title?: string; now: number }
  ): Promise<boolean> {
    if ([...update.summary].length > TASK_SUMMARY_MAX_CHARS)
      throw new Error(`a task summary is at most ${TASK_SUMMARY_MAX_CHARS} characters`)
    // Only a new title moves the task on the work board; a summary alone changes no line.
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET summary = ?, summaryUpdatedAt = ?, turnsSinceSummary = 0, title = COALESCE(?, title),
          changedAt = CASE WHEN COALESCE(title, '') = COALESCE(?, title, '') THEN changedAt ELSE ? END
        WHERE agentId = ? AND childSessionKey = ? AND kind = 'delegation'`,
      [update.summary, update.now, update.title ?? null, update.title ?? null, update.now, agentId, childSessionKey]
    )
    return changes > 0
  }

  /** Count one turn of a task since its summary; the new count, or undefined when it is not indexed. */
  async countTurn(agentId: string, childSessionKey: string): Promise<number | undefined> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET turnsSinceSummary = turnsSinceSummary + 1
        WHERE agentId = ? AND childSessionKey = ? AND kind = 'delegation'`,
      [agentId, childSessionKey]
    )
    return changes > 0 ? ((await this.get(agentId, childSessionKey))?.turnsSinceSummary ?? 0) : undefined
  }

  /** Attach a platform thread to a task; rounds from `sinceRound` on no longer report to its parent. False when the thread is another task's or the task is not indexed. */
  async attachThread(input: Omit<AssistantSubsessionThread, 'attachedAt'> & { now: number }): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_subsession_thread
         (agentId, platform, channel, transportScope, thread, childSessionKey, sinceRound, attachedAt)
       SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT),
              CAST(? AS INTEGER), CAST(? AS INTEGER)
        WHERE EXISTS (SELECT 1 FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ? AND kind = 'delegation')`,
      [
        input.agentId,
        input.platform,
        input.channel,
        input.transportScope ?? '',
        input.thread,
        input.childSessionKey,
        input.sinceRound,
        input.now,
        input.agentId,
        input.childSessionKey
      ]
    )
    return changes > 0
  }

  /** The threads attached to one task, oldest first. */
  async threadsOf(agentId: string, childSessionKey: string): Promise<AssistantSubsessionThread[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession_thread WHERE agentId = ? AND childSessionKey = ? ORDER BY attachedAt, thread`,
        [agentId, childSessionKey]
      )
    ).rows as Row[]
    return rows.map(threadOf)
  }

  /** The task a platform thread is attached to, if any. */
  async taskOfThread(
    agentId: string,
    at: { platform: string; channel: string; transportScope?: string | null; thread: string }
  ): Promise<string | undefined> {
    const row = (
      await this.db.query(
        `SELECT childSessionKey FROM assistant_subsession_thread
          WHERE agentId = ? AND platform = ? AND channel = ? AND transportScope = ? AND thread = ?`,
        [agentId, at.platform, at.channel, at.transportScope ?? '', at.thread]
      )
    ).rows[0] as Row | undefined
    return row ? String(row.childSessionKey) : undefined
  }

  /** Release every thread of a task, which become unowned again (auto-session-mode.md §6.5). */
  async detachThreads(agentId: string, childSessionKey: string): Promise<number> {
    return (
      await this.db.query('DELETE FROM assistant_subsession_thread WHERE agentId = ? AND childSessionKey = ?', [
        agentId,
        childSessionKey
      ])
    ).changes
  }

  /** A threaded task's next turn starts: its settled row is `open` again in the next round, outside the cap (auto-session-mode.md §6.2); false when it is not one or already runs. */
  async resumeThreaded(agentId: string, childSessionKey: string, now = Date.now()): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET state = 'open', round = round + 1, endReport = NULL, reportAttempts = 0, changedAt = ?
        WHERE agentId = ? AND childSessionKey = ? AND kind = 'delegation' AND state IN ('done', 'failed')
          AND ${THREADED('assistant_subsession')}`,
      [now, agentId, childSessionKey]
    )
    return changes > 0
  }

  /** Close the agent's settled threaded tasks idle since before `idleBefore`: their rows go and their threads become unowned (auto-session-mode.md §6.5); the closed keys. */
  async closeIdleThreaded(agentId: string, idleBefore: number): Promise<string[]> {
    const idle = (
      await this.db.query(
        `SELECT a.childSessionKey FROM assistant_subsession a
          WHERE a.agentId = ? AND a.kind = 'delegation' AND a.state IN ('done', 'failed') AND ${THREADED('a')}
            AND ${LAST_ACTIVE('a')} < ?
          ORDER BY a.createdAt, a.childSessionKey`,
        [agentId, idleBefore]
      )
    ).rows as Row[]
    const closed: string[] = []
    for (const { childSessionKey } of idle) {
      const key = String(childSessionKey)
      // A turn that started meanwhile keeps the task.
      const { changes } = await this.db.query(
        `DELETE FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ? AND state IN ('done', 'failed')
            AND ${LAST_ACTIVE('assistant_subsession')} < ?`,
        [agentId, key, idleBefore]
      )
      if (changes === 0) continue
      await this.dropTaskInputsAndThreads(agentId, key)
      closed.push(key)
    }
    return closed
  }

  /** The conversations the agent's threaded tasks hold threads in. */
  async threadedConversations(
    agentId: string
  ): Promise<{ platform: string; channel: string; transportScope?: string }[]> {
    const rows = (
      await this.db.query(
        `SELECT DISTINCT platform, channel, transportScope FROM assistant_subsession_thread WHERE agentId = ?
          ORDER BY platform, channel, transportScope`,
        [agentId]
      )
    ).rows as Row[]
    return rows.map((row) => ({
      platform: String(row.platform),
      channel: String(row.channel),
      ...(row.transportScope ? { transportScope: String(row.transportScope) } : {})
    }))
  }

  /** The tasks holding a thread in one conversation, with the session each belongs to. */
  async threadedTasksIn(
    agentId: string,
    at: { platform: string; channel: string; transportScope?: string | null }
  ): Promise<{ childSessionKey: string; parentSessionKey: string }[]> {
    const rows = (
      await this.db.query(
        `SELECT DISTINCT a.childSessionKey, a.parentSessionKey FROM assistant_subsession a
           JOIN assistant_subsession_thread t ON t.agentId = a.agentId AND t.childSessionKey = a.childSessionKey
          WHERE a.agentId = ? AND t.platform = ? AND t.channel = ? AND t.transportScope = ? AND a.kind = 'delegation'
          ORDER BY a.childSessionKey`,
        [agentId, at.platform, at.channel, at.transportScope ?? '']
      )
    ).rows as Row[]
    return rows.map((row) => ({
      childSessionKey: String(row.childSessionKey),
      parentSessionKey: String(row.parentSessionKey)
    }))
  }

  /** Close one task: its row and threads go, and its threads become unowned (auto-session-mode.md §3.5, §6.8); false when it was not indexed. */
  async closeTask(agentId: string, childSessionKey: string): Promise<boolean> {
    const { changes } = await this.db.query(
      `DELETE FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ? ${DELEGATIONS}`,
      [agentId, childSessionKey]
    )
    if (changes === 0) return false
    await this.dropTaskInputsAndThreads(agentId, childSessionKey)
    return true
  }

  /** A conversation's thread sessions active since `activeSince` that no task holds, the ones a switch into `auto` adopts (auto-session-mode.md §3.5). */
  async unownedThreadSessions(
    agentId: string,
    at: { platform: string; channel: string; transportScope?: string | null },
    activeSince: number
  ): Promise<{ key: string; thread: string; title?: string; running: boolean }[]> {
    const rows = (
      await this.db.query(
        `SELECT s.key, s.thread, s.title, s.state FROM sessions s
          WHERE s.agentId = ? AND s.platform = ? AND s.channel = ? AND COALESCE(s.transportScope, '') = ?
            AND s.thread NOT LIKE ? AND s.thread NOT LIKE ? AND s.originSessionId IS NULL AND s.updatedAt >= ?
            AND NOT EXISTS (SELECT 1 FROM assistant_subsession a WHERE a.agentId = s.agentId AND a.childSessionKey = s.key)
            AND NOT EXISTS (SELECT 1 FROM assistant_subsession_thread t WHERE t.agentId = s.agentId
              AND t.platform = s.platform AND t.channel = s.channel AND t.transportScope = COALESCE(s.transportScope, '')
              AND t.thread = s.thread)
          ORDER BY s.updatedAt, s.key`,
        [
          agentId,
          at.platform,
          at.channel,
          at.transportScope ?? '',
          `${SUBSESSION_COORDINATE_PREFIX}%`,
          `${APPEND_COORDINATE_PREFIX}%`,
          activeSince
        ]
      )
    ).rows as Row[]
    return rows.map((row) => ({
      key: String(row.key),
      thread: String(row.thread),
      ...(row.title != null ? { title: String(row.title) } : {}),
      running: row.state === 'prompting' || row.state === 'cancelling'
    }))
  }

  /** Index an existing thread session as a threaded task holding its own thread, settled unless a turn of it runs; false when it is indexed already or the thread is another task's. */
  async adoptThreadSession(
    input: OpenInput & {
      platform: string
      channel: string
      transportScope?: string | null
      thread: string
      running: boolean
      now: number
    }
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_subsession
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, replyThread, title, changedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.agentId,
        input.childSessionKey,
        input.parentSessionId,
        input.parentSessionKey,
        input.running ? 'open' : 'done',
        input.now,
        input.thread,
        input.title ?? null,
        input.now
      ]
    )
    if (changes === 0) return false
    const attached = await this.attachThread({
      agentId: input.agentId,
      childSessionKey: input.childSessionKey,
      platform: input.platform,
      channel: input.channel,
      transportScope: input.transportScope ?? '',
      thread: input.thread,
      sinceRound: 1,
      now: input.now
    })
    if (attached) return true
    await this.db.query('DELETE FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ?', [
      input.agentId,
      input.childSessionKey
    ])
    return false
  }

  private async dropTaskInputsAndThreads(agentId: string, childSessionKey: string): Promise<void> {
    await this.db.query('DELETE FROM assistant_subsession_input WHERE agentId = ? AND childSessionKey = ?', [
      agentId,
      childSessionKey
    ])
    await this.detachThreads(agentId, childSessionKey)
  }

  /** Hand one parent's threaded tasks to another, as a coordinator's `!new` does (auto-session-mode.md §8); the moved keys. */
  async adoptThreaded(
    agentId: string,
    fromParentKey: string,
    owner: { sessionId: string; key: string }
  ): Promise<string[]> {
    const rows = (
      await this.db.query(
        `SELECT childSessionKey FROM assistant_subsession
          WHERE agentId = ? AND parentSessionKey = ? AND kind = 'delegation' AND ${THREADED('assistant_subsession')}
          ORDER BY childSessionKey`,
        [agentId, fromParentKey]
      )
    ).rows as Row[]
    const moved: string[] = []
    for (const { childSessionKey } of rows) {
      const key = String(childSessionKey)
      const { changes } = await this.db.query(
        `UPDATE assistant_subsession SET parentSessionId = ?, parentSessionKey = ?
          WHERE agentId = ? AND childSessionKey = ? AND parentSessionKey = ?`,
        [owner.sessionId, owner.key, agentId, key, fromParentKey]
      )
      if (changes > 0) moved.push(key)
    }
    return moved
  }

  /** Whether a task's `round` reports to its parent: a background task's always, a threaded one's only before its first thread (§6.2). */
  async reportsRound(agentId: string, childSessionKey: string, round: number): Promise<boolean> {
    const row = (
      await this.db.query(
        'SELECT MIN(sinceRound) AS quiet FROM assistant_subsession_thread WHERE agentId = ? AND childSessionKey = ?',
        [agentId, childSessionKey]
      )
    ).rows[0] as Row | undefined
    return row?.quiet === null || row?.quiet === undefined || round < Number(row.quiet)
  }

  /** Whether a session has a background task of its own still running or reporting, which keeps its own round open (auto-session-mode.md §6.3). */
  async hasRunningChildren(agentId: string, parentSessionKey: string): Promise<boolean> {
    const row = (
      await this.db.query(
        `SELECT 1 AS one FROM assistant_subsession a WHERE a.agentId = ? AND a.parentSessionKey = ?
            AND a.kind = 'delegation' AND a.state IN ('open', 'reporting') AND NOT ${THREADED('a')} LIMIT 1`,
        [agentId, parentSessionKey]
      )
    ).rows[0] as Row | undefined
    return row !== undefined
  }

  async deleteForAgent(agentId: string): Promise<number> {
    await this.db.query('DELETE FROM assistant_subsession_thread WHERE agentId = ?', [agentId])
    await this.db.query('DELETE FROM assistant_subsession_input WHERE agentId = ?', [agentId])
    return (await this.db.query('DELETE FROM assistant_subsession WHERE agentId = ?', [agentId])).changes
  }
}
