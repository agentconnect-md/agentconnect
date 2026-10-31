// Sticky choice cards: buttons that outlive turns and restarts; a click starts a turn in the card's thread.
import type { StoreQueryResult } from './store-database.js'

export const CHOICE_CARD_SCHEMA = `
      CREATE TABLE IF NOT EXISTS choice_card (
        cardId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        integrationId TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        ts TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        optionsJson TEXT NOT NULL,       -- [{id,label}] in button order
        editText TEXT,                   -- the editable text's starting value; NULL ⇒ no Edit
        state TEXT NOT NULL,             -- 'open' takes clicks; anything else is settled
        label TEXT,                      -- a status line an updater shows under the card
        choice TEXT,
        clickedBy TEXT,
        clickedByName TEXT,
        editedText TEXT,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER,
        decidedAt INTEGER
      );
`

export interface ChoiceCardOption {
  id: string
  label: string
}

export interface ChoiceCardRow {
  cardId: string
  agentId: string
  integrationId: string
  platform: string
  channel: string
  thread: string
  ts: string
  title: string
  body: string
  options: ChoiceCardOption[]
  editText: string | null
  state: string
  label: string | null
  choice: string | null
  clickedBy: string | null
  clickedByName: string | null
  editedText: string | null
  createdAt: number
  expiresAt: number | null
  decidedAt: number | null
}

type Row = Record<string, unknown>
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function fromRow(row: Row): ChoiceCardRow {
  let options: ChoiceCardOption[] = []
  try {
    options = JSON.parse(String(row.optionsJson)) as ChoiceCardOption[]
  } catch {
    // A corrupt row shows no buttons rather than failing every read.
  }
  return {
    cardId: String(row.cardId),
    agentId: String(row.agentId),
    integrationId: String(row.integrationId),
    platform: String(row.platform),
    channel: String(row.channel),
    thread: String(row.thread),
    ts: String(row.ts),
    title: String(row.title),
    body: String(row.body),
    options,
    editText: str(row.editText),
    state: String(row.state),
    label: str(row.label),
    choice: str(row.choice),
    clickedBy: str(row.clickedBy),
    clickedByName: str(row.clickedByName),
    editedText: str(row.editedText),
    createdAt: Number(row.createdAt),
    expiresAt: num(row.expiresAt),
    decidedAt: num(row.decidedAt)
  }
}

const COLUMNS =
  'cardId, agentId, integrationId, platform, channel, thread, ts, title, body, optionsJson, editText, state, label, choice, clickedBy, clickedByName, editedText, createdAt, expiresAt, decidedAt'

export class ChoiceCardLedger {
  constructor(private readonly db: { query(sql: string, params: unknown[]): Promise<StoreQueryResult> }) {}

  async record(card: ChoiceCardRow): Promise<void> {
    await this.db.query(
      `INSERT INTO choice_card (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        card.cardId,
        card.agentId,
        card.integrationId,
        card.platform,
        card.channel,
        card.thread,
        card.ts,
        card.title,
        card.body,
        JSON.stringify(card.options),
        card.editText,
        card.state,
        card.label,
        card.choice,
        card.clickedBy,
        card.clickedByName,
        card.editedText,
        card.createdAt,
        card.expiresAt,
        card.decidedAt
      ]
    )
  }

  async get(cardId: string): Promise<ChoiceCardRow | undefined> {
    const row = (await this.db.query(`SELECT ${COLUMNS} FROM choice_card WHERE cardId = ?`, [cardId])).rows[0]
    return row ? fromRow(row as Row) : undefined
  }

  /** First click wins: settle an open, unexpired card; false when someone else got there first. */
  async claim(
    cardId: string,
    click: { choice: string; clickedBy: string; clickedByName?: string; editedText?: string },
    now: number
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE choice_card SET state = 'decided', choice = ?, clickedBy = ?, clickedByName = ?, editedText = ?, decidedAt = ?
       WHERE cardId = ? AND state = 'open' AND (expiresAt IS NULL OR expiresAt > ?)`,
      [click.choice, click.clickedBy, click.clickedByName ?? null, click.editedText ?? null, now, cardId, now]
    )
    return result.changes === 1
  }

  /** An outside updater changes the state and status line; true when the card exists. */
  async update(cardId: string, patch: { state?: string; label?: string | null }): Promise<boolean> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.state !== undefined) {
      sets.push('state = ?')
      params.push(patch.state)
    }
    if (patch.label !== undefined) {
      sets.push('label = ?')
      params.push(patch.label)
    }
    if (sets.length === 0) return (await this.get(cardId)) !== undefined
    const result = await this.db.query(`UPDATE choice_card SET ${sets.join(', ')} WHERE cardId = ?`, [
      ...params,
      cardId
    ])
    return result.changes === 1
  }
}
