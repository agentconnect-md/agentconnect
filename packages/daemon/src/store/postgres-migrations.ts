import type { PoolClient } from 'pg'

export const DATA_PLANE_SCHEMA = 'agentconnect_data_plane'

const MIGRATIONS: readonly string[] = [
  `
    CREATE SEQUENCE transcript_revision_seq;

    CREATE TABLE transcript (
      seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      org_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread TEXT NOT NULL,
      ts TEXT,
      sender TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'tool', 'reasoning')),
      text TEXT NOT NULL,
      tool_call_id TEXT,
      body TEXT,
      recipient TEXT,
      event_time_us BIGINT NOT NULL DEFAULT 0,
      attachments_json TEXT,
      quote_json TEXT,
      trusted_agent_bot BOOLEAN,
      revision BIGINT NOT NULL DEFAULT nextval('transcript_revision_seq'),
      post_id TEXT
    );
    CREATE INDEX transcript_thread_seq ON transcript (org_id, channel, thread, seq);
    CREATE UNIQUE INDEX transcript_text_ts ON transcript (org_id, channel, thread, ts) WHERE kind = 'text';
    CREATE UNIQUE INDEX transcript_agent_tool_call
      ON transcript (org_id, channel, thread, sender, tool_call_id) WHERE tool_call_id IS NOT NULL;
    CREATE INDEX transcript_thread_event_time
      ON transcript (org_id, channel, thread, event_time_us DESC, seq DESC);
    CREATE INDEX transcript_thread_revision ON transcript (org_id, channel, thread, revision);

    CREATE TABLE transcript_recipient (
      org_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread TEXT NOT NULL,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (org_id, channel, thread, ts, agent_id)
    );
  `,
  // #1041 item 7: this pair was constructed and never read or written — every transcript
  // went to the pool store's own `transcript`/`transcript_recipient`, which now carry the
  // org fence themselves. One store carries it, so this one gives its tables back.
  `
    DROP TABLE IF EXISTS transcript_recipient;
    DROP TABLE IF EXISTS transcript;
    DROP SEQUENCE IF EXISTS transcript_revision_seq;
  `
]

export const DATA_PLANE_SCHEMA_VERSION = MIGRATIONS.length

/** Upgrade the install-wide data-plane schema under a cross-daemon advisory lock. */
export async function migrateDataPlaneSchema(client: PoolClient): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('agentconnect-data-plane-migration'))")
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${DATA_PLANE_SCHEMA}`)
    await client.query(`SET LOCAL search_path TO ${DATA_PLANE_SCHEMA}, pg_catalog`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _agentconnect_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    const result = await client.query<{ version: number }>(
      'SELECT version FROM _agentconnect_schema_migrations ORDER BY version'
    )
    const applied = new Set(result.rows.map((row) => Number(row.version)))
    const newest = Math.max(0, ...applied)
    if (newest > DATA_PLANE_SCHEMA_VERSION) {
      throw new Error(
        `data-plane schema is version ${newest}, newer than supported version ${DATA_PLANE_SCHEMA_VERSION}`
      )
    }
    for (let version = 1; version <= newest; version += 1) {
      if (!applied.has(version)) throw new Error(`data-plane schema has a migration gap before version ${newest}`)
    }
    let expected = newest + 1
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const version = index + 1
      if (applied.has(version)) continue
      if (version !== expected) throw new Error('data-plane schema has a migration gap')
      await client.query(MIGRATIONS[index]!)
      await client.query('INSERT INTO _agentconnect_schema_migrations (version) VALUES ($1)', [version])
      expected += 1
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}
