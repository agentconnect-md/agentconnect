// An agent's follow-ups (assistant-mode.md §5.12), kept in the item ledger's tables, in the daemon store, partitioned by agent.
import { randomUUID } from 'node:crypto'
import type { SessionRecord } from './local-store.js'
import type { StoreQueryResult, StoreTx } from './store-database.js'

export const ASSISTANT_ITEM_STATUSES = ['active', 'waiting', 'done', 'dropped'] as const
export type AssistantItemStatus = (typeof ASSISTANT_ITEM_STATUSES)[number]

/** How a first look (assistant-mode.md §5.13) was started: the bot joined the place, or someone there asked. */
export const ASSISTANT_FIRST_LOOK_TRIGGERS = ['joined', 'requested'] as const
export type AssistantFirstLookTrigger = (typeof ASSISTANT_FIRST_LOOK_TRIGGERS)[number]

/** A place (§5.2) in the coordinate a session row wears; an absent transport scope reads back as null. */
export type AssistantPlace = Pick<SessionRecord, 'platform' | 'channel' | 'transportScope'>

export interface AssistantObservation {
  /** The item's observation version this entry was appended at — what the outbox's dedup key names (§5.7). */
  version: number
  text: string
  author: string | null
  at: number
}

export interface AssistantItem {
  id: string
  agentId: string
  title: string
  doneWhen: string | null
  nextCheck: number | null
  status: AssistantItemStatus
  /** The place it belongs to, whose current long session owns it. */
  origin: AssistantPlace
  /** Its own session's key: the `taskId`, whose context every check resumes. */
  taskKey: string
  /** Who confirmed it, as `'<platform>:<scope>:<uid>'` or `'user:<id>'`; null when unknown. */
  asker: string | null
  /** Its place is a public channel, so every internal place lists it (§5.12). */
  shared: boolean
  /** The platform thread it was taken in, where its reports reply; null when taken outside one. */
  replyThread: string | null
  /** Set on a first look of its place (assistant-mode.md §5.13), which ends after one check; null on a follow-up. */
  firstLook: AssistantFirstLookTrigger | null
  summary: string
  /** The newest {@link ASSISTANT_ITEM_OBSERVATIONS_KEPT} observations, oldest first. */
  observations: AssistantObservation[]
  /** Bumped by every append, independently of `version`; a check that raised it recorded what it saw. */
  observationVersion: number
  subsessions: string[]
  proposals: string[]
  /** Bumped by every schedule change; a proposal is bound to the version it was made at (§5.10). */
  version: number
  createdAt: number
  updatedAt: number
}

/** A listed item: everything but the observation history, which only `get` reads. */
export type AssistantItemOverview = Omit<AssistantItem, 'observations'>

export interface AssistantItemCreate {
  /** An id the caller minted, as an approved proposal's follow-up form names it before taking it. */
  id?: string
  agentId: string
  title: string
  doneWhen?: string
  nextCheck?: number
  status?: AssistantItemStatus
  origin: AssistantPlace
  taskKey: string
  asker?: string
  shared?: boolean
  replyThread?: string
  firstLook?: AssistantFirstLookTrigger
  summary?: string
  now?: number
}

export interface AssistantItemFilter {
  status?: AssistantItemStatus | AssistantItemStatus[]
  /** Items born in this place. */
  origin?: AssistantPlace
  /** Items this place may see listed: its own, and every shared one. */
  visibleFrom?: AssistantPlace
  /** Follow-ups alone, leaving first looks out. */
  followUpsOnly?: boolean
  limit?: number
}

/** A follow-up's schedule after a check or a stop: open with or without a next check, or ended. */
export interface AssistantItemSchedule {
  status: AssistantItemStatus
  nextCheck: number | null
}

export type AssistantItemLinkKind = 'subsession' | 'proposal'

/** History kept per follow-up: ~7 weeks of daily checks, while a read stays one bounded query (≤ 50 × 2,000 chars). */
export const ASSISTANT_ITEM_OBSERVATIONS_KEPT = 50
export const ASSISTANT_ITEM_LIST_DEFAULT = 50
export const ASSISTANT_ITEM_LIST_MAX = 200
export const ASSISTANT_ITEM_LIMITS = {
  title: 300,
  doneWhen: 2_000,
  summary: 8_000,
  observation: 2_000,
  identity: 512,
  author: 512,
  refId: 256,
  taskKey: 1_024,
  /** A first look's report: room for its 1,500 words in any language (assistant-mode.md §5.13). */
  firstLookReport: 16_000
} as const

