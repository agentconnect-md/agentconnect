import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { SESSION_TITLE_TOOL_TITLES } from '../mcp/session-title-tool.js'
import {
  transcriptEventTimeUs,
  type TranscriptEntry,
  type TranscriptEventCursor,
  type TranscriptRow
} from './local-store.js'
import { readDataPlaneConfig, type DataPlaneConfig } from './postgres-config.js'
import { migrateDataPlaneSchema, quotePgIdentifier } from './postgres-migrations.js'

export interface TranscriptToolCall {
  channel: string
  thread: string
  ts: string
  sender: string
  toolCallId: string
  title: string
  body: string
}

export interface TranscriptReplicaSink {
  appendTranscript(entry: TranscriptEntry): void
  insertToolCall(entry: TranscriptToolCall): void
  updateToolCall(
    channel: string,
    thread: string,
    agentId: string,
    toolCallId: string,
    patch: { title: string; body: string }
  ): void
}

type PgTranscriptRow = QueryResultRow & {
  seq: string
  channel: string
  thread: string
  ts: string
  sender: string
  kind: TranscriptRow['kind']
  text: string
  tool_call_id: string | null
  body: string | null
  recipient: string | null
  event_time_us: string
  attachments_json: string | null
  quote_json: string | null
  trusted_agent_bot: boolean | null
  revision: string
  post_id: string | null
}

function safeInteger(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`PostgreSQL ${field} exceeds JavaScript's safe integer range`)
  return parsed
}

function transcriptRow(row: PgTranscriptRow): TranscriptRow {
  return {
    seq: safeInteger(row.seq, 'transcript.seq'),
    channel: row.channel,
    thread: row.thread,
    ts: row.ts,
    sender: row.sender,
    kind: row.kind,
    text: row.text,
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    body: row.body,
    ...(row.recipient ? { recipient: row.recipient } : {}),
    eventTimeUs: safeInteger(row.event_time_us, 'transcript.event_time_us'),
    attachmentsJson: row.attachments_json,
    quoteJson: row.quote_json,
    ...(row.trusted_agent_bot ? { trustedAgentBot: true } : {}),
    revision: safeInteger(row.revision, 'transcript.revision'),
    ...(row.post_id ? { postId: row.post_id } : {})
  }
}

