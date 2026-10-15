// Session messages (send-message-guide.md §9.3): each one a session received, with its reply obligation, and each one it sent.
import { randomUUID } from 'node:crypto'
import type { StoreQueryResult } from './store-database.js'

/** What a session message is: a call, a task's input from its owner, a reply, or a task's round report. */
export type SessionMessageKind = 'call' | 'taskInput' | 'reply' | 'report'
export const SESSION_MESSAGE_KINDS: readonly SessionMessageKind[] = ['call', 'taskInput', 'reply', 'report']

/** A message's reply obligation: none asked, open until the first delivered reply, then settled. */
export type SessionMessageReplyState = 'none' | 'open' | 'replied' | 'failed'

/** One message a session received, recorded by the receiving daemon at admission. */
export interface ReceivedSessionMessage {
  messageId: string
  /** The only session that may answer it, by key and agent. */
  recipientKey: string
  recipientAgentId: string
  /** The sending session's outward id and agent. */
  sourceSessionId: string
  sourceAgentId: string
  /** The sending session's landing coordinates, for a reply into another daemon. */
  sourcePlatform?: string
  sourceChannel?: string
  sourceThread?: string
  /** The source turn's code-host reply snapshot, as JSON. */
  codeHostReplyTarget?: string
  kind: SessionMessageKind
  /** For a reply, the message it answers. */
  inReplyTo?: string
  replyState: SessionMessageReplyState
  /** An explicit reply to it failed, so the daemon infers none. */
  replyFailed?: boolean
  hopCount: number
  /** Synthesized from a session origin or a delivery that carried no id, so its reply takes the pre-id route. */
  legacy?: boolean
  createdAt: number
}

/** One message a session sent, recorded by the sending daemon: a reply to it is accepted only into that session. */
export interface SentSessionMessage {
  messageId: string
  senderKey: string
  senderAgentId: string
  senderSessionId: string
  recipientAgentId: string
  kind: SessionMessageKind
  createdAt: number
}

export const SESSION_MESSAGE_SCHEMA = `
      CREATE TABLE IF NOT EXISTS session_message (
        messageId TEXT PRIMARY KEY,
        recipientKey TEXT NOT NULL,
        recipientAgentId TEXT NOT NULL,
        sourceSessionId TEXT NOT NULL,
        sourceAgentId TEXT NOT NULL,
        sourcePlatform TEXT,
        sourceChannel TEXT,
        sourceThread TEXT,
        codeHostReplyTarget TEXT,
        kind TEXT NOT NULL,
        inReplyTo TEXT,
        replyState TEXT NOT NULL,
        replyFailed INTEGER NOT NULL DEFAULT 0,
        hopCount INTEGER NOT NULL DEFAULT 0,
        legacy INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        settledAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS session_message_by_recipient ON session_message (recipientKey, createdAt);
      CREATE INDEX IF NOT EXISTS session_message_by_source ON session_message (sourceSessionId);
      CREATE INDEX IF NOT EXISTS session_message_by_recipient_agent ON session_message (recipientAgentId);
      CREATE TABLE IF NOT EXISTS session_message_sent (
        messageId TEXT PRIMARY KEY,
        senderKey TEXT NOT NULL,
        senderAgentId TEXT NOT NULL,
        senderSessionId TEXT NOT NULL,
        recipientAgentId TEXT NOT NULL,
        kind TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_message_sent_by_sender ON session_message_sent (senderKey);
      CREATE INDEX IF NOT EXISTS session_message_sent_by_agent ON session_message_sent (senderAgentId);
`

export interface SessionMessageDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

const text = (value: unknown): string | undefined => (value == null ? undefined : String(value))

function receivedOf(row: Row): ReceivedSessionMessage {
  const optional = (key: string) => (text(row[key]) !== undefined ? { [key]: String(row[key]) } : {})
  return {
    messageId: String(row.messageId),
    recipientKey: String(row.recipientKey),
    recipientAgentId: String(row.recipientAgentId),
    sourceSessionId: String(row.sourceSessionId),
    sourceAgentId: String(row.sourceAgentId),
    ...optional('sourcePlatform'),
    ...optional('sourceChannel'),
    ...optional('sourceThread'),
    ...optional('codeHostReplyTarget'),
    kind: String(row.kind) as SessionMessageKind,
    ...optional('inReplyTo'),
    replyState: String(row.replyState) as SessionMessageReplyState,
    ...(Number(row.replyFailed ?? 0) === 1 ? { replyFailed: true } : {}),
    hopCount: Number(row.hopCount ?? 0),
    ...(Number(row.legacy ?? 0) === 1 ? { legacy: true } : {}),
    createdAt: Number(row.createdAt)
  }
}

function sentOf(row: Row): SentSessionMessage {
  return {
    messageId: String(row.messageId),
    senderKey: String(row.senderKey),
    senderAgentId: String(row.senderAgentId),
    senderSessionId: String(row.senderSessionId),
    recipientAgentId: String(row.recipientAgentId),
    kind: String(row.kind) as SessionMessageKind,
    createdAt: Number(row.createdAt)
  }
}

/** A fresh opaque message id: unguessable, and unique across the install. */
export function newSessionMessageId(): string {
  return `msg-${randomUUID()}`
}

