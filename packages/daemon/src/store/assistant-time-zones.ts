// The time zone last seen from a person in each assistant-mode place (assistant-mode.md §5.4), for turns no person started.
import type { AssistantPlace } from './assistant-items.js'
import type { StoreQueryResult } from './store-database.js'

export const ASSISTANT_TIME_ZONE_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_place_time_zone (
        agentId TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        transportScope TEXT NOT NULL DEFAULT '',
        timeZone TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, platform, channel, transportScope)
      );
`

export interface AssistantTimeZoneDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

export class AssistantPlaceTimeZones {
  constructor(private readonly db: AssistantTimeZoneDatabase) {}

  /** Record the zone a person in the place just reported; the latest one wins. */
  async note(agentId: string, place: AssistantPlace, timeZone: string, at: number): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_place_time_zone (agentId, platform, channel, transportScope, timeZone, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (agentId, platform, channel, transportScope)
       DO UPDATE SET timeZone = excluded.timeZone, updatedAt = excluded.updatedAt`,
      [agentId, place.platform, place.channel, place.transportScope ?? '', timeZone, at]
    )
  }

  /** The zone last seen in the place, or undefined when no person there reported one. */
  async get(agentId: string, place: AssistantPlace): Promise<string | undefined> {
    const { rows } = await this.db.query(
      `SELECT timeZone FROM assistant_place_time_zone
       WHERE agentId = ? AND platform = ? AND channel = ? AND transportScope = ?`,
      [agentId, place.platform, place.channel, place.transportScope ?? '']
    )
    const zone = (rows[0] as { timeZone?: unknown } | undefined)?.timeZone
    return typeof zone === 'string' ? zone : undefined
  }

  async deleteForAgent(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_place_time_zone WHERE agentId = ?', [agentId])).changes
  }
}