export class PostgresTranscriptStore implements TranscriptReplicaSink {
  private tail: Promise<void> = Promise.resolve()
  private failure?: Error

  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
    private readonly onFailure: (error: Error) => void = () => undefined
  ) {}

  private enqueue(operation: () => Promise<void>): void {
    if (this.failure) throw this.failure
    this.tail = this.tail.then(operation).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.onFailure(this.failure)
      throw this.failure
    })
    void this.tail.catch(() => undefined)
  }

  appendTranscript(entry: TranscriptEntry): void {
    this.enqueue(() => this.writeTranscript(entry))
  }

  insertToolCall(entry: TranscriptToolCall): void {
    this.enqueue(() => this.writeToolCall(entry))
  }

  updateToolCall(
    channel: string,
    thread: string,
    agentId: string,
    toolCallId: string,
    patch: { title: string; body: string }
  ): void {
    this.enqueue(async () => {
      await this.withRevisionTransaction((client) =>
        client.query(
          `UPDATE transcript
           SET text = $1, body = $2, revision = nextval('transcript_revision_seq')
           WHERE channel = $3 AND thread = $4 AND sender = $5 AND tool_call_id = $6
             AND (text IS DISTINCT FROM $1 OR body IS DISTINCT FROM $2)`,
          [patch.title, patch.body, channel, thread, agentId, toolCallId]
        )
      )
    })
  }

  async flush(): Promise<void> {
    await this.tail
    if (this.failure) throw this.failure
  }

  private async withSchema<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(`SET search_path TO ${quotePgIdentifier(this.schema)}, pg_catalog`)
      return await operation(client)
    } finally {
      client.release()
    }
  }

  private async withRevisionTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withSchema(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('agentconnect-transcript-revision'))", [
          this.schema
        ])
        const result = await operation(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    })
  }

  private async writeTranscript(entry: TranscriptEntry): Promise<void> {
    const quoteJson = entry.quoted?.text ? JSON.stringify(entry.quoted) : (entry.quoteJson ?? null)
    const attachmentsJson = entry.attachments?.length ? JSON.stringify(entry.attachments) : null
    await this.withRevisionTransaction(async (client) => {
      const inserted = await client.query<{ inserted: boolean }>(
        `INSERT INTO transcript
             (channel, thread, ts, sender, kind, text, recipient, event_time_us,
              attachments_json, quote_json, trusted_agent_bot, post_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (channel, thread, ts) WHERE kind = 'text' DO NOTHING
           RETURNING true AS inserted`,
        [
          entry.channel,
          entry.thread,
          entry.ts,
          entry.sender,
          entry.kind,
          entry.text,
          entry.recipient ?? null,
          entry.eventTimeUs ?? transcriptEventTimeUs(entry.ts),
          attachmentsJson,
          quoteJson,
          entry.trustedAgentBot || null,
          entry.postId ?? null
        ]
      )
      if (inserted.rowCount === 0 && entry.kind === 'text') {
        await client.query(
          `UPDATE transcript SET
               text = CASE WHEN $1 THEN $2 ELSE text END,
               event_time_us = CASE WHEN $3::bigint IS NOT NULL THEN $3 ELSE event_time_us END,
               attachments_json = COALESCE(attachments_json, $4),
               quote_json = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE quote_json END,
               trusted_agent_bot = CASE WHEN $6 THEN true ELSE trusted_agent_bot END,
               post_id = COALESCE(post_id, $7),
               revision = nextval('transcript_revision_seq')
             WHERE channel = $8 AND thread = $9 AND ts = $10 AND kind = 'text'
               AND (($1 AND text IS DISTINCT FROM $2)
                 OR ($3::bigint IS NOT NULL AND event_time_us IS DISTINCT FROM $3)
                 OR (attachments_json IS NULL AND $4::text IS NOT NULL)
                 OR ($5::text IS NOT NULL AND quote_json IS DISTINCT FROM $5)
                 OR ($6 AND trusted_agent_bot IS DISTINCT FROM true)
                 OR (post_id IS NULL AND $7::text IS NOT NULL))`,
          [
            entry.authoritative === true,
            entry.text,
            entry.eventTimeUs ?? null,
            attachmentsJson,
            quoteJson,
            entry.trustedAgentBot === true,
            entry.postId ?? null,
            entry.channel,
            entry.thread,
            entry.ts
          ]
        )
      }
      if (entry.recipient && entry.ts) {
        const delivered = await client.query(
          `INSERT INTO transcript_recipient (channel, thread, ts, agent_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING agent_id`,
          [entry.channel, entry.thread, entry.ts, entry.recipient]
        )
        if (inserted.rowCount === 0 && delivered.rowCount === 1) {
          await client.query(
            `UPDATE transcript SET revision = nextval('transcript_revision_seq')
               WHERE channel = $1 AND thread = $2 AND ts = $3 AND kind = 'text'`,
            [entry.channel, entry.thread, entry.ts]
          )
        }
      }
    })
  }

  private async writeToolCall(entry: TranscriptToolCall): Promise<void> {
    await this.withRevisionTransaction(async (client) => {
      await client.query(
        `INSERT INTO transcript
           (channel, thread, ts, sender, kind, text, tool_call_id, body, event_time_us)
         VALUES ($1,$2,$3,$4,'tool',$5,$6,$7,$8)
         ON CONFLICT (channel, thread, sender, tool_call_id) WHERE tool_call_id IS NOT NULL DO NOTHING`,
        [
          entry.channel,
          entry.thread,
          entry.ts,
          entry.sender,
          entry.title,
          entry.toolCallId,
          entry.body,
          transcriptEventTimeUs(entry.ts)
        ]
      )
    })
  }

  private scopeSql(): string {
    return `(sender = $3 OR recipient = $3 OR (transcript.kind = 'text' AND EXISTS (
      SELECT 1 FROM transcript_recipient tr
      WHERE tr.channel = transcript.channel AND tr.thread = transcript.thread
        AND tr.ts = transcript.ts AND tr.agent_id = $3)))`
  }

  async transcriptPageForAgent(
    channel: string,
    thread: string,
    agentId: string,
    beforeSeq: number | null,
    limit: number
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean; cursor: number }> {
    await this.flush()
    const hidden = [...SESSION_TITLE_TOOL_TITLES]
    const values: unknown[] = [channel, thread, agentId, ...hidden]
    const before = beforeSeq === null ? '' : `AND seq < $${values.push(beforeSeq)}`
    const limitParam = `$${values.push(limit + 1)}`
    const page = await this.snapshotPage(
      `SELECT * FROM transcript WHERE channel = $1 AND thread = $2 ${before}
         AND ${this.scopeSql()} AND NOT (kind = 'tool' AND text IN ($4,$5))
       ORDER BY seq DESC LIMIT ${limitParam}`,
      values,
      limit
    )
    return { rows: page.rows, hasMore: page.hasMore, cursor: page.watermark }
  }

  async transcriptPageForAgentByEventTime(
    channel: string,
    thread: string,
    agentId: string,
    before: TranscriptEventCursor | null,
    limit: number
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean; cursor: number }> {
    await this.flush()
    const hidden = [...SESSION_TITLE_TOOL_TITLES]
    const values: unknown[] = [channel, thread, agentId, ...hidden]
    const cursor =
      before === null
        ? ''
        : `AND (event_time_us < $${values.push(before.eventTimeUs)} OR (event_time_us = $${values.push(before.eventTimeUs)} AND seq < $${values.push(before.seq)}))`
    const limitParam = `$${values.push(limit + 1)}`
    const page = await this.snapshotPage(
      `SELECT * FROM transcript WHERE channel = $1 AND thread = $2 ${cursor}
         AND ${this.scopeSql()} AND NOT (kind = 'tool' AND text IN ($4,$5))
       ORDER BY event_time_us DESC, seq DESC LIMIT ${limitParam}`,
      values,
      limit
    )
    return { rows: page.rows, hasMore: page.hasMore, cursor: page.watermark }
  }

  async transcriptTailForAgent(
    channel: string,
    thread: string,
    agentId: string,
    afterRevision: number,
    limit: number
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean; cursor: number }> {
    await this.flush()
    const hidden = [...SESSION_TITLE_TOOL_TITLES]
    const result = await this.snapshotPage(
      `SELECT * FROM transcript WHERE channel = $1 AND thread = $2 AND revision > $6
         AND ${this.scopeSql()} AND NOT (kind = 'tool' AND text IN ($4,$5))
       ORDER BY revision ASC LIMIT $7`,
      [channel, thread, agentId, ...hidden, afterRevision, limit + 1],
      limit
    )
    return {
      rows: result.rows,
      hasMore: result.hasMore,
      cursor: result.hasMore ? (result.rows.at(-1)?.revision ?? afterRevision) : result.watermark
    }
  }

  async currentTranscriptRevision(): Promise<number> {
    await this.flush()
    return this.withSchema(async (client) => {
      const result = await client.query<{ revision: string }>(
        'SELECT COALESCE(MAX(revision), 0)::text AS revision FROM transcript'
      )
      return safeInteger(result.rows[0]?.revision ?? '0', 'transcript.revision')
    })
  }

  async getToolBodyForAgent(
    channel: string,
    thread: string,
    agentId: string,
    toolCallId: string
  ): Promise<string | undefined> {
    await this.flush()
    return this.withSchema(async (client) => {
      const result = await client.query<{ body: string | null }>(
        `SELECT body FROM transcript
         WHERE channel = $1 AND thread = $2 AND sender = $3 AND tool_call_id = $4`,
        [channel, thread, agentId, toolCallId]
      )
      return result.rows[0]?.body ?? undefined
    })
  }

  private async snapshotPage(
    sql: string,
    values: unknown[],
    limit: number
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean; watermark: number }> {
    return this.withSchema(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const result = await client.query<PgTranscriptRow>(sql, values)
        const revision = await client.query<{ watermark: string }>(
          'SELECT COALESCE(MAX(revision), 0)::text AS watermark FROM transcript'
        )
        await client.query('COMMIT')
        const rows = result.rows.map(transcriptRow)
        const hasMore = rows.length > limit
        return {
          rows: hasMore ? rows.slice(0, limit) : rows,
          hasMore,
          watermark: safeInteger(revision.rows[0]?.watermark ?? '0', 'transcript.revision')
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    })
  }
}

