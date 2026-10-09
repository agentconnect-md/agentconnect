// Sessions that read a private place through the asker's membership (assistant-mode.md §5.5); their writes stay in that DM until the session is retired.
import type { StoreQueryResult } from './store-database.js'

export const ASSISTANT_WIDENED_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_widened_session (
        agentId TEXT NOT NULL,
        sessionKey TEXT NOT NULL,
        markedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, sessionKey)
      );
`

export interface AssistantWidenedDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

export class AssistantWidenedSessions {
  constructor(private readonly db: AssistantWidenedDatabase) {}

  /** Mark a session; marking it again keeps the first time. */
  async mark(agentId: string, sessionKey: string, at: number): Promise<void> {
    await this.db.query(
      'INSERT OR IGNORE INTO assistant_widened_session (agentId, sessionKey, markedAt) VALUES (?, ?, ?)',
      [agentId, sessionKey, at]
    )
  }

  async has(agentId: string, sessionKey: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 AS hit FROM assistant_widened_session WHERE agentId = ? AND sessionKey = ?',
      [agentId, sessionKey]
    )
    return rows.length > 0
  }

  async deleteForAgent(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_widened_session WHERE agentId = ?', [agentId])).changes
  }
}
