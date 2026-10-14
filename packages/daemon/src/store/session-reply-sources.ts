// The sessions each session may reply to, and the replies its callers asked for, one per admitted call (send-message-guide.md §9.3–§9.4).
import type { StoreQueryResult } from './store-database.js'

/** One admitted source of a session: the outward id it may reply into, its agent, and how to route there. */
export interface SessionReplySource {
  /** The session that may reply, by its logical key. */
  sessionKey: string
  agentId: string
  /** The source session's outward id, the `sessionId` a `replyToSession` names. */
  sourceSessionId: string
  sourceAgentId: string
  /** The source's landing coordinates, for a reply into a session on another daemon. */
  sourcePlatform?: string
  sourceChannel?: string
  sourceThread?: string
  /** The source turn's code-host reply snapshot, as JSON; absent when it had none. */
  codeHostReplyTarget?: string
  createdAt: number
  updatedAt: number
}

/** One admitted call that asked for a reply: `open` until a reply or the daemon's report answers it. */
export interface SessionReplyObligation {
  sessionKey: string
  agentId: string
  deliveryId: string
  sourceSessionId: string
  state: 'open' | 'replied' | 'failed'
  createdAt: number
}

export const SESSION_REPLY_SOURCE_SCHEMA = `
      CREATE TABLE IF NOT EXISTS session_reply_source (
        sessionKey TEXT NOT NULL,
        agentId TEXT NOT NULL,
        sourceSessionId TEXT NOT NULL,
        sourceAgentId TEXT NOT NULL,
        sourcePlatform TEXT,
        sourceChannel TEXT,
        sourceThread TEXT,
        codeHostReplyTarget TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (sessionKey, sourceSessionId)
      );
      CREATE INDEX IF NOT EXISTS session_reply_source_by_agent ON session_reply_source (agentId);
      CREATE TABLE IF NOT EXISTS session_reply_obligation (
        sessionKey TEXT NOT NULL,
        agentId TEXT NOT NULL,
        deliveryId TEXT NOT NULL,
        sourceSessionId TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        settledAt INTEGER,
        PRIMARY KEY (sessionKey, deliveryId)
      );
      CREATE INDEX IF NOT EXISTS session_reply_obligation_by_source
        ON session_reply_obligation (sessionKey, sourceSessionId, state, createdAt);
`

export interface SessionReplySourceDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

const text = (value: unknown): string | undefined => (value == null ? undefined : String(value))

function sourceOf(row: Row): SessionReplySource {
  const optional = (key: string) => (text(row[key]) !== undefined ? { [key]: String(row[key]) } : {})
  return {
    sessionKey: String(row.sessionKey),
    agentId: String(row.agentId),
    sourceSessionId: String(row.sourceSessionId),
    sourceAgentId: String(row.sourceAgentId),
    ...optional('sourcePlatform'),
    ...optional('sourceChannel'),
    ...optional('sourceThread'),
    ...optional('codeHostReplyTarget'),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  }
}

function obligationOf(row: Row): SessionReplyObligation {
  return {
    sessionKey: String(row.sessionKey),
    agentId: String(row.agentId),
    deliveryId: String(row.deliveryId),
    sourceSessionId: String(row.sourceSessionId),
    state: String(row.state) as SessionReplyObligation['state'],
    createdAt: Number(row.createdAt)
  }
}

export class SessionReplySources {
  constructor(private readonly db: SessionReplySourceDatabase) {}

