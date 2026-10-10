// Assistant-mode reminders (assistant-mode.md §5.9): text the daemon posts into a conversation at a set time, with no model turn; partitioned by agent.
import { AsyncMutex } from './async-mutex.js'
import type { AssistantPlace } from './assistant-items.js'
import type { StoreQueryResult } from './store-database.js'

export const ASSISTANT_REMINDER_STATUSES = [
  'pending',
  'delivering',
  'delivered',
  'drafted',
  'failed',
  'expired',
  'cancelled'
] as const
export type AssistantReminderStatus = (typeof ASSISTANT_REMINDER_STATUSES)[number]

/** Reminders an agent may hold pending at once. */
export const ASSISTANT_REMINDER_PENDING_MAX = 100
/** How far ahead a reminder may be set. */
export const ASSISTANT_REMINDER_HORIZON_MS = 366 * 24 * 60 * 60_000
/** A reminder more overdue than this when it could first be delivered (after a pause) expires instead. */
export const ASSISTANT_REMINDER_LATE_MAX_MS = 24 * 60 * 60_000
/** Platform errors a reminder survives before it fails. */
export const ASSISTANT_REMINDER_MAX_ATTEMPTS = 3
/** A claim older than this was cut short by a restart or a handover, so it may have posted and is never posted again. */
export const ASSISTANT_REMINDER_CLAIM_STALE_MS = 10 * 60_000

export interface AssistantReminder {
  id: string
  agentId: string
  /** The conversation it was set in and posts into (§5.2). */
  place: AssistantPlace
  integrationId: string
  /** The setting session's coordinate, the lineage its post is recorded under. */
  thread: string
  /** The platform thread the text lands in, where that session's replies land; null posts at the root. */
  targetThread: string | null
  targetDm: boolean
  message: string
  dueAt: number
  status: AssistantReminderStatus
  /** Delivery attempts so far; a platform error releases the claim until {@link ASSISTANT_REMINDER_MAX_ATTEMPTS}. */
  attempts: number
  /** The platform user whose message set it, a draft's approver if the place turned external. */
  requesterId: string | null
  messageId: string | null
  draftId: string | null
  failure: string | null
  createdAt: number
  updatedAt: number
  settledAt: number | null
}

export interface AssistantReminderCreate {
  id: string
  agentId: string
  place: AssistantPlace
  integrationId: string
  thread: string
  targetThread: string | null
  targetDm: boolean
  message: string
  dueAt: number
  requesterId: string | null
  now: number
}

