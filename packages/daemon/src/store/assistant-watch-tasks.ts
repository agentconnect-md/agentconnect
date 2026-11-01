// Follow-ups as watch tasks (assistant-mode.md §5.18): a task-store row in watch mode, one id, its task key, checked on its schedule, with its observations beside it.
import { ASSISTANT_ITEM_LIMITS, type AssistantPlace } from './assistant-items.js'
import { CLOSE_TASK } from './closed-tasks.js'
import type { StoreQueryResult, StoreTx } from './store-database.js'

/** A watch task's schedule: open with a next check (`active`) or without one (`waiting`), or ended. */
export const WATCH_TASK_STATUSES = ['active', 'waiting', 'done', 'dropped'] as const
export type WatchTaskStatus = (typeof WATCH_TASK_STATUSES)[number]

export const isWatchTaskStatus = (value: unknown): value is WatchTaskStatus =>
  WATCH_TASK_STATUSES.some((status) => status === value)

/** Whether the object a watch task waits on (§5.14) is taken, waits for the Control Plane to confirm it, was refused, or ended. */
export const WATCHED_OBJECT_STATES = ['pending', 'watching', 'refused', 'ended'] as const
export type WatchedObjectState = (typeof WATCHED_OBJECT_STATES)[number]

/** The one pull request, merge request or issue a watch task waits on: its URL, its label once taken, and why it is not watched. */
export interface WatchedObject {
  url: string
  /** `owner/repo#12` once the Control Plane took it; null before. */
  target: string | null
  state: WatchedObjectState
  /** The refusal or end reason the Control Plane gave; null while watched. */
  reason: string | null
  /** The repository's numeric id once taken, which a check's code-host reads aim at; null before. */
  repoId?: string | null
}

export interface WatchTaskObservation {
  /** The task's observation version this entry was appended at, which a check's end compares (§5.7). */
  version: number
  text: string
  author: string | null
  at: number
}

export interface WatchTask {
  /** Its one id: its own session's key, the `taskId`, whose context every check resumes. */
  taskKey: string
  agentId: string
  /** What it watches. */
  title: string
  doneWhen: string | null
  /** Its next scheduled check; null while it waits to be messaged. */
  nextAt: number | null
  status: WatchTaskStatus
  /** The place it belongs to, whose current long session owns it. */
  origin: AssistantPlace
  owner: { sessionId: string; key: string }
  /** Who confirmed it, as `'<platform>:<scope>:<uid>'` or `'user:<id>'`; null when unknown. */
  asker: string | null
  /** Its place is a public channel, so every internal place lists it (§5.12). */
  shared: boolean
  /** The platform thread it was taken in, where its reports reply; null when taken outside one. */
  replyThread: string | null
  /** What it watches for events (§5.14); null when it is woken by time and messages only. */
  watch: WatchedObject | null
  /** What it was taken with: who asked for what and where it stood. */
  background: string
  /** Its last check's result, cut to a task summary's length; empty before its first. */
  summary: string
  summaryUpdatedAt: number | null
  /** The newest {@link WATCH_TASK_OBSERVATIONS_KEPT} observations, oldest first. */
  observations: WatchTaskObservation[]
  /** Bumped by every append, independently of `version`; a check that raised it recorded what it saw. */
  observationVersion: number
  /** Bumped by every schedule change; a proposal is bound to the version it was made at (§5.10). */
  version: number
  /** A check of it runs now. */
  running: boolean
  createdAt: number
  updatedAt: number
  /** When its status, next check or title last changed, the work board's order. */
  changedAt: number
}

/** A listed watch task: everything but the observation history, which only `get` reads. */
export type WatchTaskOverview = Omit<WatchTask, 'observations'>

export interface WatchTaskOpen {
  taskKey: string
  agentId: string
  title: string
  doneWhen?: string
  nextAt?: number
  origin: AssistantPlace
  owner: { sessionId: string; key: string }
  asker?: string
  shared?: boolean
  replyThread?: string
  background?: string
  now?: number
}

export interface WatchTaskFilter {
  status?: WatchTaskStatus | WatchTaskStatus[]
  /** Watch tasks this place may see listed: its own, and every shared one. */
  visibleFrom?: AssistantPlace
  limit?: number
}

/** History kept per watch task: ~7 weeks of daily checks, while a read stays one bounded query (≤ 50 × 2,000 chars). */
export const WATCH_TASK_OBSERVATIONS_KEPT = 50
export const WATCH_TASK_LIST_DEFAULT = 50
export const WATCH_TASK_LIST_MAX = 200
/** A watch task's summary, its last check's result, is cut to a task summary's length (auto-session-mode.md §6.7). */
const SUMMARY_MAX_CHARS = 500