export class SessionMessages {
  constructor(private readonly db: SessionMessageDatabase) {}

  /** Record a received message once; a replay for the same recipient is a duplicate, one for another a conflict. */
  async recordReceived(
    message: Omit<ReceivedSessionMessage, 'createdAt'> & { now: number }
  ): Promise<'recorded' | 'duplicate' | 'conflict'> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO session_message
         (messageId, recipientKey, recipientAgentId, sourceSessionId, sourceAgentId, sourcePlatform, sourceChannel,
          sourceThread, codeHostReplyTarget, kind, inReplyTo, replyState, replyFailed, hopCount, legacy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        message.messageId,
        message.recipientKey,
        message.recipientAgentId,
        message.sourceSessionId,
        message.sourceAgentId,
        message.sourcePlatform ?? null,
        message.sourceChannel ?? null,
        message.sourceThread ?? null,
        message.codeHostReplyTarget ?? null,
        message.kind,
        message.inReplyTo ?? null,
        message.replyState,
        message.hopCount,
        message.legacy ? 1 : 0,
        message.now
      ]
    )
    if (changes > 0) return 'recorded'
    const existing = await this.received(message.messageId)
    return existing?.recipientKey === message.recipientKey && existing.recipientAgentId === message.recipientAgentId
      ? 'duplicate'
      : 'conflict'
  }

  /** Whether the id already names a message to another recipient, which a delivery under it must not reach. */
  async conflicts(messageId: string, recipientKey: string, recipientAgentId: string): Promise<boolean> {
    const existing = await this.received(messageId)
    return (
      existing !== undefined &&
      (existing.recipientKey !== recipientKey || existing.recipientAgentId !== recipientAgentId)
    )
  }

  async received(messageId: string): Promise<ReceivedSessionMessage | undefined> {
    const row = (await this.db.query('SELECT * FROM session_message WHERE messageId = ?', [messageId])).rows[0] as
      Row | undefined
    return row ? receivedOf(row) : undefined
  }

  /** Settle one open obligation; false when it was never open or is already settled. */
  async settle(messageId: string, state: 'replied' | 'failed', now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE session_message SET replyState = ?, settledAt = ? WHERE messageId = ? AND replyState = 'open'`,
      [state, now, messageId]
    )
    return changes > 0
  }

  /** An explicit reply to the message failed, so no reply is inferred for it. */
  async noteReplyFailed(messageId: string): Promise<void> {
    await this.db.query('UPDATE session_message SET replyFailed = 1 WHERE messageId = ?', [messageId])
  }

  /** A task's round report answers every input its owner sent it so far. */
  async settleOpenFor(recipientKey: string, now: number): Promise<number> {
    const { changes } = await this.db.query(
      `UPDATE session_message SET replyState = 'replied', settledAt = ? WHERE recipientKey = ? AND replyState = 'open'`,
      [now, recipientKey]
    )
    return changes
  }

  /** The messages a session may answer: open obligations first, oldest first, then the rest newest first. */
  async listFor(recipientKey: string, limit: number): Promise<ReceivedSessionMessage[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM session_message WHERE recipientKey = ?
          ORDER BY CASE WHEN replyState = 'open' THEN 0 ELSE 1 END,
                   CASE WHEN replyState = 'open' THEN createdAt ELSE -createdAt END, messageId
          LIMIT ?`,
        [recipientKey, limit]
      )
    ).rows as Row[]
    return rows.map(receivedOf)
  }

  async countFor(recipientKey: string): Promise<number> {
    const row = (
      await this.db.query('SELECT COUNT(*) AS n FROM session_message WHERE recipientKey = ?', [recipientKey])
    ).rows[0] as Row | undefined
    return Number(row?.n ?? 0)
  }

  /** Record a message this daemon sent; a replay of the same submission records nothing new. */
  async recordSent(message: Omit<SentSessionMessage, 'createdAt'> & { now: number }): Promise<void> {
    await this.db.query(
      `INSERT OR IGNORE INTO session_message_sent
         (messageId, senderKey, senderAgentId, senderSessionId, recipientAgentId, kind, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.messageId,
        message.senderKey,
        message.senderAgentId,
        message.senderSessionId,
        message.recipientAgentId,
        message.kind,
        message.now
      ]
    )
  }

  async sent(messageId: string): Promise<SentSessionMessage | undefined> {
    const row = (await this.db.query('SELECT * FROM session_message_sent WHERE messageId = ?', [messageId])).rows[0] as
      Row | undefined
    return row ? sentOf(row) : undefined
  }

  /** A send that was refused delivered nothing, so nothing can answer it. */
  async forgetSent(messageId: string): Promise<void> {
    await this.db.query('DELETE FROM session_message_sent WHERE messageId = ?', [messageId])
  }

  async deleteForAgent(agentId: string): Promise<void> {
    await this.db.query('DELETE FROM session_message WHERE recipientAgentId = ? OR sourceAgentId = ?', [
      agentId,
      agentId
    ])
    await this.db.query('DELETE FROM session_message_sent WHERE senderAgentId = ? OR recipientAgentId = ?', [
      agentId,
      agentId
    ])
  }
}
