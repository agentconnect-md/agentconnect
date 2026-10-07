// The assistant item ledger (assistant-mode.md §5.4 ①): an agent's tracked items, in the daemon store, partitioned by agent.
import { randomUUID } from 'node:crypto'
import type { SessionRecord } from './local-store.js'
import type { StoreQueryResult, StoreTx } from './store-database.js'

export const ASSISTANT_ITEM_STATUSES = ['active', 'waiting', 'done', 'dropped'] as const
export type AssistantItemStatus = (typeof ASSISTANT_ITEM_STATUSES)[number]

export type AssistantTrust = 'internal' | 'external'

/** A place (§5.2) in the coordinate a session row wears; an absent transport scope reads back as null. */
export type AssistantPlace = Pick<SessionRecord, 'platform' | 'channel' | 'transportScope'>

/** `identity` is `'<platform>:<scope>:<uid>'` or `'user:<id>'`; followers are never merged across platforms (§5.4). */
export interface AssistantFollower {
  identity: string
  place: AssistantPlace
}

/** A place's declared trust level (§5.3); synchronous because it runs inside the store transaction, and undefined counts as external. */
export type AssistantTrustLookup = (place: AssistantPlace) => AssistantTrust | undefined

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
  followers: AssistantFollower[]
  origin: AssistantPlace
  trust: AssistantTrust
  summary: string
  /** The newest {@link ASSISTANT_ITEM_OBSERVATIONS_KEPT} observations, oldest first. */
  observations: AssistantObservation[]
  /** Bumped by every append; independent of `version`, so a patrol's append never fails a transition's CAS. */
  observationVersion: number
  subsessions: string[]
  proposals: string[]
  /** The CAS counter `transition` checks; only transitions bump it. */
  version: number
  createdAt: number
  updatedAt: number
}

/** A listed item: everything but the observation history, which only `get` reads. */
export type AssistantItemOverview = Omit<AssistantItem, 'observations'>

export interface AssistantItemCreate {
  agentId: string
  title: string
  doneWhen?: string
  nextCheck?: number
  status?: AssistantItemStatus
  origin: AssistantPlace
  followers?: AssistantFollower[]
  summary?: string
  now?: number
}

export interface AssistantItemFilter {
  status?: AssistantItemStatus | AssistantItemStatus[]
  /** Items this identity follows, from any place. */
  followerIdentity?: string
  /** Items followed from this place. */
  place?: AssistantPlace
  /** Items born in this place. */
  origin?: AssistantPlace
  limit?: number
}

/** The fields a transition may set; `null` clears an optional one. */
export interface AssistantItemPatch {
  status?: AssistantItemStatus
  nextCheck?: number | null
  title?: string
  doneWhen?: string | null
  summary?: string
}

export type AssistantTransitionResult =
  | { ok: true; item: AssistantItem }
  | { ok: false; reason: 'conflict'; current: AssistantItem }
  | { ok: false; reason: 'not_found' }

export type AssistantItemLinkKind = 'subsession' | 'proposal'

/** History kept per item: ~7 weeks of a daily patrol, while an item read stays one bounded query (≤ 50 × 2,000 chars). */
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
  refId: 256
} as const

// Normalized children, not JSON columns: each is written piecewise and concurrently, and two of them are list filters.
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
        trust TEXT NOT NULL CHECK (trust IN ('internal', 'external')),
        summary TEXT NOT NULL DEFAULT '',
        observationVersion INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_item_by_agent ON assistant_item (agentId, status, updatedAt);
      CREATE INDEX IF NOT EXISTS assistant_item_by_origin
        ON assistant_item (agentId, originPlatform, originChannel, originTransportScope);
      CREATE TABLE IF NOT EXISTS assistant_item_follower (
        itemId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        identity TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        transportScope TEXT NOT NULL DEFAULT '',
        addedAt INTEGER NOT NULL,
        PRIMARY KEY (itemId, identity, platform, channel, transportScope)
      );
      CREATE INDEX IF NOT EXISTS assistant_item_follower_identity ON assistant_item_follower (agentId, identity);
      CREATE INDEX IF NOT EXISTS assistant_item_follower_place
        ON assistant_item_follower (agentId, platform, channel, transportScope);
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
  trust: AssistantTrust
  summary: string
  observationVersion: number
  version: number
  createdAt: number
  updatedAt: number
}

interface FollowerRow {
  itemId: string
  identity: string
  platform: string
  channel: string
  transportScope: string
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
  'trust',
  'summary',
  'observationVersion',
  'version',
  'createdAt',
  'updatedAt'
] as const
const itemColumns = (alias = ''): string => ITEM_COLUMNS.map((column) => `${alias}${column}`).join(', ')

/** Lowest wins: one external or unknown place makes the item external (§5.3). */
export function lowestTrust(places: AssistantPlace[], trustOf: AssistantTrustLookup): AssistantTrust {
  return places.every((place) => trustOf(place) === 'internal') ? 'internal' : 'external'
}

export class AssistantItemLedger {
  constructor(private readonly db: AssistantItemDatabase) {}