export const ASSISTANT_REMINDER_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_reminder (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        platform TEXT NOT NULL,
        integrationId TEXT NOT NULL,
        channel TEXT NOT NULL,
        transportScope TEXT NOT NULL DEFAULT '',
        thread TEXT NOT NULL,
        targetThread TEXT,
        targetDm INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        dueAt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'drafted', 'failed',
          'expired', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        claimedAt INTEGER,
        requesterId TEXT,
        messageId TEXT,
        draftId TEXT,
        failure TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        settledAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS assistant_reminder_due ON assistant_reminder (agentId, status, dueAt);
      CREATE INDEX IF NOT EXISTS assistant_reminder_by_place
        ON assistant_reminder (agentId, platform, channel, transportScope, status);
`

export interface AssistantReminderDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
// Stored as '' like the item ledger's places, so equality needs no NULL handling.
const scopeOf = (place: AssistantPlace): string => place.transportScope ?? ''

function reminderOf(row: Row): AssistantReminder {
  const scope = String(row.transportScope ?? '')
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    place: {
      platform: String(row.platform),
      channel: String(row.channel),
      transportScope: scope === '' ? null : scope
    },
    integrationId: String(row.integrationId),
    thread: String(row.thread),
    targetThread: str(row.targetThread),
    targetDm: Number(row.targetDm) === 1,
    message: String(row.message),
    dueAt: Number(row.dueAt),
    status: String(row.status) as AssistantReminderStatus,
    attempts: Number(row.attempts),
    requesterId: str(row.requesterId),
    messageId: str(row.messageId),
    draftId: str(row.draftId),
    failure: str(row.failure),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    settledAt: num(row.settledAt)
  }
}

/** Pending, or claimed and about to post: what still counts toward the cap and what the conversation lists. */
const OPEN = "('pending', 'delivering')"

export class AssistantReminderLedger {
  // Reminders are set only on the agent's duty holder, so serializing this process's capped inserts makes each a check-and-insert.
  private readonly creating = new AsyncMutex()

  constructor(private readonly db: AssistantReminderDatabase) {}

  /** Record a reminder while the agent holds fewer than `limit` open ones; undefined at the cap. */
  async create(
    input: AssistantReminderCreate,
    limit = ASSISTANT_REMINDER_PENDING_MAX
  ): Promise<AssistantReminder | undefined> {
    return await this.creating.run(async () => {
      const { changes } = await this.db.query(
        `INSERT INTO assistant_reminder (id, agentId, platform, integrationId, channel, transportScope, thread,
           targetThread, targetDm, message, dueAt, status, attempts, requesterId, createdAt, updatedAt)
         SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT),
           CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS INTEGER), CAST(? AS TEXT), CAST(? AS INTEGER), 'pending', 0,
           CAST(? AS TEXT), CAST(? AS INTEGER), CAST(? AS INTEGER)
          WHERE (SELECT COUNT(*) FROM assistant_reminder WHERE agentId = ? AND status IN ${OPEN}) < ?`,
        [
          input.id,
          input.agentId,
          input.place.platform,
          input.integrationId,
          input.place.channel,
          scopeOf(input.place),
          input.thread,
          input.targetThread,
          input.targetDm ? 1 : 0,
          input.message,
          input.dueAt,
          input.requesterId,
          input.now,
          input.now,
          input.agentId,
          limit
        ]
      )
      return changes > 0 ? await this.get(input.agentId, input.id) : undefined
    })
  }

  async get(agentId: string, id: string): Promise<AssistantReminder | undefined> {
    const row = (await this.db.query('SELECT * FROM assistant_reminder WHERE agentId = ? AND id = ?', [agentId, id]))
      .rows[0] as Row | undefined
    return row ? reminderOf(row) : undefined
  }

  /** The open reminders set in one conversation, soonest first. */
  async listOpen(
    agentId: string,
    place: AssistantPlace,
    limit = ASSISTANT_REMINDER_PENDING_MAX
  ): Promise<AssistantReminder[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_reminder
          WHERE agentId = ? AND platform = ? AND channel = ? AND transportScope = ? AND status IN ${OPEN}
          ORDER BY dueAt, id LIMIT ?`,
        [agentId, place.platform, place.channel, scopeOf(place), limit]
      )
    ).rows as Row[]
    return rows.map(reminderOf)
  }

  /** Cancel a pending reminder of this conversation; the reminder as it stands after, undefined when the conversation has none by that id. */
  async cancel(
    agentId: string,
    id: string,
    place: AssistantPlace,
    now: number
  ): Promise<AssistantReminder | undefined> {
    await this.db.query(
      `UPDATE assistant_reminder SET status = 'cancelled', settledAt = ?, updatedAt = ?
        WHERE agentId = ? AND id = ? AND platform = ? AND channel = ? AND transportScope = ? AND status = 'pending'`,
      [now, now, agentId, id, place.platform, place.channel, scopeOf(place)]
    )
    const reminder = await this.get(agentId, id)
    const here =
      reminder?.place.platform === place.platform &&
      reminder.place.channel === place.channel &&
      scopeOf(reminder.place) === scopeOf(place)
    return here ? reminder : undefined
  }

  /** Pending reminders due by `now`, soonest first. */
  async due(agentId: string, now: number, limit: number): Promise<AssistantReminder[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_reminder WHERE agentId = ? AND status = 'pending' AND dueAt <= ?
          ORDER BY dueAt, id LIMIT ?`,
        [agentId, now, limit]
      )
    ).rows as Row[]
    return rows.map(reminderOf)
  }

  /** Expire pending reminders due before `before`; how many expired. */
  async expireOverdue(agentId: string, before: number, now: number): Promise<number> {
    const { changes } = await this.db.query(
      `UPDATE assistant_reminder SET status = 'expired', settledAt = ?, updatedAt = ?
        WHERE agentId = ? AND status = 'pending' AND dueAt < ?`,
      [now, now, agentId, before]
    )
    return changes
  }

  /** Fail claims older than `claimedBefore`: cut short mid-post, so never posted again. Returns their ids. */
  async failStaleClaims(agentId: string, claimedBefore: number, now: number): Promise<string[]> {
    const rows = (
      await this.db.query(
        `UPDATE assistant_reminder SET status = 'failed', failure = ?, settledAt = ?, updatedAt = ?
          WHERE agentId = ? AND status = 'delivering' AND claimedAt < ? RETURNING id`,
        ['cut short while posting; it may have been posted and is not posted again', now, now, agentId, claimedBefore]
      )
    ).rows as Row[]
    return rows.map((row) => String(row.id))
  }

  /** Take a pending reminder for one delivery attempt, returning its number; undefined when another sweep took it or it was cancelled. */
  async claim(agentId: string, id: string, now: number): Promise<number | undefined> {
    const row = (
      await this.db.query(
        `UPDATE assistant_reminder SET status = 'delivering', attempts = attempts + 1, claimedAt = ?, updatedAt = ?
          WHERE agentId = ? AND id = ? AND status = 'pending' RETURNING attempts`,
        [now, now, agentId, id]
      )
    ).rows[0] as Row | undefined
    return row ? Number(row.attempts) : undefined
  }

  /** Settle a claimed reminder: posted, drafted for approval, or failed for good. */
  async settle(
    agentId: string,
    id: string,
    outcome:
      | { status: 'delivered'; messageId: string | null }
      | { status: 'drafted'; draftId: string }
      | { status: 'failed'; failure: string },
    now: number
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_reminder SET status = ?, messageId = ?, draftId = ?, failure = ?, settledAt = ?, updatedAt = ?
        WHERE agentId = ? AND id = ? AND status = 'delivering'`,
      [
        outcome.status,
        outcome.status === 'delivered' ? outcome.messageId : null,
        outcome.status === 'drafted' ? outcome.draftId : null,
        outcome.status === 'failed' ? outcome.failure : null,
        now,
        now,
        agentId,
        id
      ]
    )
    return changes > 0
  }

  /** A platform error: the claim is released, so a later sweep tries again. */
  async release(agentId: string, id: string, failure: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_reminder SET status = 'pending', claimedAt = NULL, failure = ?, updatedAt = ?
        WHERE agentId = ? AND id = ? AND status = 'delivering'`,
      [failure, now, agentId, id]
    )
    return changes > 0
  }

  async deleteForAgent(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_reminder WHERE agentId = ?', [agentId])).changes
  }
}