/** The columns the task store gains for watch mode (store version 74), as one list for its schema and its migration. */
export const WATCH_TASK_COLUMN_TYPES: readonly (readonly [string, string])[] = [
  ['nextAt', 'INTEGER'],
  ['watchStatus', 'TEXT'],
  ['doneWhen', 'TEXT'],
  ['originPlatform', 'TEXT'],
  ['originChannel', 'TEXT'],
  ['originTransportScope', 'TEXT'],
  ['asker', 'TEXT'],
  ['shared', 'INTEGER NOT NULL DEFAULT 0'],
  ['watchUrl', 'TEXT'],
  ['watchTarget', 'TEXT'],
  ['watchState', 'TEXT'],
  ['watchReason', 'TEXT'],
  ['watchRepoId', 'TEXT'],
  ['observationVersion', 'INTEGER NOT NULL DEFAULT 0'],
  ['version', 'INTEGER NOT NULL DEFAULT 1'],
  ['updatedAt', 'INTEGER']
]

export const WATCH_TASK_COLUMNS = WATCH_TASK_COLUMN_TYPES.map(([column, type]) => `${column} ${type},`).join(
  '\n        '
)

// What its checks saw, keyed like the task row; kept piecewise, since checks append concurrently with reads.
export const ASSISTANT_TASK_OBSERVATION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_task_observation (
        agentId TEXT NOT NULL,
        taskKey TEXT NOT NULL,
        observationVersion INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT,
        observedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, taskKey, observationVersion)
      );
