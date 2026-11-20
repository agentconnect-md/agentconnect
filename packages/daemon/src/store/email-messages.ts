// The mail index (email-integration.md §5.6): each message an agent's address received or sent, the thread and conversation it belongs to, and a sent one's delivery outcome.
import type { StoreQueryResult } from './store-database.js'

export const EMAIL_MESSAGE_SCHEMA = `
      -- One row a message, keyed by the agent's address; messageId is NULL for a sent mail whose provider id was not returned, and bodies stay in the transcript.
      CREATE TABLE IF NOT EXISTS email_message (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        messageId TEXT,
        thread TEXT NOT NULL,
        conversation TEXT NOT NULL,
        direction TEXT NOT NULL,
        mail TEXT,
        ts TEXT,
        outcome TEXT,
        reason TEXT,
        createdAt INTEGER NOT NULL,
        UNIQUE (address, messageId)
      );
      CREATE INDEX IF NOT EXISTS email_message_thread ON email_message (address, conversation, thread, seq);
`

/** Whether a sent mail reached the provider: `sent`, `unsent` (the provider never took it), or `unknown` (it may have landed). */
export type EmailDeliveryOutcome = 'sent' | 'unsent' | 'unknown'

export interface EmailMessageRow {
  seq: number
  /** The agent address whose mailbox the message is in. */
  address: string
  messageId?: string
  thread: string
  conversation: string
  direction: 'received' | 'sent'
  /** A received mail's header fields as JSON (addresses, subject, chain and the relay's ticket), which the fence and a reply read. */
  mail?: string
  /** The key of the message's row in the session's transcript. */
  ts?: string
  outcome?: EmailDeliveryOutcome
  /** Why a sent mail was not delivered, or may not have been. */
  reason?: string
  createdAt: number
}

/** One thread of a conversation: its first message and how many it holds. */
export interface EmailThreadSummary {
  thread: string
  first: number
  count: number
}

export interface EmailMessageDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function rowOf(row: Row): EmailMessageRow {
  const [messageId, mail, ts, reason] = [text(row.messageId), text(row.mail), text(row.ts), text(row.reason)]
  const outcome = text(row.outcome) as EmailDeliveryOutcome | undefined
  return {
    seq: Number(row.seq),
    address: String(row.address),
    ...(messageId ? { messageId } : {}),
    thread: String(row.thread),
    conversation: String(row.conversation),
    direction: row.direction === 'sent' ? 'sent' : 'received',
    ...(mail ? { mail } : {}),
    ...(ts ? { ts } : {}),
    ...(outcome ? { outcome } : {}),
    ...(reason ? { reason } : {}),
    createdAt: Number(row.createdAt)
  }
}

export class EmailMessages {
  constructor(private readonly db: EmailMessageDatabase) {}

  /** Record one message; a message ID already recorded for the address keeps its first row, and false says so. */
  async record(row: Omit<EmailMessageRow, 'seq'>): Promise<boolean> {
    const result = await this.db.query(
      `INSERT OR IGNORE INTO email_message
         (address, messageId, thread, conversation, direction, mail, ts, outcome, reason, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.address,
        row.messageId ?? null,
        row.thread,
        row.conversation,
        row.direction,
        row.mail ?? null,
        row.ts ?? null,
        row.outcome ?? null,
        row.reason ?? null,
        row.createdAt
      ]
    )
    return result.changes > 0
  }

  /** The message an address received or sent under this ID. */
  async get(address: string, messageId: string): Promise<EmailMessageRow | undefined> {
    const { rows } = await this.db.query('SELECT * FROM email_message WHERE address = ? AND messageId = ?', [
      address,
      messageId
    ])
    return rows[0] ? rowOf(rows[0] as Row) : undefined
  }

  /** The first sent message of a thread, which for a started thread is the mail the agent started (§6.4). */
  async firstSent(address: string, thread: string): Promise<EmailMessageRow | undefined> {
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND thread = ? AND direction = 'sent' ORDER BY seq ASC LIMIT 1`,
      [address, thread]
    )
    return rows[0] ? rowOf(rows[0] as Row) : undefined
  }

  /** The first received message of a conversation, whose sender opened it. */
  async firstReceived(address: string, conversation: string): Promise<EmailMessageRow | undefined> {
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND conversation = ? AND direction = 'received'
        ORDER BY seq ASC LIMIT 1`,
      [address, conversation]
    )
    return rows[0] ? rowOf(rows[0] as Row) : undefined
  }

  /** The latest received message of a conversation, or of one thread of it. */
  async latestReceived(address: string, conversation: string, thread?: string): Promise<EmailMessageRow | undefined> {
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND conversation = ? AND direction = 'received'
         ${thread === undefined ? '' : 'AND thread = ?'}
        ORDER BY seq DESC LIMIT 1`,
      [address, conversation, ...(thread === undefined ? [] : [thread])]
    )
    return rows[0] ? rowOf(rows[0] as Row) : undefined
  }

  /** Every received row of one thread within one conversation: the admitted mail its senders wrote. */
  async receivedInThread(address: string, conversation: string, thread: string): Promise<EmailMessageRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND conversation = ? AND thread = ? AND direction = 'received'
        ORDER BY seq ASC`,
      [address, conversation, thread]
    )
    return (rows as Row[]).map(rowOf)
  }

  /** Every received row of a started thread and of its recipients' own threads (§5.2), oldest first; a tag is base32, so no pattern character needs escaping. */
  async receivedForStarted(address: string, tag: string): Promise<EmailMessageRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND (thread = ? OR thread LIKE ?) AND direction = 'received'
        ORDER BY seq ASC`,
      [address, tag, `${tag}>%`]
    )
    return (rows as Row[]).map(rowOf)
  }

  /** One thread's messages within one conversation, oldest first, and whether more exist past `limit`. */
  async threadMessages(
    address: string,
    conversation: string,
    thread: string,
    limit: number
  ): Promise<{ rows: EmailMessageRow[]; more: boolean }> {
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND conversation = ? AND thread = ? ORDER BY seq ASC LIMIT ?`,
      [address, conversation, thread, limit + 1]
    )
    const all = (rows as Row[]).map(rowOf)
    return { rows: all.slice(0, limit), more: all.length > limit }
  }

  /** A conversation's threads by their first message, newest first; `before` pages past a first message already seen. */
  async threads(
    address: string,
    conversation: string,
    page: { before?: number; limit: number }
  ): Promise<EmailThreadSummary[]> {
    const { rows } = await this.db.query(
      `SELECT thread, MIN(seq) AS lowest, COUNT(*) AS n FROM email_message
        WHERE address = ? AND conversation = ?
        GROUP BY thread
        ${page.before === undefined ? '' : 'HAVING MIN(seq) < ?'}
        ORDER BY lowest DESC LIMIT ?`,
      [address, conversation, ...(page.before === undefined ? [] : [page.before]), page.limit]
    )
    return (rows as Row[]).map((row) => ({
      thread: String(row.thread),
      first: Number(row.lowest),
      count: Number(row.n)
    }))
  }

  /** The rows with these sequence numbers in one conversation, oldest first. */
  async bySeq(address: string, conversation: string, seqs: readonly number[]): Promise<EmailMessageRow[]> {
    if (seqs.length === 0) return []
    const { rows } = await this.db.query(
      `SELECT * FROM email_message WHERE address = ? AND conversation = ? AND seq IN (${seqs.map(() => '?').join(', ')})
        ORDER BY seq ASC`,
      [address, conversation, ...seqs]
    )
    return (rows as Row[]).map(rowOf)
  }
}