  /** Trust is the lowest among the followers' places and the origin, whose content the item was born from. */
  async create(input: AssistantItemCreate, trustOf: AssistantTrustLookup): Promise<AssistantItem> {
    const now = input.now ?? Date.now()
    const status = input.status ?? 'active'
    checkText('title', input.title, ASSISTANT_ITEM_LIMITS.title, true)
    checkText('doneWhen', input.doneWhen, ASSISTANT_ITEM_LIMITS.doneWhen)
    checkText('summary', input.summary, ASSISTANT_ITEM_LIMITS.summary)
    checkStatus(status)
    checkNextCheck(input.nextCheck)
    checkPlace(input.origin)
    const followers = dedupeFollowers(input.followers ?? [])
    for (const follower of followers) checkFollower(follower)
    const trust = lowestTrust([input.origin, ...followers.map((follower) => follower.place)], trustOf)
    const id = randomUUID()
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO assistant_item (id, agentId, title, doneWhen, nextCheck, status, originPlatform, originChannel,
           originTransportScope, trust, summary, observationVersion, version, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
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
          trust,
          input.summary ?? '',
          now,
          now
        ]
      )
      for (const follower of followers) await insertFollower(tx, input.agentId, id, follower, now)
    })
    return (await this.get(input.agentId, id))!
  }

  async get(agentId: string, itemId: string): Promise<AssistantItem | undefined> {
    const row = (
      await this.db.query(`SELECT ${itemColumns()} FROM assistant_item WHERE agentId = ? AND id = ?`, [agentId, itemId])
    ).rows[0] as ItemRow | undefined
    if (!row) return undefined
    const [overview] = await this.withChildren(agentId, [row])
    const observations = (
      await this.db.query(
        `SELECT observationVersion, text, author, observedAt FROM assistant_item_observation
         WHERE agentId = ? AND itemId = ? ORDER BY observationVersion`,
        [agentId, itemId]
      )
    ).rows as ObservationRow[]
    return {
      ...overview!,
      observations: observations.map((o) => ({
        version: o.observationVersion,
        text: o.text,
        author: o.author,
        at: o.observedAt
      }))
    }
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
    if (filter.followerIdentity !== undefined) {
      where.push(
        'EXISTS (SELECT 1 FROM assistant_item_follower f WHERE f.agentId = i.agentId AND f.itemId = i.id AND f.identity = ?)'
      )
      params.push(filter.followerIdentity)
    }
    if (filter.place !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM assistant_item_follower p WHERE p.agentId = i.agentId AND p.itemId = i.id
        AND p.platform = ? AND p.channel = ? AND p.transportScope = ?)`)
      params.push(filter.place.platform, filter.place.channel, scopeOf(filter.place))
    }
    if (filter.origin !== undefined) {
      where.push('i.originPlatform = ? AND i.originChannel = ? AND i.originTransportScope = ?')
      params.push(filter.origin.platform, filter.origin.channel, scopeOf(filter.origin))
    }
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
    return await this.withChildren(agentId, rows)
  }

  /** Idempotent on (identity, place); recomputes trust under the item's row lock, so concurrent attaches cannot lose a lower level. */
  async attachFollower(
    agentId: string,
    itemId: string,
    follower: AssistantFollower,
    trustOf: AssistantTrustLookup,
    now = Date.now()
  ): Promise<{ added: boolean; trust: AssistantTrust } | undefined> {
    checkFollower(follower)
    return await this.db.transaction(async (tx) => {
      if (!(await lockItem(tx, agentId, itemId))) return undefined
      const added = await insertFollower(tx, agentId, itemId, follower, now)
      const trust = await recomputeTrust(tx, agentId, itemId, trustOf, now)
      if (added) await touchItem(tx, agentId, itemId, now)
      return { added, trust }
    })
  }

  /** Re-derive trust after a place's level changed (§5.3 downgrade); undefined when the item is gone. */
  async recomputeTrust(
    agentId: string,
    itemId: string,
    trustOf: AssistantTrustLookup,
    now = Date.now()
  ): Promise<AssistantTrust | undefined> {
    return await this.db.transaction(async (tx) => {
      if (!(await lockItem(tx, agentId, itemId))) return undefined
      return await recomputeTrust(tx, agentId, itemId, trustOf, now)
    })
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

  /** CAS on `version`: a stale writer gets the current item back instead of an exception. */
  async transition(
    agentId: string,
    itemId: string,
    expectedVersion: number,
    patch: AssistantItemPatch,
    now = Date.now()
  ): Promise<AssistantTransitionResult> {
    const sets: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.status !== undefined) {
      checkStatus(patch.status)
      set('status', patch.status)
    }
    if (patch.nextCheck !== undefined) {
      checkNextCheck(patch.nextCheck ?? undefined)
      set('nextCheck', patch.nextCheck)
    }
    if (patch.title !== undefined) {
      checkText('title', patch.title, ASSISTANT_ITEM_LIMITS.title, true)
      set('title', patch.title)
    }
    if (patch.doneWhen !== undefined) {
      checkText('doneWhen', patch.doneWhen ?? undefined, ASSISTANT_ITEM_LIMITS.doneWhen)
      set('doneWhen', patch.doneWhen)
    }
    if (patch.summary !== undefined) {
      checkText('summary', patch.summary, ASSISTANT_ITEM_LIMITS.summary)
      set('summary', patch.summary)
    }
    if (sets.length === 0) throw new Error('assistant item transition needs at least one field')
    const { changes } = await this.db.query(
      `UPDATE assistant_item SET ${sets.join(', ')}, version = version + 1, updatedAt = ?
       WHERE agentId = ? AND id = ? AND version = ?`,
      [...params, now, agentId, itemId, expectedVersion]
    )
    const item = await this.get(agentId, itemId)
    if (!item) return { ok: false, reason: 'not_found' }
    if (changes === 0) return { ok: false, reason: 'conflict', current: item }
    return { ok: true, item }
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

  /** An editor removing one item; the item row goes first, so a concurrent child write waits on it and then finds nothing. */
  async delete(agentId: string, itemId: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const { changes } = await tx.query('DELETE FROM assistant_item WHERE agentId = ? AND id = ?', [agentId, itemId])
      for (const table of CHILD_TABLES)
        await tx.query(`DELETE FROM ${table} WHERE agentId = ? AND itemId = ?`, [agentId, itemId])
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

  private async withChildren(agentId: string, rows: ItemRow[]): Promise<AssistantItemOverview[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const marks = ids.map(() => '?').join(', ')
    const followers = (
      await this.db.query(
        `SELECT itemId, identity, platform, channel, transportScope FROM assistant_item_follower
         WHERE agentId = ? AND itemId IN (${marks}) ORDER BY addedAt, identity, platform, channel, transportScope`,
        [agentId, ...ids]
      )
    ).rows as FollowerRow[]
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
      followers: followers
        .filter((f) => f.itemId === row.id)
        .map((f) => ({ identity: f.identity, place: placeOf(f.platform, f.channel, f.transportScope) })),
      origin: placeOf(row.originPlatform, row.originChannel, row.originTransportScope),
      trust: row.trust,
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

const CHILD_TABLES = ['assistant_item_follower', 'assistant_item_observation', 'assistant_item_link'] as const

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

async function insertFollower(
  tx: StoreTx,
  agentId: string,
  itemId: string,
  follower: AssistantFollower,
  now: number
): Promise<boolean> {
  const { changes } = await tx.query(
    `INSERT OR IGNORE INTO assistant_item_follower (itemId, agentId, identity, platform, channel, transportScope, addedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [itemId, agentId, follower.identity, follower.place.platform, follower.place.channel, scopeOf(follower.place), now]
  )
  return changes > 0
}