export class PostgresDataPlane {
  readonly transcripts: PostgresTranscriptStore
  /** The org this daemon runs for, as the mount named it — what a cloud daemon's control
   *  socket declares, since its Kubernetes identity names no org. */
  readonly orgId?: string

  private constructor(
    private readonly pool: Pool,
    config: DataPlaneConfig,
    onFailure?: (error: Error) => void
  ) {
    this.transcripts = new PostgresTranscriptStore(pool, config.schema, onFailure)
    if (config.orgId) this.orgId = config.orgId
  }

  static async open(config: DataPlaneConfig, onFailure?: (error: Error) => void): Promise<PostgresDataPlane> {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.maxConnections,
      application_name: 'agentconnect-daemon',
      connectionTimeoutMillis: 10_000
    })
    pool.on('error', (error) => onFailure?.(error))
    try {
      const client = await pool.connect()
      try {
        await migrateDataPlaneSchema(client, config.schema)
      } finally {
        client.release()
      }
    } catch (error) {
      await pool.end().catch(() => undefined)
      throw error
    }
    return new PostgresDataPlane(pool, config, onFailure)
  }

  async close(): Promise<void> {
    await this.transcripts.flush()
    await this.pool.end()
  }
}

export async function openMountedPostgresDataPlane(onFailure?: (error: Error) => void): Promise<PostgresDataPlane> {
  return PostgresDataPlane.open(readDataPlaneConfig(), onFailure)
}
