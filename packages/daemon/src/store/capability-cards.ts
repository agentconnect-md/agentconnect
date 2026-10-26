// The capability cards this daemon posted (capability-requests.md §4.4.6), kept so a restart can still rewrite them when their request settles.
import type { StoreQueryResult } from './store-database.js'

/** A settled card's row is kept this long when its rewrite never succeeded. */
export const CAPABILITY_CARD_RETENTION_MS = 7 * 24 * 60 * 60_000

export const CAPABILITY_CARD_SCHEMA = `
      CREATE TABLE IF NOT EXISTS capability_card (
        cardId TEXT PRIMARY KEY,
        requestId TEXT NOT NULL,
        generation INTEGER NOT NULL,
        agentId TEXT NOT NULL,
        sessionKey TEXT NOT NULL,         -- the origin session the card was posted for, wherever it landed
        integrationId TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT,
        ts TEXT NOT NULL,
        modelJson TEXT NOT NULL,          -- what the card shows, so a rewrite needs nothing else
        postedAt INTEGER NOT NULL,
        settledAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS capability_card_request ON capability_card (requestId, sessionKey);
`

/** What a card shows besides its ids, as stored for its rewrite. */
export interface CapabilityCardView {
  summary: string
  reason: string
  link: string
  agentName: string
  context?: string
}

export interface CapabilityCardRow {
  cardId: string
  requestId: string
  generation: number
  agentId: string
  sessionKey: string
  integrationId: string
  platform: string
  channel: string
  thread: string | null
  ts: string
  view: CapabilityCardView
  postedAt: number
  settledAt: number | null
}

interface CapabilityCardDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

function parseView(json: unknown): CapabilityCardView {
  try {
    const parsed = JSON.parse(String(json)) as Partial<CapabilityCardView>
    return {
      summary: String(parsed.summary ?? ''),
      reason: String(parsed.reason ?? ''),
      link: String(parsed.link ?? ''),
      agentName: String(parsed.agentName ?? ''),
      ...(parsed.context ? { context: String(parsed.context) } : {})
    }
  } catch {
    return { summary: '', reason: '', link: '', agentName: '' }
  }
}

function fromRow(row: Row): CapabilityCardRow {
  return {
    cardId: String(row.cardId),
    requestId: String(row.requestId),
    generation: Number(row.generation),
    agentId: String(row.agentId),
    sessionKey: String(row.sessionKey),
    integrationId: String(row.integrationId),
    platform: String(row.platform),
    channel: String(row.channel),
    thread: row.thread === null || row.thread === undefined ? null : String(row.thread),
    ts: String(row.ts),
    view: parseView(row.modelJson),
    postedAt: Number(row.postedAt),
    settledAt: row.settledAt === null || row.settledAt === undefined ? null : Number(row.settledAt)
  }
}

const COLUMNS =
  'cardId, requestId, generation, agentId, sessionKey, integrationId, platform, channel, thread, ts, modelJson, postedAt, settledAt'

export class CapabilityCardLedger {
  constructor(private readonly db: CapabilityCardDatabase) {}

  async record(card: Omit<CapabilityCardRow, 'settledAt'>): Promise<void> {
    await this.db.query(`INSERT INTO capability_card (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [
      card.cardId,
      card.requestId,
      card.generation,
      card.agentId,
      card.sessionKey,
      card.integrationId,
      card.platform,
      card.channel,
      card.thread,
      card.ts,
      JSON.stringify(card.view),
      card.postedAt
    ])
  }

  async get(cardId: string): Promise<CapabilityCardRow | undefined> {
    const row = (await this.db.query(`SELECT ${COLUMNS} FROM capability_card WHERE cardId = ?`, [cardId])).rows[0]
    return row ? fromRow(row as Row) : undefined
  }

  /** Every card of a request, or only those posted for one origin session. */
  async forRequest(requestId: string, sessionKey?: string): Promise<CapabilityCardRow[]> {
    const rows = sessionKey
      ? await this.db.query(
          `SELECT ${COLUMNS} FROM capability_card WHERE requestId = ? AND sessionKey = ? ORDER BY postedAt`,
          [requestId, sessionKey]
        )
      : await this.db.query(`SELECT ${COLUMNS} FROM capability_card WHERE requestId = ? ORDER BY postedAt`, [requestId])
    return (rows.rows as Row[]).map(fromRow)
  }

  /** The open cards posted as one message of a conversation: what a reply to that message may decline. */
  async atMessage(channel: string, ts: string): Promise<CapabilityCardRow[]> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM capability_card WHERE channel = ? AND ts = ? AND settledAt IS NULL`,
      [channel, ts]
    )
    return (rows.rows as Row[]).map(fromRow)
  }

  /** A reopened request's cards carry its new generation in their Decline control. */
  async setGeneration(cardId: string, generation: number): Promise<void> {
    await this.db.query('UPDATE capability_card SET generation = ?, settledAt = NULL WHERE cardId = ?', [
      generation,
      cardId
    ])
  }

  /** A card whose rewrite did not go through is kept, marked settled, until the sweep drops it. */
  async markSettled(cardId: string, now: number): Promise<void> {
    await this.db.query('UPDATE capability_card SET settledAt = ? WHERE cardId = ? AND settledAt IS NULL', [
      now,
      cardId
    ])
  }

  async drop(cardId: string): Promise<void> {
    await this.db.query('DELETE FROM capability_card WHERE cardId = ?', [cardId])
  }

  /** Rows settled more than {@link CAPABILITY_CARD_RETENTION_MS} ago, and open rows of a request older than that. */
  async sweep(now: number): Promise<number> {
    const cutoff = now - CAPABILITY_CARD_RETENTION_MS
    const result = await this.db.query(
      'DELETE FROM capability_card WHERE (settledAt IS NOT NULL AND settledAt < ?) OR postedAt < ?',
      [cutoff, now - 2 * CAPABILITY_CARD_RETENTION_MS]
    )
    return result.changes
  }
}