// Normalized children, not JSON columns: each is written piecewise and concurrently.
export const ASSISTANT_ITEM_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_item (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        title TEXT NOT NULL,
        doneWhen TEXT,
        nextCheck INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'done', 'dropped')),
        originPlatform TEXT NOT NULL,
        originChannel TEXT NOT NULL,
        originTransportScope TEXT NOT NULL DEFAULT '',
        taskKey TEXT NOT NULL DEFAULT '',
        asker TEXT,
        shared INTEGER NOT NULL DEFAULT 0,
        replyThread TEXT,
        firstLook TEXT,
        summary TEXT NOT NULL DEFAULT '',
        observationVersion INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_item_by_agent ON assistant_item (agentId, status, updatedAt);
      CREATE INDEX IF NOT EXISTS assistant_item_by_origin
        ON assistant_item (agentId, originPlatform, originChannel, originTransportScope);
      CREATE INDEX IF NOT EXISTS assistant_item_by_task ON assistant_item (agentId, taskKey);
      CREATE TABLE IF NOT EXISTS assistant_item_observation (
        itemId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        observationVersion INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT,
        observedAt INTEGER NOT NULL,
        PRIMARY KEY (itemId, observationVersion)
      );
      CREATE TABLE IF NOT EXISTS assistant_item_link (
        itemId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('subsession', 'proposal')),
        refId TEXT NOT NULL,
        linkedAt INTEGER NOT NULL,
        PRIMARY KEY (itemId, kind, refId)
      );
