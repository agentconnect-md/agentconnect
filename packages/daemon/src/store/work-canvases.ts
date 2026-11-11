// Each channel's Work page and the latest anchor of each targeted cron (assistant-mode.md §5.19).
import type { StoreQueryResult } from './store-database.js'

/** A conversation as the store keys it: one platform conversation under one physical bot. */
export interface WorkCanvasPlace {
  platform: string
  channel: string
  transportScope?: string | null
}

/** `live`: on the platform; `skipped`: the platform keeps none there; `failed`: the last write failed; `deleted`: a person removed it. */
export type WorkCanvasState = 'live' | 'skipped' | 'failed' | 'deleted'

export interface WorkCanvasRow extends WorkCanvasPlace {
  agentId: string
  state: WorkCanvasState
  canvasId?: string
  bookmarkId?: string
  /** The digest of the page last settled, so an unchanged page is not written again. */
  digest: string
  updatedAt: number
}

/** The thread a cron's latest run anchored in its target conversation. */
export interface WorkCanvasAnchor {
  cronId: string
  channel: string
  thread: string
  firedAt: number
}

export const WORK_CANVAS_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_work_canvas (
        agentId TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        transportScope TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        canvasId TEXT,
        bookmarkId TEXT,
        digest TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, platform, channel, transportScope)
      );
      CREATE TABLE IF NOT EXISTS assistant_cron_anchor (
        agentId TEXT NOT NULL,
        cronId TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        firedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, cronId)
      );
`

export interface WorkCanvasDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

type Row = Record<string, unknown>

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function rowOf(row: Row): WorkCanvasRow {
  const canvasId = text(row.canvasId)
  const bookmarkId = text(row.bookmarkId)
  return {
    agentId: String(row.agentId),
    platform: String(row.platform),
    channel: String(row.channel),
    transportScope: text(row.transportScope) ?? null,
    state: String(row.state) as WorkCanvasState,
    ...(canvasId ? { canvasId } : {}),
    ...(bookmarkId ? { bookmarkId } : {}),
    digest: String(row.digest),
    updatedAt: Number(row.updatedAt)
  }
}

export class WorkCanvases {
  constructor(private readonly db: WorkCanvasDatabase) {}

  async list(agentId: string): Promise<WorkCanvasRow[]> {
    const { rows } = await this.db.query('SELECT * FROM assistant_work_canvas WHERE agentId = ?', [agentId])
    return (rows as Row[]).map(rowOf)
  }

  /** Record how a page settled; the latest write wins. */
  async put(row: WorkCanvasRow): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_work_canvas (agentId, platform, channel, transportScope, state, canvasId, bookmarkId, digest, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agentId, platform, channel, transportScope)
       DO UPDATE SET state = excluded.state, canvasId = excluded.canvasId, bookmarkId = excluded.bookmarkId,
         digest = excluded.digest, updatedAt = excluded.updatedAt`,
      [
        row.agentId,
        row.platform,
        row.channel,
        row.transportScope ?? '',
        row.state,
        row.canvasId ?? null,
        row.bookmarkId ?? null,
        row.digest,
        row.updatedAt
      ]
    )
  }

  async remove(agentId: string, place: WorkCanvasPlace): Promise<void> {
    await this.db.query(
      'DELETE FROM assistant_work_canvas WHERE agentId = ? AND platform = ? AND channel = ? AND transportScope = ?',
      [agentId, place.platform, place.channel, place.transportScope ?? '']
    )
  }

  /** Remember the thread a cron's run just anchored; a later run replaces it. */
  async noteAnchor(agentId: string, anchor: WorkCanvasAnchor): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_cron_anchor (agentId, cronId, channel, thread, firedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (agentId, cronId)
       DO UPDATE SET channel = excluded.channel, thread = excluded.thread, firedAt = excluded.firedAt`,
      [agentId, anchor.cronId, anchor.channel, anchor.thread, anchor.firedAt]
    )
  }

  async anchors(agentId: string): Promise<WorkCanvasAnchor[]> {
    const { rows } = await this.db.query('SELECT * FROM assistant_cron_anchor WHERE agentId = ?', [agentId])
    return (rows as Row[]).map((row) => ({
      cronId: String(row.cronId),
      channel: String(row.channel),
      thread: String(row.thread),
      firedAt: Number(row.firedAt)
    }))
  }

  async deleteForAgent(agentId: string): Promise<number> {
    const pages = await this.db.query('DELETE FROM assistant_work_canvas WHERE agentId = ?', [agentId])
    const anchors = await this.db.query('DELETE FROM assistant_cron_anchor WHERE agentId = ?', [agentId])
    return pages.changes + anchors.changes
  }
}