  /** Add a source, or refresh its routing; true when it is new. An earlier source is never replaced. */
  async record(source: Omit<SessionReplySource, 'createdAt' | 'updatedAt'> & { now: number }): Promise<boolean> {
    const routing = [
      source.sourcePlatform ?? null,
      source.sourceChannel ?? null,
      source.sourceThread ?? null,
      source.codeHostReplyTarget ?? null
    ]
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO session_reply_source
         (sessionKey, agentId, sourceSessionId, sourceAgentId, sourcePlatform, sourceChannel, sourceThread,
          codeHostReplyTarget, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.sessionKey,
        source.agentId,
        source.sourceSessionId,
        source.sourceAgentId,
        ...routing,
        source.now,
        source.now
      ]
    )
    if (changes > 0) return true
    // The same source again: its latest routing wins, and its agent never changes.
    await this.db.query(
      `UPDATE session_reply_source
          SET sourcePlatform = COALESCE(?, sourcePlatform), sourceChannel = COALESCE(?, sourceChannel),
              sourceThread = COALESCE(?, sourceThread), codeHostReplyTarget = COALESCE(?, codeHostReplyTarget), updatedAt = ?
        WHERE sessionKey = ? AND sourceSessionId = ? AND sourceAgentId = ?`,
      [...routing, source.now, source.sessionKey, source.sourceSessionId, source.sourceAgentId]
    )
    return false
  }

  async get(sessionKey: string, sourceSessionId: string): Promise<SessionReplySource | undefined> {
    const row = (
      await this.db.query('SELECT * FROM session_reply_source WHERE sessionKey = ? AND sourceSessionId = ?', [
        sessionKey,
        sourceSessionId
      ])
    ).rows[0] as Row | undefined
    return row ? sourceOf(row) : undefined
  }

  /** The session's sources, most recently admitted first, at most `limit`. */
  async list(sessionKey: string, limit: number): Promise<SessionReplySource[]> {
    const rows = (
      await this.db.query(
        'SELECT * FROM session_reply_source WHERE sessionKey = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT ?',
        [sessionKey, limit]
      )
    ).rows as Row[]
    return rows.map(sourceOf)
  }

  async count(sessionKey: string): Promise<number> {
    const row = (
      await this.db.query('SELECT COUNT(*) AS n FROM session_reply_source WHERE sessionKey = ?', [sessionKey])
    ).rows[0] as Row | undefined
    return Number(row?.n ?? 0)
  }

  /** Record one admitted call's request for a reply; a duplicate admission of the same call adds nothing. */
  async openObligation(input: Omit<SessionReplyObligation, 'state' | 'createdAt'> & { now: number }): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO session_reply_obligation (sessionKey, agentId, deliveryId, sourceSessionId, state, createdAt)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [input.sessionKey, input.agentId, input.deliveryId, input.sourceSessionId, input.now]
    )
    return changes > 0
  }

  async obligation(sessionKey: string, deliveryId: string): Promise<SessionReplyObligation | undefined> {
    const row = (
      await this.db.query('SELECT * FROM session_reply_obligation WHERE sessionKey = ? AND deliveryId = ?', [
        sessionKey,
        deliveryId
      ])
    ).rows[0] as Row | undefined
    return row ? obligationOf(row) : undefined
  }

  /** Answer one open obligation; false when it was already answered or never recorded. */
  async settle(sessionKey: string, deliveryId: string, state: 'replied' | 'failed', now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE session_reply_obligation SET state = ?, settledAt = ?
        WHERE sessionKey = ? AND deliveryId = ? AND state = 'open'`,
      [state, now, sessionKey, deliveryId]
    )
    return changes > 0
  }

  /** A reply to `sourceSessionId` answers one of its open requests: one of `preferred` if open, else its oldest. */
  async settleOneFor(
    sessionKey: string,
    sourceSessionId: string,
    preferred: readonly string[],
    now: number
  ): Promise<string | undefined> {
    const open = await this.openFor(sessionKey, sourceSessionId)
    const chosen = open.find((row) => preferred.includes(row.deliveryId)) ?? open[0]
    if (!chosen) return undefined
    return (await this.settle(sessionKey, chosen.deliveryId, 'replied', now)) ? chosen.deliveryId : undefined
  }

  /** The source's open requests on this session, oldest first. */
  async openFor(sessionKey: string, sourceSessionId: string): Promise<SessionReplyObligation[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM session_reply_obligation WHERE sessionKey = ? AND sourceSessionId = ? AND state = 'open'
          ORDER BY createdAt, deliveryId`,
        [sessionKey, sourceSessionId]
      )
    ).rows as Row[]
    return rows.map(obligationOf)
  }

  /** Every open request on this session, oldest first. */
  async open(sessionKey: string): Promise<SessionReplyObligation[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM session_reply_obligation WHERE sessionKey = ? AND state = 'open' ORDER BY createdAt, deliveryId`,
        [sessionKey]
      )
    ).rows as Row[]
    return rows.map(obligationOf)
  }

  /** Whether any call to this session asked for a reply since requests were tracked per call. */
  async tracked(sessionKey: string): Promise<boolean> {
    const rows = (
      await this.db.query('SELECT 1 AS found FROM session_reply_obligation WHERE sessionKey = ? LIMIT 1', [sessionKey])
    ).rows
    return rows.length > 0
  }

  async deleteForSession(sessionKey: string): Promise<void> {
    await this.db.query('DELETE FROM session_reply_obligation WHERE sessionKey = ?', [sessionKey])
    await this.db.query('DELETE FROM session_reply_source WHERE sessionKey = ?', [sessionKey])
  }

  async deleteForAgent(agentId: string): Promise<void> {
    await this.db.query('DELETE FROM session_reply_obligation WHERE agentId = ?', [agentId])
    await this.db.query('DELETE FROM session_reply_source WHERE agentId = ?', [agentId])
  }
}