`

/** What the ledger needs from the store: plain statements, and one transaction on a pinned connection. */
export interface AssistantItemDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

interface ItemRow {
  id: string
  agentId: string
  title: string
  doneWhen: string | null
  nextCheck: number | null
  status: AssistantItemStatus
  originPlatform: string
  originChannel: string
  originTransportScope: string
  taskKey: string
  asker: string | null
  shared: number
  replyThread: string | null
  firstLook: string | null
  summary: string
  observationVersion: number
  version: number
  createdAt: number
  updatedAt: number
}

interface LinkRow {
  itemId: string
  kind: AssistantItemLinkKind
  refId: string
}

interface ObservationRow {
  observationVersion: number
  text: string
  author: string | null
  observedAt: number
}

const ITEM_COLUMNS = [
  'id',
  'agentId',
  'title',
  'doneWhen',
  'nextCheck',
  'status',
  'originPlatform',
  'originChannel',
  'originTransportScope',
  'taskKey',
  'asker',
  'shared',
  'replyThread',
  'firstLook',
  'summary',
  'observationVersion',
  'version',
  'createdAt',
  'updatedAt'
] as const
const itemColumns = (alias = ''): string => ITEM_COLUMNS.map((column) => `${alias}${column}`).join(', ')

export class AssistantItemLedger {
  constructor(private readonly db: AssistantItemDatabase) {}

  async create(input: AssistantItemCreate): Promise<AssistantItem> {
    const now = input.now ?? Date.now()
    const status = input.status ?? 'active'
    checkText('title', input.title, ASSISTANT_ITEM_LIMITS.title, true)
    checkText('doneWhen', input.doneWhen, ASSISTANT_ITEM_LIMITS.doneWhen)
    checkText('summary', input.summary, ASSISTANT_ITEM_LIMITS.summary)
    checkText('taskKey', input.taskKey, ASSISTANT_ITEM_LIMITS.taskKey, true)
    checkText('replyThread', input.replyThread, ASSISTANT_ITEM_LIMITS.refId)
    if (input.asker !== undefined) checkAsker(input.asker)
    checkStatus(status)
    checkNextCheck(input.nextCheck)
    checkPlace(input.origin)
    if (input.firstLook !== undefined && !ASSISTANT_FIRST_LOOK_TRIGGERS.includes(input.firstLook))
      throw new Error(`assistant item firstLook is not one of ${ASSISTANT_FIRST_LOOK_TRIGGERS.join(', ')}`)
    const id = input.id ?? randomUUID()
    await this.db.query(
      `INSERT INTO assistant_item (id, agentId, title, doneWhen, nextCheck, status, originPlatform, originChannel,
         originTransportScope, taskKey, asker, shared, replyThread, firstLook, summary, observationVersion, version,
         createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      [
        id,
        input.agentId,
        input.title,
        input.doneWhen ?? null,
        input.nextCheck ?? null,
        status,
        input.origin.platform,
        input.origin.channel,
        scopeOf(input.origin),
        input.taskKey,
        input.asker ?? null,
        input.shared === true ? 1 : 0,
        input.replyThread ?? null,
        input.firstLook ?? null,
        input.summary ?? '',
        now,
        now
      ]
    )
    return (await this.get(input.agentId, id))!
  }

  async get(agentId: string, itemId: string): Promise<AssistantItem | undefined> {
    const row = (
      await this.db.query(`SELECT ${itemColumns()} FROM assistant_item WHERE agentId = ? AND id = ?`, [agentId, itemId])
    ).rows[0] as ItemRow | undefined
    return row ? await this.withObservations(agentId, row) : undefined
  }

  /** The follow-up whose own session this is, by its `taskId`. */
  async byTaskKey(agentId: string, taskKey: string): Promise<AssistantItem | undefined> {
    if (taskKey === '') return undefined
    const row = (
      await this.db.query(`SELECT ${itemColumns()} FROM assistant_item WHERE agentId = ? AND taskKey = ?`, [
        agentId,
        taskKey
      ])
    ).rows[0] as ItemRow | undefined
    return row ? await this.withObservations(agentId, row) : undefined
  }

  /** The place's newest first look, in any state: the record that it had one (assistant-mode.md §5.13). */
  async latestFirstLook(agentId: string, place: AssistantPlace): Promise<AssistantItemOverview | undefined> {
    const rows = (
      await this.db.query(
        `SELECT ${itemColumns('i.')} FROM assistant_item i
         WHERE i.agentId = ? AND i.originPlatform = ? AND i.originChannel = ? AND i.originTransportScope = ?
           AND i.firstLook IS NOT NULL
         ORDER BY i.createdAt DESC, i.id LIMIT 1`,
        [agentId, place.platform, place.channel, scopeOf(place)]
      )
    ).rows as ItemRow[]
    return (await this.withLinks(agentId, rows))[0]
  }

  /** The agent's items, most recently updated first. */
  async list(agentId: string, filter: AssistantItemFilter = {}): Promise<AssistantItemOverview[]> {
    const where = ['i.agentId = ?']
    const params: unknown[] = [agentId]
    const statuses = filter.status === undefined ? [] : [filter.status].flat()
    for (const status of statuses) checkStatus(status)
    if (statuses.length > 0) {
      where.push(`i.status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    if (filter.origin !== undefined) {
      where.push('i.originPlatform = ? AND i.originChannel = ? AND i.originTransportScope = ?')
      params.push(filter.origin.platform, filter.origin.channel, scopeOf(filter.origin))
    }
    if (filter.visibleFrom !== undefined) {
      where.push('(i.shared = 1 OR (i.originPlatform = ? AND i.originChannel = ? AND i.originTransportScope = ?))')
      params.push(filter.visibleFrom.platform, filter.visibleFrom.channel, scopeOf(filter.visibleFrom))
    }
    if (filter.followUpsOnly === true) where.push('i.firstLook IS NULL')
    const limit = Math.min(
      Math.max(1, Math.floor(filter.limit ?? ASSISTANT_ITEM_LIST_DEFAULT)),
      ASSISTANT_ITEM_LIST_MAX
    )
    params.push(limit)
    const rows = (
      await this.db.query(
        `SELECT ${itemColumns('i.')} FROM assistant_item i WHERE ${where.join(' AND ')}
         ORDER BY i.updatedAt DESC, i.id LIMIT ?`,
        params
      )
    ).rows as ItemRow[]
    return await this.withLinks(agentId, rows)
  }

  /** Field-level append: no version check, keeps the newest {@link ASSISTANT_ITEM_OBSERVATIONS_KEPT}. */
  async appendObservation(
    agentId: string,
    itemId: string,
    observation: { text: string; author?: string; now?: number }
  ): Promise<AssistantObservation | undefined> {
    const at = observation.now ?? Date.now()
    checkText('observation', observation.text, ASSISTANT_ITEM_LIMITS.observation, true)
    checkText('author', observation.author, ASSISTANT_ITEM_LIMITS.author)
    return await this.db.transaction(async (tx) => {
      // A relative write that takes the row lock, so concurrent appends get distinct versions on both dialects.
      const bumped = (
        await tx.query(
          `UPDATE assistant_item SET observationVersion = observationVersion + 1, updatedAt = ?
           WHERE agentId = ? AND id = ? RETURNING observationVersion`,
          [at, agentId, itemId]
        )
      ).rows[0] as { observationVersion: number } | undefined
      if (!bumped) return undefined
      const version = Number(bumped.observationVersion)
      await tx.query(
        `INSERT INTO assistant_item_observation (itemId, agentId, observationVersion, text, author, observedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [itemId, agentId, version, observation.text, observation.author ?? null, at]
      )
      await tx.query(
        'DELETE FROM assistant_item_observation WHERE agentId = ? AND itemId = ? AND observationVersion <= ?',
        [agentId, itemId, version - ASSISTANT_ITEM_OBSERVATIONS_KEPT]
      )
      return { version, text: observation.text, author: observation.author ?? null, at }
    })
  }

  /** Set an open follow-up's schedule or end it, with no version handshake; false once it has ended. */
  async schedule(agentId: string, itemId: string, next: AssistantItemSchedule, now = Date.now()): Promise<boolean> {
    checkStatus(next.status)
    checkNextCheck(next.nextCheck ?? undefined)
    const { changes } = await this.db.query(
      `UPDATE assistant_item SET status = ?, nextCheck = ?, version = version + 1, updatedAt = ?
       WHERE agentId = ? AND id = ? AND status IN ('active', 'waiting')`,
      [next.status, next.nextCheck, now, agentId, itemId]
    )
    return changes > 0
  }

  /** Whether every internal place lists it, as its place's audience was last judged. */
  async setShared(agentId: string, itemId: string, shared: boolean): Promise<void> {
    const value = shared ? 1 : 0
    await this.db.query('UPDATE assistant_item SET shared = ? WHERE agentId = ? AND id = ? AND shared <> ?', [
      value,
      agentId,
      itemId,
      value
    ])
  }

  /** True when the link was added; false when it existed or the item is gone. */
  async link(
    agentId: string,
    itemId: string,
    kind: AssistantItemLinkKind,
    refId: string,
    now = Date.now()
  ): Promise<boolean> {
    checkLink(kind, refId)
    return await this.db.transaction(async (tx) => {
      if (!(await lockItem(tx, agentId, itemId))) return false
      const { changes } = await tx.query(
        'INSERT OR IGNORE INTO assistant_item_link (itemId, agentId, kind, refId, linkedAt) VALUES (?, ?, ?, ?, ?)',
        [itemId, agentId, kind, refId, now]
      )
      if (changes > 0) await touchItem(tx, agentId, itemId, now)
      return changes > 0
    })
  }

  async unlink(
    agentId: string,
    itemId: string,
    kind: AssistantItemLinkKind,
    refId: string,
    now = Date.now()
  ): Promise<boolean> {
    checkLink(kind, refId)
    return await this.db.transaction(async (tx) => {
      if (!(await lockItem(tx, agentId, itemId))) return false
      const { changes } = await tx.query(
        'DELETE FROM assistant_item_link WHERE agentId = ? AND itemId = ? AND kind = ? AND refId = ?',
        [agentId, itemId, kind, refId]
      )
      if (changes > 0) await touchItem(tx, agentId, itemId, now)
      return changes > 0
    })
  }

  /** Every item of a deleted agent; returns how many items went. */
  async deleteForAgent(agentId: string): Promise<number> {
    return await this.db.transaction(async (tx) => {
      const { changes } = await tx.query('DELETE FROM assistant_item WHERE agentId = ?', [agentId])
      for (const table of CHILD_TABLES) await tx.query(`DELETE FROM ${table} WHERE agentId = ?`, [agentId])
      return changes
    })
  }

  private async withObservations(agentId: string, row: ItemRow): Promise<AssistantItem> {
    const [overview] = await this.withLinks(agentId, [row])
    const observations = (
      await this.db.query(
        `SELECT observationVersion, text, author, observedAt FROM assistant_item_observation
         WHERE agentId = ? AND itemId = ? ORDER BY observationVersion`,
        [agentId, row.id]
      )
    ).rows as ObservationRow[]
    return {
      ...overview!,
      observations: observations.map((o) => ({
        version: Number(o.observationVersion),
        text: o.text,
        author: o.author,
        at: Number(o.observedAt)
      }))
    }
  }

  private async withLinks(agentId: string, rows: ItemRow[]): Promise<AssistantItemOverview[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const marks = ids.map(() => '?').join(', ')
    const links = (
      await this.db.query(
        `SELECT itemId, kind, refId FROM assistant_item_link
         WHERE agentId = ? AND itemId IN (${marks}) ORDER BY linkedAt, refId`,
        [agentId, ...ids]
      )
    ).rows as LinkRow[]
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      title: row.title,
      doneWhen: row.doneWhen,
      nextCheck: row.nextCheck === null ? null : Number(row.nextCheck),
      status: row.status,
      origin: placeOf(row.originPlatform, row.originChannel, row.originTransportScope),
      taskKey: row.taskKey,
      asker: row.asker ?? null,
      shared: Number(row.shared) === 1,
      replyThread: row.replyThread ?? null,
      firstLook: triggerOf(row.firstLook),
      summary: row.summary,
      observationVersion: Number(row.observationVersion),
      subsessions: links.filter((l) => l.itemId === row.id && l.kind === 'subsession').map((l) => l.refId),
      proposals: links.filter((l) => l.itemId === row.id && l.kind === 'proposal').map((l) => l.refId),
      version: Number(row.version),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt)
    }))
  }
}

