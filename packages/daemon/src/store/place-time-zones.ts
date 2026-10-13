// The time zone last seen from a person in each place, for every agent (product-conventions.md "Local time"); the table keeps its first name.
import type { SessionRecord } from './local-store.js'
import type { StoreQueryResult } from './store-database.js'

/** A conversation as the store keys it: one platform conversation under one physical bot. */
export type TimeZonePlace = Pick<SessionRecord, 'platform' | 'channel' | 'transportScope'>

export const PLACE_TIME_ZONE_SCHEMA = `
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

export interface PlaceTimeZoneDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

export class PlaceTimeZones {
  constructor(private readonly db: PlaceTimeZoneDatabase) {}

  /** Record the zone a person in the place just reported; the latest one wins. */
  async note(agentId: string, place: TimeZonePlace, timeZone: string, at: number): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_place_time_zone (agentId, platform, channel, transportScope, timeZone, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (agentId, platform, channel, transportScope)
       DO UPDATE SET timeZone = excluded.timeZone, updatedAt = excluded.updatedAt`,
      [agentId, place.platform, place.channel, place.transportScope ?? '', timeZone, at]
    )
  }

  /** The zone last seen in the place, or undefined when no person there reported one. */
  async get(agentId: string, place: TimeZonePlace): Promise<string | undefined> {
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