`

/** What the watch tasks need from the store: plain statements, and one transaction on a pinned connection. */
export interface AssistantWatchTaskDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

type Row = Record<string, unknown>

// A watch row that is a follow-up: a getting-to-know task's index row is in watch mode too, without a schedule.
const WATCH_TASK = "mode = 'watch' AND watchStatus IS NOT NULL"
const OPEN = "watchStatus IN ('active', 'waiting')"

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

function overviewOf(row: Row): WatchTaskOverview {
  const updatedAt = Number(row.updatedAt ?? row.createdAt)
  return {
    taskKey: String(row.childSessionKey),
    agentId: String(row.agentId),
    title: String(row.title ?? ''),
    doneWhen: str(row.doneWhen),
    nextAt: num(row.nextAt),
    status: isWatchTaskStatus(row.watchStatus) ? row.watchStatus : 'dropped',
    origin: placeOf(row),
    owner: { sessionId: String(row.parentSessionId), key: String(row.parentSessionKey) },
    asker: str(row.asker),
    shared: Number(row.shared) === 1,
    replyThread: str(row.replyThread),
    watch: watchOf(row),
    background: String(row.background ?? ''),
    summary: String(row.summary ?? ''),
    summaryUpdatedAt: num(row.summaryUpdatedAt),
    observationVersion: Number(row.observationVersion ?? 0),
    version: Number(row.version ?? 1),
    running: row.state === 'open',
    createdAt: Number(row.createdAt),
    updatedAt,
    changedAt: Number(row.changedAt ?? updatedAt)
  }
}

export class AssistantWatchTasks {
  constructor(private readonly db: AssistantWatchTaskDatabase) {}

  /** Open a watch task under the session that owns its place, idle until its first check. */
  async open(input: WatchTaskOpen): Promise<WatchTask> {
    const now = input.now ?? Date.now()
    checkText('title', input.title, ASSISTANT_ITEM_LIMITS.title, true)
    checkText('doneWhen', input.doneWhen, ASSISTANT_ITEM_LIMITS.doneWhen)
    checkText('background', input.background, ASSISTANT_ITEM_LIMITS.summary)
    checkText('taskKey', input.taskKey, ASSISTANT_ITEM_LIMITS.taskKey, true)
    checkText('replyThread', input.replyThread, ASSISTANT_ITEM_LIMITS.refId)
    if (input.asker !== undefined) checkAsker(input.asker)
    checkTime(input.nextAt)
    if (!input.origin.platform || !input.origin.channel) throw new Error('a watch task needs a platform and a channel')
    await this.db.query(
      `INSERT INTO assistant_subsession
         (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, mode, replyThread, title,
          background, changedAt, nextAt, watchStatus, doneWhen, originPlatform, originChannel, originTransportScope,
          asker, shared, observationVersion, version, updatedAt)
       VALUES (?, ?, ?, ?, 'done', ?, 'watch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      [
        input.agentId,
        input.taskKey,
        input.owner.sessionId,
        input.owner.key,
        now,
        input.replyThread ?? null,
        input.title,
        input.background ?? null,
        now,
        input.nextAt ?? null,
        input.nextAt !== undefined ? 'active' : 'waiting',
        input.doneWhen ?? null,
        input.origin.platform,
        input.origin.channel,
        input.origin.transportScope ?? '',
        input.asker ?? null,
        input.shared === true ? 1 : 0,
        now
      ]
    )
    return (await this.get(input.agentId, input.taskKey))!
  }

  /** A watch task by its one id, with its observations. */
  async get(agentId: string, taskKey: string): Promise<WatchTask | undefined> {
    const row = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE agentId = ? AND childSessionKey = ? AND ${WATCH_TASK}`,
        [agentId, taskKey]
      )
    ).rows[0] as Row | undefined
    if (!row) return undefined
    const observations = (
      await this.db.query(
        `SELECT observationVersion, text, author, observedAt FROM assistant_task_observation
         WHERE agentId = ? AND taskKey = ? ORDER BY observationVersion`,
        [agentId, taskKey]
      )
    ).rows as Row[]
    return {
      ...overviewOf(row),
      observations: observations.map((o) => ({
        version: Number(o.observationVersion),
        text: String(o.text),
        author: str(o.author),
        at: Number(o.observedAt)
      }))
    }
  }

  /** The agent's watch tasks, most recently updated first. */
  async list(agentId: string, filter: WatchTaskFilter = {}): Promise<WatchTaskOverview[]> {
    const where = ['agentId = ?', WATCH_TASK]
    const params: unknown[] = [agentId]
    const statuses = filter.status === undefined ? [] : [filter.status].flat()
    for (const status of statuses) if (!isWatchTaskStatus(status)) throw new Error('watch task status is not supported')
    if (statuses.length > 0) {
      where.push(`watchStatus IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    if (filter.visibleFrom !== undefined) {
      where.push('(shared = 1 OR (originPlatform = ? AND originChannel = ? AND originTransportScope = ?))')
      params.push(filter.visibleFrom.platform, filter.visibleFrom.channel, filter.visibleFrom.transportScope ?? '')
    }
    params.push(Math.min(Math.max(1, Math.floor(filter.limit ?? WATCH_TASK_LIST_DEFAULT)), WATCH_TASK_LIST_MAX))
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_subsession WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(updatedAt, createdAt) DESC, childSessionKey LIMIT ?`,
        params
      )
    ).rows as Row[]
    return rows.map(overviewOf)
  }

  /** Field-level append, which makes it the task's summary: no version check, keeps the newest {@link WATCH_TASK_OBSERVATIONS_KEPT}. */
  async appendObservation(
    agentId: string,
    taskKey: string,
    observation: { text: string; author?: string; now?: number }
  ): Promise<WatchTaskObservation | undefined> {
    const at = observation.now ?? Date.now()
    checkText('observation', observation.text, ASSISTANT_ITEM_LIMITS.observation, true)
    checkText('author', observation.author, ASSISTANT_ITEM_LIMITS.author)
    return await this.db.transaction(async (tx) => {
      // A relative write that takes the row lock, so concurrent appends get distinct versions on both dialects.
      const bumped = (
        await tx.query(
          `UPDATE assistant_subsession SET observationVersion = observationVersion + 1, updatedAt = ?, summary = ?,
             summaryUpdatedAt = ?
           WHERE agentId = ? AND childSessionKey = ? AND ${WATCH_TASK} RETURNING observationVersion`,
          [at, cut(observation.text, SUMMARY_MAX_CHARS), at, agentId, taskKey]
        )
      ).rows[0] as { observationVersion: number } | undefined
      if (!bumped) return undefined
      const version = Number(bumped.observationVersion)
      await tx.query(
        `INSERT INTO assistant_task_observation (agentId, taskKey, observationVersion, text, author, observedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [agentId, taskKey, version, observation.text, observation.author ?? null, at]
      )
      await tx.query(
        'DELETE FROM assistant_task_observation WHERE agentId = ? AND taskKey = ? AND observationVersion <= ?',
        [agentId, taskKey, version - WATCH_TASK_OBSERVATIONS_KEPT]
      )
      return { version, text: observation.text, author: observation.author ?? null, at }
    })
  }

  /** Set an open watch task's schedule or end it, with no version handshake; false once it has ended. */
  async schedule(
    agentId: string,
    taskKey: string,
    next: { status: WatchTaskStatus; nextAt: number | null },
    now = Date.now()
  ): Promise<boolean> {
    if (!isWatchTaskStatus(next.status)) throw new Error('watch task status is not supported')
    checkTime(next.nextAt ?? undefined)
    // A schedule that changes nothing the work board shows keeps its place in the board's order; an end closes the task.
    const ended = next.status === 'done' || next.status === 'dropped'
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET watchStatus = ?, nextAt = ?, version = version + 1, updatedAt = ?,
         changedAt = CASE WHEN watchStatus = ? AND COALESCE(nextAt, -1) = ? THEN changedAt ELSE ? END${
           ended ? `, ${CLOSE_TASK}` : ''
         }
       WHERE agentId = ? AND childSessionKey = ? AND ${WATCH_TASK} AND ${OPEN}`,
      [next.status, next.nextAt, now, next.status, next.nextAt ?? -1, now, ...(ended ? [now] : []), agentId, taskKey]
    )
    return changes > 0
  }

  /** Set or clear what an open watch task watches (§5.14); false once it ended or is gone. */
  async setWatch(agentId: string, taskKey: string, watch: WatchedObject | null, now = Date.now()): Promise<boolean> {
    if (watch) {
      checkText('watchUrl', watch.url, ASSISTANT_ITEM_LIMITS.watchUrl, true)
      if (!WATCHED_OBJECT_STATES.includes(watch.state)) throw new Error('a watched object state is not supported')
    }
    const { changes } = await this.db.query(
      `UPDATE assistant_subsession SET watchUrl = ?, watchTarget = ?, watchState = ?, watchReason = ?, watchRepoId = ?,
         updatedAt = ?
       WHERE agentId = ? AND childSessionKey = ? AND ${WATCH_TASK} AND ${OPEN}`,
      [
        watch?.url ?? null,
        watch?.target ?? null,
        watch?.state ?? null,
        watch?.reason ?? null,
        watch?.repoId ?? null,
        now,
        agentId,
        taskKey
      ]
    )
    return changes > 0
  }

  /** The agent's open watch tasks whose watch is taken or waits to be, as a full set for the Control Plane (§5.14). */
  async watching(agentId: string): Promise<Array<{ taskKey: string; url: string }>> {
    const rows = (
      await this.db.query(
        `SELECT childSessionKey, watchUrl FROM assistant_subsession
         WHERE agentId = ? AND ${WATCH_TASK} AND ${OPEN} AND watchUrl IS NOT NULL AND watchState IN ('pending', 'watching')
         ORDER BY createdAt, childSessionKey`,
        [agentId]
      )
    ).rows as Row[]
    return rows.map((row) => ({ taskKey: String(row.childSessionKey), url: String(row.watchUrl) }))
  }

  /** Whether every internal place lists it, as its place's audience was last judged. */
  async setShared(agentId: string, taskKey: string, shared: boolean): Promise<void> {
    const value = shared ? 1 : 0
    await this.db.query(
      `UPDATE assistant_subsession SET shared = ? WHERE agentId = ? AND childSessionKey = ? AND ${WATCH_TASK} AND shared <> ?`,
      [value, agentId, taskKey, value]
    )
  }
}

const watchOf = (row: Row): WatchedObject | null => {
  const state = WATCHED_OBJECT_STATES.find((candidate) => candidate === row.watchState)
  return row.watchUrl && state
    ? {
        url: String(row.watchUrl),
        target: str(row.watchTarget),
        state,
        reason: str(row.watchReason),
        repoId: str(row.watchRepoId)
      }
    : null
}

// Stored as '' like the item ledger's places, so equality needs no NULL handling.
const placeOf = (row: Row): AssistantPlace => ({
  platform: String(row.originPlatform ?? ''),
  channel: String(row.originChannel ?? ''),
  transportScope: row.originTransportScope ? String(row.originTransportScope) : null
})

const cut = (text: string, max: number): string => {
  const chars = [...text.trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

const IDENTITY_PATTERN = /^(user:[^:\s]+|[^:\s]+:[^\s]*:[^\s]+)$/

function checkAsker(identity: string): void {
  checkText('asker', identity, ASSISTANT_ITEM_LIMITS.identity, true)
  if (!IDENTITY_PATTERN.test(identity))
    throw new Error("a watch task's asker must be '<platform>:<scope>:<uid>' or 'user:<id>'")
}

function checkTime(at: number | undefined): void {
  if (at !== undefined && (!Number.isSafeInteger(at) || at < 0))
    throw new Error("a watch task's next check must be an epoch-millisecond integer")
}

function checkText(field: string, value: string | undefined, max: number, required = false): void {
  if (value === undefined) {
    if (required) throw new Error(`a watch task's ${field} is required`)
    return
  }
  if (required && value.trim() === '') throw new Error(`a watch task's ${field} must not be empty`)
  if (value.length > max) throw new Error(`a watch task's ${field} exceeds ${max} characters`)
}