// The check state and log (assistant-checks.ts) are keyed the same way and go with their follow-up.
const CHILD_TABLES = [
  'assistant_item_observation',
  'assistant_item_link',
  'assistant_check_state',
  'assistant_check'
] as const

/** Takes the item's row lock for the rest of the transaction without changing it; false when the item is gone. */
async function lockItem(tx: StoreTx, agentId: string, itemId: string): Promise<boolean> {
  const { changes } = await tx.query('UPDATE assistant_item SET updatedAt = updatedAt WHERE agentId = ? AND id = ?', [
    agentId,
    itemId
  ])
  return changes > 0
}

async function touchItem(tx: StoreTx, agentId: string, itemId: string, now: number): Promise<void> {
  await tx.query('UPDATE assistant_item SET updatedAt = ? WHERE agentId = ? AND id = ?', [now, agentId, itemId])
}

const triggerOf = (value: string | null | undefined): AssistantFirstLookTrigger | null =>
  ASSISTANT_FIRST_LOOK_TRIGGERS.find((trigger) => trigger === value) ?? null

// Stored as '' like append_reservation and thread_participation, so equality needs no NULL handling.
const scopeOf = (place: AssistantPlace): string => place.transportScope ?? ''

const placeOf = (platform: string, channel: string, transportScope: string): AssistantPlace => ({
  platform,
  channel,
  transportScope: transportScope === '' ? null : transportScope
})