// A fresh statement after the row lock, so it sees every follower a transaction committed before this one got the lock.
async function recomputeTrust(
  tx: StoreTx,
  agentId: string,
  itemId: string,
  trustOf: AssistantTrustLookup,
  now: number
): Promise<AssistantTrust> {
  const origin = (
    await tx.query(
      'SELECT originPlatform, originChannel, originTransportScope, trust FROM assistant_item WHERE agentId = ? AND id = ?',
      [agentId, itemId]
    )
  ).rows[0] as Pick<ItemRow, 'originPlatform' | 'originChannel' | 'originTransportScope' | 'trust'>
  const followers = (
    await tx.query(
      'SELECT DISTINCT platform, channel, transportScope FROM assistant_item_follower WHERE agentId = ? AND itemId = ?',
      [agentId, itemId]
    )
  ).rows as Omit<FollowerRow, 'itemId' | 'identity'>[]
  const places = [
    placeOf(origin.originPlatform, origin.originChannel, origin.originTransportScope),
    ...followers.map((f) => placeOf(f.platform, f.channel, f.transportScope))
  ]
  const trust = lowestTrust(places, trustOf)
  if (trust !== origin.trust)
    await tx.query('UPDATE assistant_item SET trust = ?, updatedAt = ? WHERE agentId = ? AND id = ?', [
      trust,
      now,
      agentId,
      itemId
    ])
  return trust
}

// Stored as '' like append_reservation and thread_participation, so equality needs no NULL handling.
const scopeOf = (place: AssistantPlace): string => place.transportScope ?? ''

const placeOf = (platform: string, channel: string, transportScope: string): AssistantPlace => ({
  platform,
  channel,
  transportScope: transportScope === '' ? null : transportScope
})

function dedupeFollowers(followers: AssistantFollower[]): AssistantFollower[] {
  const seen = new Set<string>()
  return followers.filter((f) => {
    const key = [f.identity, f.place.platform, f.place.channel, scopeOf(f.place)].join('\0')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const IDENTITY_PATTERN = /^(user:[^:\s]+|[^:\s]+:[^\s]*:[^\s]+)$/

function checkFollower(follower: AssistantFollower): void {
  checkText('identity', follower.identity, ASSISTANT_ITEM_LIMITS.identity, true)
  if (!IDENTITY_PATTERN.test(follower.identity))
    throw new Error("assistant item follower identity must be '<platform>:<scope>:<uid>' or 'user:<id>'")
  checkPlace(follower.place)
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
