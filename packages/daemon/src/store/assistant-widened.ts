// Sessions that read a private place through the asker's membership (assistant-mode.md §5.5); their writes stay in that DM until the session is retired.
import type { StoreQueryResult } from './store-database.js'

// A retired session's row stays, lifted, so its place still tells a later reader of that history to take the mark on.
export const ASSISTANT_WIDENED_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_widened_session (
        agentId TEXT NOT NULL,
        sessionKey TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        markedAt INTEGER NOT NULL,
        liftedAt INTEGER,
        PRIMARY KEY (agentId, sessionKey)
      );
      CREATE INDEX IF NOT EXISTS assistant_widened_session_by_place
        ON assistant_widened_session (agentId, platform, channel);
`

export interface AssistantWidenedDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

export class AssistantWidenedSessions {
  constructor(private readonly db: AssistantWidenedDatabase) {}

  /** Mark a session in its place; marking a lifted one again restores it. */
  async mark(
    agentId: string,
    sessionKey: string,
    place: { platform: string; channel: string },
    at: number
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_widened_session (agentId, sessionKey, platform, channel, markedAt, liftedAt)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (agentId, sessionKey) DO UPDATE SET liftedAt = NULL`,
      [agentId, sessionKey, place.platform, place.channel, at]
    )
  }

  /** Whether the session carries the mark now. */
  async has(agentId: string, sessionKey: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 AS hit FROM assistant_widened_session WHERE agentId = ? AND sessionKey = ? AND liftedAt IS NULL',
      [agentId, sessionKey]
    )
    return rows.length > 0
  }

  /** Whether any session of the agent in this place was ever marked, retired ones included. */
  async placeMarked(agentId: string, platform: string, channel: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 AS hit FROM assistant_widened_session WHERE agentId = ? AND platform = ? AND channel = ? LIMIT 1',
      [agentId, platform, channel]
    )
    return rows.length > 0
  }

  async deleteForAgent(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_widened_session WHERE agentId = ?', [agentId])).changes
  }
}