const IDENTITY_PATTERN = /^(user:[^:\s]+|[^:\s]+:[^\s]*:[^\s]+)$/

function checkAsker(identity: string): void {
  checkText('asker', identity, ASSISTANT_ITEM_LIMITS.identity, true)
  if (!IDENTITY_PATTERN.test(identity))
    throw new Error("assistant item asker must be '<platform>:<scope>:<uid>' or 'user:<id>'")
}

function checkPlace(place: AssistantPlace): void {
  if (!place.platform || !place.channel) throw new Error('assistant item place needs a platform and a channel')
}

function checkStatus(status: string): void {
  if (!(ASSISTANT_ITEM_STATUSES as readonly string[]).includes(status))
    throw new Error(`assistant item status is not one of ${ASSISTANT_ITEM_STATUSES.join(', ')}`)
}

function checkNextCheck(nextCheck: number | undefined): void {
  if (nextCheck !== undefined && (!Number.isSafeInteger(nextCheck) || nextCheck < 0))
    throw new Error('assistant item nextCheck must be an epoch-millisecond integer')
}

function checkLink(kind: AssistantItemLinkKind, refId: string): void {
  if (kind !== 'subsession' && kind !== 'proposal') throw new Error('assistant item link kind is not supported')
  checkText('refId', refId, ASSISTANT_ITEM_LIMITS.refId, true)
}

function checkText(field: string, value: string | undefined, max: number, required = false): void {
  if (value === undefined) {
    if (required) throw new Error(`assistant item ${field} is required`)
    return
  }
  if (required && value.trim() === '') throw new Error(`assistant item ${field} must not be empty`)
  if (value.length > max) throw new Error(`assistant item ${field} exceeds ${max} characters`)
}
